// Auto-split from src/index.js (candidate 3). Tool definitions for the
// core group — bodies moved verbatim; see src/tool-registry.ts for the
// authoritative group membership. Infrastructure (connection pool, config
// loading, policy gate) arrives via the ctx argument at registration time.

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import SSHManager from '../ssh-manager.ts';
import {
  getTempFilename,
  buildDeploymentStrategy,
  detectDeploymentNeeds,
} from '../deploy-helper.ts';
import { resolveServerName, addAlias, removeAlias, listAliases } from '../server-aliases.ts';
import {
  expandCommandAlias,
  addCommandAlias,
  removeCommandAlias,
  listCommandAliases,
  suggestAliases,
} from '../command-aliases.ts';
import { TIMEOUTS, truncateOutput, formatJSONResponse, formatDuration } from '../config.ts';
import { initializeHooks, executeHook, toggleHook, listHooks } from '../hooks-system.ts';
import {
  loadProfile,
  listProfiles,
  setActiveProfile,
  getActiveProfileName,
} from '../profile-loader.ts';
import { logger } from '../logger.ts';
import { shSingleQuote, buildCdPrefix, buildSudoPipeline } from '../shell-quote.ts';
import { parseRsyncStats } from '../rsync-stats.ts';
import { toRsyncLocalPath } from '../rsync-path.ts';
import { createSession, getSession, listSessions, closeSession } from '../session-manager.ts';
import {
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addServersToGroup,
  removeServersFromGroup,
  listGroups,
  executeOnGroup,
} from '../server-groups.ts';
import { createTunnel, listTunnels, closeTunnel, closeServerTunnels } from '../tunnel-manager.ts';
import {
  getHostKeyFingerprint,
  isHostKnown,
  getCurrentHostKey,
  removeHostKey,
  addHostKey,
  updateHostKey,
  hasHostKeyChanged,
  listKnownHosts,
  detectSSHKeyError,
  extractHostFromSSHError,
} from '../ssh-key-manager.ts';
import {
  BACKUP_TYPES,
  DEFAULT_BACKUP_DIR,
  generateBackupId,
  getBackupMetadataPath,
  getBackupFilePath,
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
  buildFilesBackupCommand,
  buildRestoreCommand,
  createBackupMetadata,
  buildSaveMetadataCommand,
  buildListBackupsCommand,
  parseBackupsList,
  buildCleanupCommand,
  buildCronScheduleCommand,
} from '../backup-manager.ts';
import {
  HEALTH_STATUS,
  buildServiceStatusCommand,
  parseServiceStatus,
  buildProcessListCommand,
  parseProcessList,
  buildKillProcessCommand,
  buildProcessInfoCommand,
  createAlertConfig,
  buildSaveAlertConfigCommand,
  buildLoadAlertConfigCommand,
  checkAlertThresholds,
  buildComprehensiveHealthCheckCommand,
  parseComprehensiveHealthCheck,
  resolveServiceName,
} from '../health-monitor.ts';
import {
  DB_TYPES,
  buildMySQLDumpCommand as buildDBMySQLDumpCommand,
  buildPostgreSQLDumpCommand as buildDBPostgreSQLDumpCommand,
  buildMongoDBDumpCommand as buildDBMongoDBDumpCommand,
  buildMySQLImportCommand,
  buildPostgreSQLImportCommand,
  buildMongoDBRestoreCommand,
  buildMySQLListDatabasesCommand,
  buildMySQLListTablesCommand,
  buildPostgreSQLListDatabasesCommand,
  buildPostgreSQLListTablesCommand,
  buildMongoDBListDatabasesCommand,
  buildMongoDBListCollectionsCommand,
  buildMySQLQueryCommand,
  buildPostgreSQLQueryCommand,
  buildMongoDBQueryCommand,
  isSafeQuery,
  countQueryRows,
  parseDatabaseList,
  parseTableList,
  parseSize,
  formatBytes,
} from '../database-manager.ts';

export function registerCoreTools(ctx: import('../tool-registry.ts').ToolContext) {
  const {
    register: registerToolConditional,
    getConnection,
    execCommandWithTimeout,
    loadServerConfig,
    resolveServer,
    applyServerPolicy,
    auditOk,
  } = ctx;

  registerToolConditional(
    'ssh_execute',
    {
      description:
        'Runs a shell command over SSH on a named configured server and returns stdout, stderr, and exit code. Mutates remote state depending on the command; not read-only. Expands command aliases before running. Uses the cwd parameter or, if omitted, the server configured default directory; adapts syntax for Linux versus Windows PowerShell targets. Timeout defaults to 120000 ms and is capped at 300000 ms. Under readonly mode destructive commands like rm or dd are refused; under restricted mode the command must match allow patterns. Output is truncated when very large.',
      inputSchema: {
        server: z.string().describe('Server name from configuration'),
        command: z.string().describe('Command to execute'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory (optional, uses default if configured)'),
        timeout: z
          .number()
          .optional()
          .describe('Command timeout in milliseconds (default: 120000, max: 300000)'),
      },
    },
    async ({ server: serverName, command, cwd, timeout = TIMEOUTS.DEFAULT_COMMAND_TIMEOUT }) => {
      // Cap timeout at maximum allowed
      const cappedTimeout = Math.min(timeout, TIMEOUTS.MAX_COMMAND_TIMEOUT);

      // Expand aliases BEFORE policy evaluation so the user can't bypass a DENY
      // regex by hiding a destructive command behind an alias.
      const expandedCommand = expandCommandAlias(command);

      const denied = await applyServerPolicy(
        serverName,
        'ssh_execute',
        { command, cwd },
        expandedCommand
      );
      if (denied) return denied;

      try {
        const ssh = await getConnection(serverName);

        // Execute hooks for bench commands
        if (expandedCommand.includes('bench update')) {
          await executeHook('pre-bench-update', {
            server: serverName,
            sshConnection: ssh,
            defaultDir: cwd,
          });
        }

        // Use provided cwd, or the server's configured defaultDir, or no cwd.
        // resolveServer expands aliases — a bare servers[name] lookup would
        // lose defaultDir/platform when the server is reached via alias.
        const resolved = await resolveServer(serverName);
        const serverConfig = resolved?.config;
        const workingDir = cwd || serverConfig?.defaultDir;
        const platform = serverConfig?.platform || 'linux';

        // Build cwd-prefixed command using platform-appropriate syntax
        const fullCommand = workingDir
          ? buildCdPrefix(workingDir, platform) + expandedCommand
          : expandedCommand;

        // Log command execution
        const startTime = logger.logCommand(serverName, fullCommand, workingDir);

        const result = await execCommandWithTimeout(ssh, fullCommand, { platform }, cappedTimeout);

        // Log command result
        logger.logCommandResult(serverName, fullCommand, startTime, result);

        // Execute post-hooks for bench commands
        if (expandedCommand.includes('bench update') && result.code === 0) {
          await executeHook('post-bench-update', {
            server: serverName,
            sshConnection: ssh,
            defaultDir: cwd,
          });
        }

        // Truncate output if too large to prevent Claude Code crashes
        const stdout = truncateOutput(result.stdout);
        const stderr = truncateOutput(result.stderr);

        await auditOk(
          serverName,
          'ssh_execute',
          { command, cwd },
          {
            code: result.code,
            success: result.code === 0,
          }
        );

        return {
          content: [
            {
              type: 'text',
              text: formatJSONResponse({
                server: serverName,
                command: fullCommand,
                stdout: stdout,
                stderr: stderr,
                code: result.code,
                success: result.code === 0,
              }),
            },
          ],
        };
      } catch (error) {
        await auditOk(
          serverName,
          'ssh_execute',
          { command, cwd },
          {
            success: false,
            error: error.message,
          }
        );
        logger.error('ssh_execute failed', {
          server: serverName,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: formatJSONResponse({
                server: serverName,
                success: false,
                error: truncateOutput(error.message, 1000),
                code: -1,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  registerToolConditional(
    'ssh_upload',
    {
      description:
        'Uploads one local file to a remote destination path over SFTP on the named server, overwriting any existing remote file at that path. Mutates remote state and is not idempotent beyond replacing the target. Creates no backup. Requires the local file to exist. Does not use sudo, so the remote path must be writable by the configured SSH user. This tool is blocked entirely on servers set to readonly or restricted security mode. For directory trees use ssh_sync instead.',
      inputSchema: {
        server: z.string().describe('Server name'),
        localPath: z.string().describe('Local file path'),
        remotePath: z.string().describe('Remote destination path'),
      },
    },
    async ({ server: serverName, localPath, remotePath }) => {
      const denied = await applyServerPolicy(serverName, 'ssh_upload', { localPath, remotePath });
      if (denied) return denied;

      try {
        const ssh = await getConnection(serverName);

        logger.logTransfer('upload', serverName, localPath, remotePath);
        const startTime = Date.now();

        await ssh.putFile(localPath, remotePath);

        const fileStats = fs.statSync(localPath);
        logger.logTransfer('upload', serverName, localPath, remotePath, {
          success: true,
          size: fileStats.size,
          duration: `${Date.now() - startTime}ms`,
        });

        await auditOk(serverName, 'ssh_upload', { localPath, remotePath }, { success: true });

        return {
          content: [
            {
              type: 'text',
              text: `✅ File uploaded successfully\nServer: ${serverName}\nLocal: ${localPath}\nRemote: ${remotePath}`,
            },
          ],
        };
      } catch (error) {
        await auditOk(
          serverName,
          'ssh_upload',
          { localPath, remotePath },
          {
            success: false,
            error: error.message,
          }
        );
        logger.logTransfer('upload', serverName, localPath, remotePath, {
          success: false,
          error: error.message,
        });
        return {
          content: [
            {
              type: 'text',
              text: `❌ Upload error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_download',
    {
      description:
        'Downloads one remote file from the named server to a local destination path over SFTP, overwriting any existing local file at that path. Affects only the local filesystem and is read-only on the remote side, so it stays allowed even on servers in readonly or restricted security mode. Reads the remote file using the configured SSH user, which must have permission to read it. Handles single files only; use ssh_sync for directories.',
      inputSchema: {
        server: z.string().describe('Server name'),
        remotePath: z.string().describe('Remote file path'),
        localPath: z.string().describe('Local destination path'),
      },
    },
    async ({ server: serverName, remotePath, localPath }) => {
      try {
        const ssh = await getConnection(serverName);

        logger.logTransfer('download', serverName, remotePath, localPath);
        const startTime = Date.now();

        await ssh.getFile(localPath, remotePath);

        const fileStats = fs.statSync(localPath);
        logger.logTransfer('download', serverName, remotePath, localPath, {
          success: true,
          size: fileStats.size,
          duration: `${Date.now() - startTime}ms`,
        });

        return {
          content: [
            {
              type: 'text',
              text: `✅ File downloaded successfully\nServer: ${serverName}\nRemote: ${remotePath}\nLocal: ${localPath}`,
            },
          ],
        };
      } catch (error) {
        logger.logTransfer('download', serverName, remotePath, localPath, {
          success: false,
          error: error.message,
        });
        return {
          content: [
            {
              type: 'text',
              text: `❌ Download error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_sync',
    {
      description:
        'Synchronizes files or directories between local and remote using rsync over SSH on the named server. Each of source and destination must carry a local: or remote: prefix and one side must be local and the other remote; with no prefix it assumes a push from local to remote. On Windows MCP hosts, provide native Windows local paths such as C:\\project or .\\project; the tool converts drive-letter and UNC paths to MSYS2 format before spawning rsync. Do not pre-convert a local path to /c/project because Node performs local filesystem checks using Windows path semantics. Mutates the destination. Setting delete true removes destination files absent from source, which is destructive; dryRun true previews without changing anything. Compression is on by default. Password authentication requires sshpass installed locally. Blocked on readonly or restricted servers. Timeout defaults to 30000 ms.',
      inputSchema: {
        server: z.string().describe('Server name from configuration'),
        source: z
          .string()
          .describe(
            'Source path with a "local:" or "remote:" prefix. On Windows, use a native local path such as "local:C:\\project" or "local:.\\project"; do not pre-convert it to MSYS2 /c/... syntax.'
          ),
        destination: z
          .string()
          .describe(
            'Destination path with a "local:" or "remote:" prefix. On Windows, use a native local path such as "local:C:\\output" or "local:.\\output"; do not pre-convert it to MSYS2 /c/... syntax.'
          ),
        exclude: z.array(z.string()).optional().describe('Patterns to exclude from sync'),
        dryRun: z.boolean().optional().describe('Perform dry run without actual changes'),
        delete: z.boolean().optional().describe('Delete files in destination not in source'),
        compress: z.boolean().optional().describe('Compress during transfer'),
        verbose: z.boolean().optional().describe('Show detailed progress'),
        checksum: z
          .boolean()
          .optional()
          .describe('Use checksum instead of timestamp for comparison'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
      },
    },
    async ({
      server: serverName,
      source,
      destination,
      exclude = [],
      dryRun = false,
      delete: deleteFiles = false,
      compress = true,
      verbose = false,
      checksum = false,
      timeout = 30000,
    }) => {
      const denied = await applyServerPolicy(serverName, 'ssh_sync', {
        source,
        destination,
        dryRun,
        delete: deleteFiles,
      });
      if (denied) return denied;

      try {
        await getConnection(serverName);
        // resolveServer expands aliases so auth fields are found even when the
        // server is addressed by alias.
        const resolved = await resolveServer(serverName);
        const serverConfig = resolved?.config || {};

        // Check if sshpass is available for password authentication
        if (!serverConfig.keyPath && serverConfig.password) {
          // Check if sshpass is installed
          try {
            const { execSync } = await import('child_process');
            execSync('which sshpass', { stdio: 'ignore' });
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `❌ Error: ssh_sync with password authentication requires sshpass.\n\nThe server '${serverName}' uses password authentication.\nPlease install sshpass: brew install hudochenkov/sshpass/sshpass (macOS) or apt-get install sshpass (Linux)\n\nAlternatively, use ssh_upload or ssh_download for single file transfers.`,
                },
              ],
            };
          }
        }

        // Determine sync direction based on source/destination prefixes
        const isLocalSource = source.startsWith('local:');
        const isRemoteSource = source.startsWith('remote:');
        const isLocalDest = destination.startsWith('local:');
        const isRemoteDest = destination.startsWith('remote:');

        // Clean paths
        const cleanSource = source.replace(/^(local:|remote:)/, '');
        const cleanDest = destination.replace(/^(local:|remote:)/, '');

        // Validate direction
        if ((isLocalSource && isLocalDest) || (isRemoteSource && isRemoteDest)) {
          throw new Error(
            'Source and destination must be different (one local, one remote). Use prefixes: local: or remote:'
          );
        }

        // If no prefixes, assume old format (local source to remote dest)
        const direction = isLocalSource || (!isLocalSource && !isRemoteSource) ? 'push' : 'pull';

        // Build rsync command
        let rsyncOptions = ['-avz'];

        if (!compress) {
          rsyncOptions = ['-av'];
        }

        if (checksum) {
          rsyncOptions.push('--checksum');
        }

        if (deleteFiles) {
          rsyncOptions.push('--delete');
        }

        if (dryRun) {
          rsyncOptions.push('--dry-run');
        }

        // Always include --stats so we can parse transfer counts
        rsyncOptions.push('--stats');

        // Add exclude patterns
        exclude.forEach((pattern) => {
          rsyncOptions.push('--exclude', pattern);
        });

        let localPath;
        let remotePath;

        if (direction === 'push') {
          localPath = cleanSource;
          remotePath = cleanDest;

          // Check if local path exists
          if (!fs.existsSync(localPath)) {
            throw new Error(`Local path does not exist: ${localPath}`);
          }
        } else {
          localPath = cleanDest;
          remotePath = cleanSource;
        }

        // Native Windows paths must remain unchanged for fs.existsSync() and
        // logging, but MSYS2 rsync expects drive paths such as /c/project/file.
        const rsyncLocalPath = toRsyncLocalPath(localPath);

        // Add SSH options for non-interactive mode
        const sshOptions = [];

        // Different options based on authentication method
        if (serverConfig.keyPath) {
          sshOptions.push('-o BatchMode=yes'); // No password prompts
          sshOptions.push('-o StrictHostKeyChecking=accept-new'); // Accept new keys, reject changed ones
          sshOptions.push('-o ConnectTimeout=10'); // Connection timeout

          const keyPath = serverConfig.keyPath.replace('~', os.homedir());
          sshOptions.push(`-i ${keyPath}`);
        } else {
          // With sshpass, we don't use BatchMode
          sshOptions.push('-o StrictHostKeyChecking=accept-new'); // Accept new keys, reject changed ones
          sshOptions.push('-o ConnectTimeout=10');
        }

        // port is a number (ConfigLoader parseInt's it), so comparing against the
        // string '22' never matched and every server got an explicit -p 22.
        if (serverConfig.port && serverConfig.port !== 22) {
          sshOptions.push(`-p ${serverConfig.port}`);
        }

        logger.info(`Starting rsync ${direction}`, {
          server: serverName,
          source: direction === 'push' ? localPath : remotePath,
          destination: direction === 'push' ? remotePath : localPath,
          dryRun,
          deleteFiles,
        });

        const startTime = Date.now();

        // Execute rsync via spawn for non-blocking streaming
        const { spawn } = await import('child_process');

        return new Promise((resolve, reject) => {
          let output = '';
          let errorOutput = '';
          let killed = false;

          // Build command based on authentication method
          let rsyncCommand;
          let rsyncArgs = [];
          let processEnv = { ...process.env };

          if (serverConfig.password) {
            // Use sshpass for password authentication
            rsyncCommand = 'sshpass';
            rsyncArgs.push('-p', serverConfig.password);
            rsyncArgs.push('rsync');

            // Add rsync options
            rsyncOptions.forEach((opt) => rsyncArgs.push(opt));

            // Add SSH command
            const sshCmd = `ssh ${sshOptions.join(' ')}`;
            rsyncArgs.push('-e', sshCmd);
          } else {
            // Direct rsync for key authentication
            rsyncCommand = 'rsync';

            // Add rsync options
            rsyncOptions.forEach((opt) => rsyncArgs.push(opt));

            // Add SSH command with all options
            const sshCmd = `ssh ${sshOptions.join(' ')}`;
            rsyncArgs.push('-e', sshCmd);

            processEnv.SSH_ASKPASS = '/bin/false';
            processEnv.DISPLAY = '';
          }

          // Add source and destination
          if (direction === 'push') {
            rsyncArgs.push(rsyncLocalPath);
            rsyncArgs.push(`${serverConfig.user}@${serverConfig.host}:${remotePath}`);
          } else {
            rsyncArgs.push(`${serverConfig.user}@${serverConfig.host}:${remotePath}`);
            rsyncArgs.push(rsyncLocalPath);
          }

          const rsyncProcess = spawn(rsyncCommand, rsyncArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: processEnv,
          });

          // Set timeout
          const timer = setTimeout(() => {
            killed = true;
            rsyncProcess.kill('SIGTERM');
            reject(new Error(`Rsync timeout after ${timeout}ms`));
          }, timeout);

          // Collect output with size limit
          rsyncProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
            // Limit output size to prevent memory issues
            if (output.length > 100000) {
              output = output.slice(-50000);
            }
          });

          rsyncProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            errorOutput += chunk;
            if (errorOutput.length > 50000) {
              errorOutput = errorOutput.slice(-25000);
            }
          });

          rsyncProcess.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Failed to start rsync: ${err.message}`));
          });

          rsyncProcess.on('close', (code) => {
            clearTimeout(timer);

            if (killed) {
              return; // Already rejected due to timeout
            }

            const duration = Date.now() - startTime;

            if (code !== 0) {
              logger.error(`Rsync ${direction} failed`, {
                server: serverName,
                exitCode: code,
                error: errorOutput,
                duration: `${duration}ms`,
              });

              // Check if it's an SSH key error
              if (detectSSHKeyError(errorOutput)) {
                const hostInfo = extractHostFromSSHError(errorOutput);
                let errorMsg = `SSH host key verification failed for ${serverName}.\n`;

                if (hostInfo) {
                  errorMsg += `Host: ${hostInfo.host}:${hostInfo.port}\n`;
                }

                errorMsg += '\n📍 To fix this issue:\n';
                errorMsg += '1. Verify the server identity\n';
                errorMsg += "2. Use 'ssh_key_manage' tool with action 'verify' to check the key\n";
                errorMsg +=
                  "3. Use 'ssh_key_manage' tool with action 'accept' to update the key if you trust the server\n";
                errorMsg += `\nOriginal error:\n${errorOutput}`;

                reject(new Error(errorMsg));
              } else {
                reject(
                  new Error(
                    `Rsync failed with exit code ${code}: ${errorOutput || 'Unknown error'}`
                  )
                );
              }
              return;
            }

            // Parse rsync output for statistics. Handles rsync 2.x/3.x wording,
            // GNU "bytes" vs openrsync "B" suffixes, and locale separators.
            const stats = parseRsyncStats(output, duration);

            logger.info(`Rsync ${direction} completed`, {
              server: serverName,
              direction,
              duration: `${duration}ms`,
              filesTransferred: stats.filesTransferred,
              totalSize: stats.totalSize,
              dryRun,
            });

            // Format output
            let resultText = dryRun ? '🔍 Dry run completed\n' : '✅ Sync completed successfully\n';
            resultText += `Direction: ${direction === 'push' ? 'Local → Remote' : 'Remote → Local'}\n`;
            resultText += `Server: ${serverName}\n`;
            resultText += `Source: ${direction === 'push' ? localPath : remotePath}\n`;
            resultText += `Destination: ${direction === 'push' ? remotePath : localPath}\n`;

            if (stats.filesTransferred > 0) {
              resultText += `Files transferred: ${stats.filesTransferred}\n`;
              if (stats.totalSize > 0) {
                const sizeKB = (stats.totalSize / 1024).toFixed(2);
                resultText += `Total size: ${sizeKB} KB\n`;
              }
              if (stats.speed) {
                const speedKB = (stats.speed / 1024).toFixed(2);
                resultText += `Average speed: ${speedKB} KB/s\n`;
              }
            } else {
              resultText += 'No files needed to be transferred\n';
            }

            resultText += `Time: ${(duration / 1000).toFixed(2)} seconds\n`;

            if (verbose && output.length < 5000) {
              resultText += '\n📋 Sync statistics:\n';
              // Only show relevant stats lines
              const statsLines = output
                .split('\n')
                .filter(
                  (line) =>
                    line.includes('Number of') ||
                    line.includes('Total') ||
                    line.includes('sent') ||
                    line.includes('received')
                );
              if (statsLines.length > 0) {
                resultText += statsLines.join('\n');
              }
            }

            resolve({
              content: [
                {
                  type: 'text',
                  text: resultText,
                },
              ],
            });
          });
        });
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Sync error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_list_servers',
    {
      description:
        'Lists all SSH servers defined in the loaded configuration, returning for each the name, host, user, port, authentication type (password or key), default directory, group, and description. Read-only and local: it reads configuration only and opens no SSH connections. Deliberately omits secrets, so no passwords, key paths, passphrases, or sudo passwords are returned. Takes no parameters. Useful as a first call to discover which server names other tools accept.',
      inputSchema: {},
    },
    async () => {
      const servers = await loadServerConfig();
      const serverInfo = Object.entries(servers).map(([name, config]: [string, any]) => ({
        name,
        host: config.host,
        user: config.user,
        port: config.port || '22',
        auth: config.password ? 'password' : 'key',
        defaultDir: config.defaultDir || '',
        group: config.group || '',
        description: config.description || '',
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(serverInfo, null, 2),
          },
        ],
      };
    }
  );

  // New deploy tool for automated deployment
}
