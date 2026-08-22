// Auto-split from src/index.js (candidate 3). Tool definitions for the
// advanced group — bodies moved verbatim; see src/tool-registry.ts for the
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

export function registerAdvancedTools(ctx: import('../tool-registry.ts').ToolContext) {
  const {
    register: registerToolConditional,
    getConnection,
    closeConnection,
    execCommandWithTimeout,
    loadServerConfig,
    getServerConfig,
    applyServerPolicy,
    auditOk,
    isConnectionValid,
    cleanupOldConnections,
    connections,
    connectionTimestamps,
    keepaliveIntervals,
    CONNECTION_TIMEOUT,
    KEEPALIVE_INTERVAL,
  } = ctx;

  registerToolConditional(
    'ssh_history',
    {
      description:
        'Returns the in-memory log of SSH commands previously run through this server process during the current session, formatted with timestamps, server, duration, and success status. Purely local and read-only: it opens no SSH connection and does not persist across restarts. Optional filters narrow the results by server name, by success or failure, and by a search substring in the command text; limit defaults to 20 most recent entries. Does not expose command output, only the commands and their outcomes.',
      inputSchema: {
        limit: z.number().optional().describe('Number of commands to show (default: 20)'),
        server: z.string().optional().describe('Filter by server name'),
        success: z.boolean().optional().describe('Filter by success/failure'),
        search: z.string().optional().describe('Search in commands'),
      },
    },
    async ({ limit = 20, server, success, search }) => {
      try {
        // Get history from logger
        let history = logger.getHistory(limit * 2); // Get more to account for filtering

        // Apply filters
        if (server) {
          history = history.filter((h) => h.server?.toLowerCase().includes(server.toLowerCase()));
        }

        if (success !== undefined) {
          history = history.filter((h) => h.success === success);
        }

        if (search) {
          history = history.filter((h) => h.command?.toLowerCase().includes(search.toLowerCase()));
        }

        // Limit results
        history = history.slice(-limit);

        // Format output
        let output = '📜 SSH Command History\n';
        output += `Showing last ${history.length} commands`;

        const filters = [];
        if (server) filters.push(`server: ${server}`);
        if (success !== undefined) filters.push(success ? 'successful only' : 'failed only');
        if (search) filters.push(`search: ${search}`);

        if (filters.length > 0) {
          output += ` (filtered: ${filters.join(', ')})`;
        }

        output += '\n' + '━'.repeat(60) + '\n\n';

        if (history.length === 0) {
          output += 'No commands found matching the criteria.\n';
        } else {
          history.forEach((entry, index) => {
            const time = new Date(entry.timestamp).toLocaleString();
            const status = entry.success ? '✅' : '❌';
            const duration = entry.duration || 'N/A';

            output += `${history.length - index}. ${status} [${time}]\n`;
            output += `   Server: ${entry.server || 'unknown'}\n`;
            output += `   Command: ${entry.command?.substring(0, 100) || 'N/A'}`;
            if (entry.command && entry.command.length > 100) {
              output += '...';
            }
            output += '\n';
            output += `   Duration: ${duration}`;

            if (!entry.success && entry.error) {
              output += `\n   Error: ${entry.error}`;
            }

            output += '\n\n';
          });
        }

        output += '━'.repeat(60) + '\n';
        output += `Total commands in history: ${logger.getHistory(1000).length}\n`;

        logger.info('Command history retrieved', {
          limit,
          filters: filters.length,
          results: history.length,
        });

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error retrieving history: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // SSH Session Management Tools

  registerToolConditional(
    'ssh_execute_group',
    {
      description:
        'Runs one command on every server belonging to the named group and returns a per-server success or failure report. Members come from the groups defined with ssh_group_manage plus every server whose configuration carries a matching group field, so a group can exist through the config alone. Mutates remote state on each member and is not idempotent. Best-effort: the security policy of each server is evaluated independently, so readonly or restricted members are reported as failed without aborting the rest unless stopOnError is set. Strategy may be parallel, sequential, or rolling (delay applies between servers). Per-server timeout is 30000 ms; cwd defaults to the default_dir of each server.',
      inputSchema: {
        group: z.string().describe('Group name (e.g., "production", "staging", "all")'),
        command: z.string().describe('Command to execute'),
        strategy: z
          .enum(['parallel', 'sequential', 'rolling'])
          .optional()
          .describe('Execution strategy'),
        delay: z.number().optional().describe('Delay between servers in ms (for rolling)'),
        stopOnError: z.boolean().optional().describe('Stop execution on first error'),
        cwd: z.string().optional().describe('Working directory'),
      },
    },
    async ({ group: groupName, command, strategy, delay, stopOnError, cwd }) => {
      try {
        // Refresh the server config before resolving the group: membership can
        // come from the per-server `group` field, so an edited config must be
        // visible here, not only inside the per-server executor below.
        await loadServerConfig();

        // Execute command on each server in the group
        const result = await executeOnGroup(
          groupName,
          async (serverName) => {
            // Per-server policy: each server in the group is evaluated independently.
            // A server in readonly/restricted mode refuses the command; others
            // execute normally. Refusal is surfaced as a per-server failure rather
            // than aborting the whole group (group execution is best-effort).
            const denied = await applyServerPolicy(
              serverName,
              'ssh_execute_group',
              { group: groupName, command, cwd },
              command
            );
            if (denied) {
              const errorText = denied.content?.[0]?.text || 'Policy denied';
              return { stdout: '', stderr: errorText, code: -2, success: false };
            }
            const ssh = await getConnection(serverName);

            // Build full command with cwd if provided.
            // Use platform-appropriate syntax: Set-Location for Windows (cmd.exe
            // does not support `cd && `) vs cd && for Linux/macOS.
            const servers = await loadServerConfig();
            const serverConfig = servers[serverName.toLowerCase()];
            const workingDir = cwd || serverConfig?.defaultDir;
            const platform = serverConfig?.platform || 'linux';
            const fullCommand = workingDir
              ? buildCdPrefix(workingDir, platform) + command
              : command;

            const execResult = await execCommandWithTimeout(ssh, fullCommand, { platform }, 30000);

            return {
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              code: execResult.code,
              success: execResult.code === 0,
            };
          },
          { strategy, delay, stopOnError }
        );

        // Format output
        let output = `🚀 Group Execution: ${groupName}\n`;
        output += `Command: ${command}\n`;
        output += `Strategy: ${result.strategy}\n`;
        output += '━'.repeat(60) + '\n\n';

        // Show results for each server
        result.results.forEach(({ server, success, result: execResult, error }) => {
          output += `📍 ${server}: ${success ? '✅ SUCCESS' : '❌ FAILED'}\n`;

          if (success && execResult) {
            if (execResult.stdout) {
              output += `   Output: ${execResult.stdout.substring(0, 200)}`;
              if (execResult.stdout.length > 200) output += '...';
              output += '\n';
            }
            if (execResult.stderr) {
              output += `   Stderr: ${execResult.stderr.substring(0, 100)}\n`;
            }
          } else if (error) {
            output += `   Error: ${error}\n`;
          }
          output += '\n';
        });

        // Summary
        output += '━'.repeat(60) + '\n';
        output += `Summary: ${result.summary.successful}/${result.summary.total} successful`;
        if (result.summary.failed > 0) {
          output += ` (${result.summary.failed} failed)`;
        }
        output += '\n';

        logger.info('Group command executed', {
          group: groupName,
          command: command.substring(0, 50),
          ...result.summary,
        });

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logger.error('Group execution failed', {
          group: groupName,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Group execution error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // The stored member list is only half the story: servers tagged with this group
  // in their SSH config belong to it too. Spell that out after an edit, so the
  // counts above are not read as the full set of targets.
  function formatConfigMembers(groupName, storedServers) {
    try {
      const resolved = getGroup(groupName);
      if (!resolved.fromConfig) return '';

      const stored = new Set(storedServers.map((server) => server.toLowerCase()));
      const fromConfig = resolved.servers.filter((server) => !stored.has(server));
      if (fromConfig.length === 0) return '';

      return (
        `\n\nAlso in this group via the server config (group = "${groupName}"): ${fromConfig.join(', ')}` +
        `\nEffective target: ${resolved.servers.length} servers`
      );
    } catch {
      return '';
    }
  }

  registerToolConditional(
    'ssh_group_manage',
    {
      description:
        'Creates, updates, deletes, and inspects named server groups used by ssh_execute_group, persisting changes to local configuration only with no remote side effects. The action selects the operation: create, update, delete, add-servers, remove-servers, or list. Every action except list requires name; add-servers and remove-servers also require a non-empty servers array. list is read-only and also reports the groups derived from the per-server group field of the SSH configuration, which are read-only here and change only by editing that configuration. Optional strategy, delay, and stopOnError set default group execution behavior.',
      inputSchema: {
        action: z
          .enum(['create', 'update', 'delete', 'list', 'add-servers', 'remove-servers'])
          .describe('Action to perform'),
        name: z.string().optional().describe('Group name'),
        servers: z.array(z.string()).optional().describe('Server names'),
        description: z.string().optional().describe('Group description'),
        strategy: z
          .enum(['parallel', 'sequential', 'rolling'])
          .optional()
          .describe('Execution strategy'),
        delay: z.number().optional().describe('Delay between servers in ms'),
        stopOnError: z.boolean().optional().describe('Stop on error flag'),
      },
    },
    async ({ action, name, servers, description, strategy, delay, stopOnError }) => {
      try {
        // Groups can be derived from the per-server `group` field, so make sure
        // the group layer sees the current configuration before answering.
        await loadServerConfig();

        let result;
        let output = '';

        switch (action) {
          case 'create':
            if (!name) throw new Error('Group name required for create');
            result = createGroup(name, servers || [], {
              description,
              strategy,
              delay,
              stopOnError,
            });
            output = `✅ Group '${name}' created\n`;
            output += `Servers: ${result.servers.join(', ') || 'none'}\n`;
            output += `Strategy: ${result.strategy}\n`;
            break;

          case 'update':
            if (!name) throw new Error('Group name required for update');
            result = updateGroup(name, {
              servers,
              description,
              strategy,
              delay,
              stopOnError,
            });
            output = `✅ Group '${name}' updated\n`;
            output += `Servers: ${result.servers.join(', ')}\n`;
            break;

          case 'delete':
            if (!name) throw new Error('Group name required for delete');
            deleteGroup(name);
            output = `✅ Group '${name}' deleted`;
            break;

          case 'add-servers':
            if (!name) throw new Error('Group name required');
            if (!servers || servers.length === 0) throw new Error('Servers required');
            result = addServersToGroup(name, servers);
            output = `✅ Added ${servers.length} servers to '${name}'\n`;
            output += `Total servers: ${result.servers.length}\n`;
            output += `Members: ${result.servers.join(', ')}`;
            output += formatConfigMembers(name, result.servers);
            break;

          case 'remove-servers':
            if (!name) throw new Error('Group name required');
            if (!servers || servers.length === 0) throw new Error('Servers required');
            result = removeServersFromGroup(name, servers);
            output = `✅ Removed ${servers.length} servers from '${name}'\n`;
            output += `Remaining: ${result.servers.length}\n`;
            output += `Members: ${result.servers.join(', ') || 'none'}`;
            output += formatConfigMembers(name, result.servers);
            break;

          case 'list': {
            const groups = listGroups();
            output = '📋 Server Groups\n';
            output += '━'.repeat(60) + '\n\n';

            groups.forEach((group) => {
              output += `📁 ${group.name}`;
              if (group.dynamic) output += ' (dynamic)';
              if (group.fromConfig) output += ' (from server config)';
              output += '\n';
              output += `   Description: ${group.description}\n`;
              output += `   Servers: ${group.serverCount} servers\n`;
              if (group.servers.length > 0) {
                output += `   Members: ${group.servers.slice(0, 5).join(', ')}`;
                if (group.servers.length > 5) output += ` ... +${group.servers.length - 5} more`;
                output += '\n';
              }
              output += `   Strategy: ${group.strategy || 'parallel'}\n`;
              if (group.delay) output += `   Delay: ${group.delay}ms\n`;
              if (group.stopOnError) output += '   Stop on error: yes\n';
              output += '\n';
            });

            output += '━'.repeat(60) + '\n';
            output += `Total groups: ${groups.length}`;
            break;
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        logger.info('Group management action completed', {
          action,
          name,
          servers: servers?.length,
        });

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logger.error('Group management failed', {
          action,
          name,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Group management error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_deploy',
    {
      description:
        'Deploys a list of local files to remote paths on the named server, uploading each to a temporary location first and then moving it into place. Mutates remote state. By default it backs up any existing target file before overwriting; backup can be disabled per call. Options can set owner and permissions, supply a sudo password, and name a single service to restart afterward. Detects sensible owner and permission defaults from the remote path. Runs pre and post deploy hooks. Blocked entirely on servers in readonly or restricted security mode.',
      inputSchema: {
        server: z.string().describe('Server name or alias'),
        files: z
          .array(
            z.object({
              local: z.string().describe('Local file path'),
              remote: z.string().describe('Remote file path'),
            })
          )
          .describe('Array of files to deploy'),
        options: z
          .object({
            owner: z.string().optional().describe('Set file owner (e.g., "user:group")'),
            permissions: z.string().optional().describe('Set file permissions (e.g., "644")'),
            backup: z.boolean().optional().default(true).describe('Backup existing files'),
            restart: z.string().optional().describe('Service to restart after deployment'),
            sudoPassword: z
              .string()
              .optional()
              .describe('Sudo password if needed (use with caution)'),
          })
          .optional()
          .describe('Deployment options'),
      },
    },
    async ({ server, files, options = {} }: any) => {
      const denied = await applyServerPolicy(server, 'ssh_deploy', {
        files: files.map((f) => ({ local: f.local, remote: f.remote })),
        options,
      });
      if (denied) return denied;

      try {
        const ssh = await getConnection(server);

        // Execute pre-deploy hook
        await executeHook('pre-deploy', {
          server: server,
          files: files.map((f) => f.local).join(', '),
        });

        const deployments = [];
        const results = [];

        // Prepare deployment for each file
        for (const file of files) {
          const tempFile = getTempFilename(path.basename(file.local));
          const needs = detectDeploymentNeeds(file.remote);

          // Merge detected needs with user options
          const deployOptions = {
            ...options,
            owner: options.owner || needs.suggestedOwner,
            permissions: options.permissions || needs.suggestedPerms,
          };

          const strategy = buildDeploymentStrategy(file.remote, deployOptions);

          // Upload file to temp location first
          await ssh.putFile(file.local, tempFile);
          results.push(`✅ Uploaded ${path.basename(file.local)} to temp location`);

          // Execute deployment strategy
          const deployServers = await loadServerConfig();
          const deployServerConfig = deployServers[server.toLowerCase()];
          for (const step of strategy.steps) {
            const command = step.command.replace('{{tempFile}}', tempFile);

            const result = await execCommandWithTimeout(
              ssh,
              command,
              { platform: deployServerConfig?.platform },
              15000
            );

            if (result.code !== 0 && step.type !== 'backup') {
              throw new Error(`${step.type} failed: ${result.stderr}`);
            }

            if (step.type !== 'cleanup') {
              results.push(`✅ ${step.type}: ${file.remote}`);
            }
          }

          deployments.push({
            local: file.local,
            remote: file.remote,
            tempFile,
            strategy,
          });
        }

        // Execute post-deploy hook
        await executeHook('post-deploy', {
          server: server,
          files: files.map((f) => f.remote).join(', '),
        });

        return {
          content: [
            {
              type: 'text',
              text: `🚀 Deployment successful!\n\n${results.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Deployment failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Execute command with sudo support
  registerToolConditional(
    'ssh_execute_sudo',
    {
      description:
        'Runs a command with elevated privileges via sudo on the named server and returns the exit code and output. Prepends sudo when absent. If a password is given, or a sudo password is configured for the server, it is piped to sudo -S and masked in the returned output. Mutates remote state and can be destructive. Honors the cwd parameter or the server default directory and adapts to Linux or Windows. Timeout defaults to 30000 ms. Blocked entirely in readonly mode; in restricted mode the command must satisfy the allow and deny patterns.',
      inputSchema: {
        server: z.string().describe('Server name or alias'),
        command: z.string().describe('Command to execute with sudo'),
        password: z.string().optional().describe('Sudo password (will be masked in output)'),
        cwd: z.string().optional().describe('Working directory'),
        timeout: z.number().optional().describe('Command timeout in milliseconds (default: 30000)'),
      },
    },
    async ({ server, command, password, cwd, timeout = 30000 }) => {
      // ssh_execute_sudo is in READONLY_BLOCKED_TOOLS, so readonly mode blocks
      // it at the tool level. In restricted mode the command itself is matched
      // against ALLOW/DENY patterns.
      const denied = await applyServerPolicy(server, 'ssh_execute_sudo', { command, cwd }, command);
      if (denied) return denied;

      try {
        const ssh = await getConnection(server);
        const servers = await loadServerConfig();
        const resolvedName = resolveServerName(server, servers);
        const serverConfig = servers[resolvedName];

        // Build the full command. Quoting is centralized in shell-quote.js:
        // passwords and directories go through buildSudoPipeline/buildCdPrefix
        // so special characters can never break out of their quoting.
        const platform = serverConfig?.platform || 'linux';
        const sudoPassword = password || serverConfig?.sudoPassword;

        let fullCommand;
        let maskedCommand;
        if (sudoPassword) {
          const pipe = buildSudoPipeline(sudoPassword, command);
          fullCommand = pipe.command;
          maskedCommand = pipe.masked;
        } else {
          fullCommand = command.startsWith('sudo ') ? command : `sudo ${command}`;
          maskedCommand = fullCommand;
        }

        // Add working directory if specified
        const workingDir = cwd || serverConfig?.defaultDir;
        if (workingDir) {
          const prefix = buildCdPrefix(workingDir, platform);
          fullCommand = prefix + fullCommand;
          maskedCommand = prefix + maskedCommand;
        }

        const result = await execCommandWithTimeout(ssh, fullCommand, { platform }, timeout);

        return {
          content: [
            {
              type: 'text',
              text: `🔐 Sudo command executed\nServer: ${server}\nCommand: ${maskedCommand}\nExit code: ${result.code}\n\nOutput:\n${result.stdout || result.stderr}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Sudo execution failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Manage command aliases
  registerToolConditional(
    'ssh_command_alias',
    {
      description:
        'Manages local shorthand aliases that map a short name to a full command string, stored in local config with no remote execution or side effects. The action selects behavior: add (requires both alias and command), remove (requires alias), list to show all aliases tagged as profile or custom, or suggest to return existing aliases matching a search term passed in the command field. Adding an existing alias overwrites it.',
      inputSchema: {
        action: z.enum(['add', 'remove', 'list', 'suggest']).describe('Action to perform'),
        alias: z.string().optional().describe('Alias name (for add/remove)'),
        command: z
          .string()
          .optional()
          .describe('Command to alias (for add) or search term (for suggest)'),
      },
    },
    async ({ action, alias, command }) => {
      try {
        switch (action) {
          case 'add': {
            if (!alias || !command) {
              throw new Error('Both alias and command are required for add action');
            }

            addCommandAlias(alias, command);
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Command alias created: ${alias} -> ${command}`,
                },
              ],
            };
          }

          case 'remove': {
            if (!alias) {
              throw new Error('Alias is required for remove action');
            }

            removeCommandAlias(alias);
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Command alias removed: ${alias}`,
                },
              ],
            };
          }

          case 'list': {
            const aliases = listCommandAliases();

            const aliasInfo = aliases
              .map(
                ({ alias, command, isFromProfile, isCustom }) =>
                  `  ${alias} -> ${command}${isFromProfile ? ' (profile)' : ''}${isCustom ? ' (custom)' : ''}`
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text:
                    aliases.length > 0
                      ? `📝 Command aliases:\n${aliasInfo}`
                      : '📝 No command aliases configured',
                },
              ],
            };
          }

          case 'suggest': {
            if (!command) {
              throw new Error('Command search term is required for suggest action');
            }

            const suggestions = suggestAliases(command);

            const suggestionInfo = suggestions
              .map(({ alias, command }) => `  ${alias} -> ${command}`)
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text:
                    suggestions.length > 0
                      ? `💡 Suggested aliases for "${command}":\n${suggestionInfo}`
                      : `💡 No aliases found matching "${command}"`,
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Command alias operation failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Manage hooks
  registerToolConditional(
    'ssh_hooks',
    {
      description:
        'Manages automation hooks that fire around SSH operations such as pre-deploy, toggling them on or off in local configuration only with no immediate remote action. The action selects behavior: list shows each hook with its enabled state, description, and action count; enable and disable flip a hook and both require the hook name; status summarizes which hooks are currently enabled versus disabled. Toggling persists and affects later operations.',
      inputSchema: {
        action: z.enum(['list', 'enable', 'disable', 'status']).describe('Action to perform'),
        hook: z.string().optional().describe('Hook name (for enable/disable)'),
      },
    },
    async ({ action, hook }) => {
      try {
        switch (action) {
          case 'list': {
            const hooks = listHooks();

            const hooksInfo = hooks
              .map(
                ({ name, enabled, description, actionCount }) =>
                  `  ${enabled ? '✅' : '⭕'} ${name}: ${description} (${actionCount} actions)`
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text:
                    hooks.length > 0
                      ? `🎣 Available hooks:\n${hooksInfo}`
                      : '🎣 No hooks configured',
                },
              ],
            };
          }

          case 'enable': {
            if (!hook) {
              throw new Error('Hook name is required for enable action');
            }

            toggleHook(hook, true);
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Hook enabled: ${hook}`,
                },
              ],
            };
          }

          case 'disable': {
            if (!hook) {
              throw new Error('Hook name is required for disable action');
            }

            toggleHook(hook, false);
            return {
              content: [
                {
                  type: 'text',
                  text: `⭕ Hook disabled: ${hook}`,
                },
              ],
            };
          }

          case 'status': {
            const hooks = listHooks();
            const enabledHooks = hooks.filter((h) => h.enabled);
            const disabledHooks = hooks.filter((h) => !h.enabled);

            return {
              content: [
                {
                  type: 'text',
                  text: `🎣 Hook status:\n  Enabled: ${enabledHooks.map((h) => h.name).join(', ') || 'none'}\n  Disabled: ${disabledHooks.map((h) => h.name).join(', ') || 'none'}`,
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Hook operation failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Manage profiles
  registerToolConditional(
    'ssh_profile',
    {
      description:
        'Manages SSH Manager profiles that bundle command aliases and hooks for different project types, affecting local configuration only with no remote side effects. The action selects behavior: list shows available profiles and the active one, current shows the active profile details, and switch activates a named profile and requires the profile argument. A successful switch reports that Claude Code must be restarted before the new profile takes effect.',
      inputSchema: {
        action: z.enum(['list', 'switch', 'current']).describe('Action to perform'),
        profile: z.string().optional().describe('Profile name (for switch)'),
      },
    },
    async ({ action, profile }) => {
      try {
        switch (action) {
          case 'list': {
            const profiles = listProfiles();

            const profileInfo = profiles
              .map(
                (p) =>
                  `  ${p.name}: ${p.description} (${p.aliasCount} aliases, ${p.hookCount} hooks)`
              )
              .join('\n');

            const current = getActiveProfileName();

            return {
              content: [
                {
                  type: 'text',
                  text:
                    profiles.length > 0
                      ? `📚 Available profiles (current: ${current}):\n${profileInfo}`
                      : '📚 No profiles found',
                },
              ],
            };
          }

          case 'switch': {
            if (!profile) {
              throw new Error('Profile name is required for switch action');
            }

            if (setActiveProfile(profile)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `✅ Switched to profile: ${profile}\n⚠️  Restart Claude Code to apply profile changes`,
                  },
                ],
              };
            } else {
              throw new Error(`Failed to switch to profile: ${profile}`);
            }
          }

          case 'current': {
            const current = getActiveProfileName();
            const profile = loadProfile();

            return {
              content: [
                {
                  type: 'text',
                  text: `📦 Current profile: ${current}\n📝 Description: ${profile.description || 'No description'}\n🔧 Aliases: ${Object.keys(profile.commandAliases || {}).length}\n🎣 Hooks: ${Object.keys(profile.hooks || {}).length}`,
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Profile operation failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Connection management tool
  registerToolConditional(
    'ssh_connection_status',
    {
      description:
        'Inspects and manages the pooled SSH connections held by this server process; affects only local in-memory connections, never remote state. The action parameter selects: status lists active connections with age and keepalive (read-only); reconnect closes then reopens one connection; disconnect closes one connection; cleanup drops aged-out and dead connections. The server parameter is required for reconnect and disconnect and ignored otherwise.',
      inputSchema: {
        action: z
          .enum(['status', 'reconnect', 'disconnect', 'cleanup'])
          .describe('Action to perform'),
        server: z.string().optional().describe('Server name (for reconnect/disconnect)'),
      },
    },
    async ({ action, server }) => {
      try {
        switch (action) {
          case 'status': {
            const activeConnections = [];
            const now = Date.now();

            for (const [serverName, ssh] of connections.entries()) {
              const timestamp = connectionTimestamps.get(serverName);
              const ageMinutes = Math.floor((now - timestamp) / 1000 / 60);
              const isValid = await isConnectionValid(ssh);

              activeConnections.push({
                server: serverName,
                status: isValid ? '✅ Active' : '❌ Dead',
                age: `${ageMinutes} minutes`,
                keepalive: keepaliveIntervals.has(serverName) ? '✅' : '❌',
              });
            }

            const statusInfo =
              activeConnections.length > 0
                ? activeConnections
                    .map(
                      (c) => `  ${c.server}: ${c.status} (age: ${c.age}, keepalive: ${c.keepalive})`
                    )
                    .join('\n')
                : '  No active connections';

            return {
              content: [
                {
                  type: 'text',
                  text: `🔌 Connection Pool Status:\n${statusInfo}\n\nSettings:\n  Timeout: ${CONNECTION_TIMEOUT / 1000 / 60} minutes\n  Keepalive: Every ${KEEPALIVE_INTERVAL / 1000 / 60} minutes`,
                },
              ],
            };
          }

          case 'reconnect': {
            if (!server) {
              throw new Error('Server name is required for reconnect action');
            }

            const normalizedName = server.toLowerCase();
            if (connections.has(normalizedName)) {
              closeConnection(normalizedName);
            }

            await getConnection(server);
            return {
              content: [
                {
                  type: 'text',
                  text: `♻️  Reconnected to ${server}`,
                },
              ],
            };
          }

          case 'disconnect': {
            if (!server) {
              throw new Error('Server name is required for disconnect action');
            }

            closeConnection(server);
            return {
              content: [
                {
                  type: 'text',
                  text: `🔌 Disconnected from ${server}`,
                },
              ],
            };
          }

          case 'cleanup': {
            const oldCount = connections.size;
            cleanupOldConnections();

            // Also check and remove dead connections
            for (const [serverName, ssh] of connections.entries()) {
              const isValid = await isConnectionValid(ssh);
              if (!isValid) {
                closeConnection(serverName);
              }
            }

            const cleaned = oldCount - connections.size;
            return {
              content: [
                {
                  type: 'text',
                  text: `🧹 Cleanup complete: ${cleaned} connections closed, ${connections.size} active`,
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Connection management failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // SSH Tunnel Management - Create tunnel
  registerToolConditional(
    'ssh_tunnel_create',
    {
      description:
        'Opens a new SSH connection to the named server and starts a port-forwarding or SOCKS proxy tunnel that keeps running until closed. The type parameter selects local forward, remote forward, or dynamic SOCKS5 proxy. localPort is always required; remoteHost and remotePort are required for local and remote types but ignored for dynamic. localHost defaults to 127.0.0.1. Returns a tunnel ID used later to close it.',
      inputSchema: {
        server: z.string().describe('Server name or alias'),
        type: z.enum(['local', 'remote', 'dynamic']).describe('Tunnel type'),
        localHost: z.string().optional().describe('Local host (default: 127.0.0.1)'),
        localPort: z.number().describe('Local port'),
        remoteHost: z.string().optional().describe('Remote host (not needed for dynamic)'),
        remotePort: z.number().optional().describe('Remote port (not needed for dynamic)'),
      },
    },
    async ({ server, type, localHost, localPort, remoteHost, remotePort }) => {
      try {
        const servers = await loadServerConfig();
        const resolvedName = resolveServerName(server, servers);

        if (!resolvedName) {
          throw new Error(`Server "${server}" not found`);
        }

        const serverConfig = servers[resolvedName];
        const ssh = new SSHManager(serverConfig);
        await ssh.connect();

        const config = {
          type,
          localHost: localHost || '127.0.0.1',
          localPort,
          remoteHost,
          remotePort,
        };

        const tunnel = await createTunnel(resolvedName, ssh, config);

        let output = '✅ SSH tunnel created\n';
        output += `ID: ${tunnel.id}\n`;
        output += `Type: ${type}\n`;
        output += `Local: ${config.localHost}:${localPort}\n`;

        if (type === 'local') {
          output += `Remote: ${remoteHost}:${remotePort}\n`;
          output += `\n📌 Access remote ${remoteHost}:${remotePort} via local ${config.localHost}:${localPort}`;
        } else if (type === 'remote') {
          output += `Remote: ${remoteHost}:${remotePort}\n`;
          output += `\n📌 Remote ${remoteHost}:${remotePort} will forward to local ${config.localHost}:${localPort}`;
        } else if (type === 'dynamic') {
          output += `SOCKS proxy: ${config.localHost}:${localPort}\n`;
          output += `\n📌 SOCKS5 proxy available at ${config.localHost}:${localPort}`;
          output += `\n💡 Configure browser/app: SOCKS5 proxy ${config.localHost}:${localPort}`;
        }

        logger.info('SSH tunnel created', {
          id: tunnel.id,
          server: resolvedName,
          type,
          local: `${config.localHost}:${localPort}`,
        });

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to create tunnel', { error: error.message });
        return {
          content: [
            {
              type: 'text',
              text: `❌ Tunnel creation failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // List active tunnels
  registerToolConditional(
    'ssh_tunnel_list',
    {
      description:
        'Lists currently active SSH tunnels tracked by this process, showing each tunnel ID, server, type, state, local and remote endpoints, active and total connection counts, bytes transferred, error count, and timestamps. Read-only: it does not create, modify, or close anything. The optional server parameter filters results to one server; omit it to list every active tunnel across all servers.',
      inputSchema: {
        server: z.string().optional().describe('Filter by server name'),
      },
    },
    async ({ server }) => {
      try {
        const servers = await loadServerConfig();
        let resolvedName = null;

        if (server) {
          resolvedName = resolveServerName(server, servers);
          if (!resolvedName) {
            throw new Error(`Server "${server}" not found`);
          }
        }

        const tunnels = listTunnels(resolvedName);

        if (tunnels.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '📋 No active tunnels',
              },
            ],
          };
        }

        let output = '📋 Active SSH Tunnels\n';
        output += '━'.repeat(60) + '\n\n';

        tunnels.forEach((tunnel) => {
          output += `🔧 ${tunnel.id}\n`;
          output += `   Server: ${tunnel.server}\n`;
          output += `   Type: ${tunnel.type}\n`;
          output += `   State: ${tunnel.state}\n`;
          output += `   Local: ${tunnel.config.localHost}:${tunnel.config.localPort}\n`;

          if (tunnel.type !== 'dynamic') {
            output += `   Remote: ${tunnel.config.remoteHost}:${tunnel.config.remotePort}\n`;
          }

          output += `   Active connections: ${tunnel.activeConnections}\n`;
          output += `   Total connections: ${tunnel.stats.connectionsTotal}\n`;
          output += `   Bytes transferred: ${(tunnel.stats.bytesTransferred / 1024).toFixed(2)} KB\n`;
          output += `   Errors: ${tunnel.stats.errors}\n`;
          output += `   Created: ${new Date(tunnel.created).toLocaleString()}\n`;
          output += `   Last activity: ${new Date(tunnel.lastActivity).toLocaleString()}\n`;
          output += '\n';
        });

        output += '━'.repeat(60) + '\n';
        output += `Total tunnels: ${tunnels.length}`;

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to list tunnels', { error: error.message });
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to list tunnels: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Close a tunnel
  registerToolConditional(
    'ssh_tunnel_close',
    {
      description:
        'Tears down active SSH tunnels created earlier, freeing the bound local ports; this affects only local tunnel state, not the remote host. Exactly one of tunnelId or server must be supplied: tunnelId closes that single tunnel, while server closes every tunnel for the named server and reports how many were closed. Supplying neither raises an error. Closing is final and cannot be undone.',
      inputSchema: {
        tunnelId: z.string().optional().describe('Tunnel ID to close'),
        server: z.string().optional().describe('Close all tunnels for this server'),
      },
    },
    async ({ tunnelId, server }) => {
      try {
        if (!tunnelId && !server) {
          throw new Error('Either tunnelId or server must be specified');
        }

        let output = '';

        if (tunnelId) {
          // Close specific tunnel
          closeTunnel(tunnelId);
          output = `✅ Tunnel ${tunnelId} closed`;

          logger.info('SSH tunnel closed', { id: tunnelId });
        } else if (server) {
          // Close all tunnels for server
          const servers = await loadServerConfig();
          const resolvedName = resolveServerName(server, servers);

          if (!resolvedName) {
            throw new Error(`Server "${server}" not found`);
          }

          const count = closeServerTunnels(resolvedName);
          output = `✅ Closed ${count} tunnel(s) for server ${resolvedName}`;

          logger.info('Server tunnels closed', {
            server: resolvedName,
            count,
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to close tunnel', { error: error.message });
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to close tunnel: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Manage SSH host keys
  registerToolConditional(
    'ssh_key_manage',
    {
      description:
        'Manages SSH host key fingerprints in your local known_hosts file for the named server. The action parameter selects: verify, check, and list are read-only comparisons or listings; accept adds or updates the host key in known_hosts; remove deletes it. accept and remove mutate local state and are blocked on servers configured as readonly. server is required for every action except list. autoAccept defaults to false and should be used with caution.',
      inputSchema: {
        action: z
          .enum(['verify', 'accept', 'remove', 'list', 'check'])
          .describe('Action to perform'),
        server: z.string().optional().describe('Server name (required for most actions)'),
        autoAccept: z
          .boolean()
          .optional()
          .describe('Automatically accept new keys (use with caution)'),
      },
    },
    async ({ action, server, autoAccept = false }) => {
      // Mutating actions (accept, remove) are blocked in readonly mode at the
      // tool level. Pure-read actions (verify, list, check) are allowed regardless,
      // so we only gate when the action would modify state.
      if (server && (action === 'accept' || action === 'remove')) {
        const denied = await applyServerPolicy(server, 'ssh_key_manage', { action, autoAccept });
        if (denied) return denied;
      }
      try {
        const servers = await loadServerConfig();
        let resolvedName, serverConfig, host, port;

        // Resolve server details for actions that need them
        if (server && action !== 'list') {
          resolvedName = resolveServerName(server, servers);
          if (!resolvedName) {
            throw new Error(`Server "${server}" not found`);
          }
          serverConfig = servers[resolvedName];
          host = serverConfig.host;
          // port is already a number from ConfigLoader; parseInt() on it only
          // worked because JS stringifies the argument first.
          port = serverConfig.port || 22;
        }

        switch (action) {
          case 'verify': {
            // Check if host key has changed
            const verification = await hasHostKeyChanged(host, port);

            if (verification.changed) {
              // Execute pre-connect-key-change hook
              await executeHook('pre-connect-key-change', {
                server: resolvedName,
                host,
                port,
                currentFingerprints: verification.currentFingerprints,
                newFingerprints: verification.newFingerprints,
              });

              let output = `⚠️  SSH host key has changed for ${server} (${host}:${port})\n\n`;
              output += 'Current fingerprints:\n';
              verification.currentFingerprints.forEach((fp) => {
                output += `  ${fp}\n`;
              });
              output += '\nNew fingerprints:\n';
              verification.newFingerprints.forEach((fp) => {
                output += `  ${fp}\n`;
              });
              output += '\n⚠️  This could indicate a security issue or server reinstallation.\n';
              output +=
                "Use 'ssh_key_manage' with action 'accept' to update the key if you trust this change.";

              return {
                content: [
                  {
                    type: 'text',
                    text: output,
                  },
                ],
              };
            } else {
              let output = `✅ SSH host key verified for ${server} (${host}:${port})\n`;
              output += `Reason: ${verification.reason}\n`;

              if (verification.reason === 'not_in_known_hosts') {
                output += "\nℹ️  Host not in known_hosts. Use 'accept' action to add it.";
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: output,
                  },
                ],
              };
            }
          }

          case 'accept': {
            // Check if key exists
            const isKnown = isHostKnown(host, port);

            if (isKnown) {
              // Update existing key
              await updateHostKey(host, port);

              // Execute post-key-update hook
              await executeHook('post-key-update', {
                server: resolvedName,
                host,
                port,
                action: 'updated',
              });

              logger.info('SSH host key updated', { server: resolvedName, host, port });

              return {
                content: [
                  {
                    type: 'text',
                    text: `✅ SSH host key updated for ${server} (${host}:${port})\nThe new key has been accepted and saved.`,
                  },
                ],
              };
            } else {
              // Add new key
              await addHostKey(host, port);

              // Execute post-key-update hook
              await executeHook('post-key-update', {
                server: resolvedName,
                host,
                port,
                action: 'added',
              });

              logger.info('SSH host key added', { server: resolvedName, host, port });

              return {
                content: [
                  {
                    type: 'text',
                    text: `✅ SSH host key added for ${server} (${host}:${port})\nThe key has been saved to known_hosts.`,
                  },
                ],
              };
            }
          }

          case 'remove': {
            removeHostKey(host, port);

            logger.info('SSH host key removed', { server: resolvedName, host, port });

            return {
              content: [
                {
                  type: 'text',
                  text: `✅ SSH host key removed for ${server} (${host}:${port})`,
                },
              ],
            };
          }

          case 'check': {
            // Get current fingerprints
            const currentKeys = getCurrentHostKey(host, port);
            const newKeys = await getHostKeyFingerprint(host, port);

            let output = `🔑 SSH Host Keys for ${server} (${host}:${port})\n`;
            output += '━'.repeat(60) + '\n\n';

            if (currentKeys && currentKeys.length > 0) {
              output += '📋 Keys in known_hosts:\n';
              currentKeys.forEach((key) => {
                output += `  ${key.type}: ${key.fingerprint}\n`;
              });
            } else {
              output += '⚠️  No keys found in known_hosts\n';
            }

            output += '\n🌐 Keys from server:\n';
            if (newKeys && newKeys.length > 0) {
              newKeys.forEach((key) => {
                output += `  ${key.type}: ${key.fingerprint}\n`;
              });
            } else {
              output += '  ❌ Could not fetch keys from server\n';
            }

            return {
              content: [
                {
                  type: 'text',
                  text: output,
                },
              ],
            };
          }

          case 'list': {
            const knownHosts = listKnownHosts();

            let output = '🔑 Known SSH Hosts\n';
            output += '━'.repeat(60) + '\n\n';

            if (knownHosts.length === 0) {
              output += 'No hosts in known_hosts file\n';
            } else {
              // Map server names to known hosts
              const serverMap = new Map();
              for (const [name, config] of Object.entries(servers) as [string, any][]) {
                const key = `${config.host}:${config.port || 22}`;
                serverMap.set(key, name);
              }

              knownHosts.forEach((entry) => {
                const serverName = serverMap.get(`${entry.host}:${entry.port}`);
                output += `📍 ${entry.host}:${entry.port}`;
                if (serverName) {
                  output += ` (${serverName})`;
                }
                output += '\n';

                entry.keys.forEach((key) => {
                  output += `   ${key.type}: ${key.fingerprint}\n`;
                });
                output += '\n';
              });
            }

            output += '━'.repeat(60) + '\n';
            output += `Total: ${knownHosts.length} hosts`;

            return {
              content: [
                {
                  type: 'text',
                  text: output,
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        logger.error('SSH key management failed', { action, server, error: error.message });

        return {
          content: [
            {
              type: 'text',
              text: `❌ SSH key management error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Manage server aliases
  registerToolConditional(
    'ssh_alias',
    {
      description:
        'Manages local name aliases that let you reference a configured server by a shorter or alternative name. The action parameter selects add, remove, or list. add creates an alias pointing to an existing server and requires both alias and server; remove deletes an alias and requires alias; list shows all aliases (read-only). add and remove persist the alias mapping locally. The target server must already exist for add to succeed.',
      inputSchema: {
        action: z.enum(['add', 'remove', 'list']).describe('Action to perform'),
        alias: z.string().optional().describe('Alias name (for add/remove)'),
        server: z.string().optional().describe('Server name (for add)'),
      },
    },
    async ({ action, alias, server }) => {
      try {
        switch (action) {
          case 'add': {
            if (!alias || !server) {
              throw new Error('Both alias and server are required for add action');
            }

            const servers = await loadServerConfig();
            const resolvedName = resolveServerName(server, servers);

            if (!resolvedName) {
              throw new Error(`Server "${server}" not found`);
            }

            addAlias(alias, resolvedName);
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Alias created: ${alias} -> ${resolvedName}`,
                },
              ],
            };
          }

          case 'remove': {
            if (!alias) {
              throw new Error('Alias is required for remove action');
            }

            removeAlias(alias);
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Alias removed: ${alias}`,
                },
              ],
            };
          }

          case 'list': {
            const aliases = listAliases();
            const servers = await loadServerConfig();

            const aliasInfo = aliases
              .map(({ alias, target }) => {
                const server = servers[target];
                return `  ${alias} -> ${target} (${server?.host || 'unknown'})`;
              })
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text:
                    aliases.length > 0
                      ? `📝 Server aliases:\n${aliasInfo}`
                      : '📝 No aliases configured',
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Alias operation failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // ============================================================================
  // BACKUP & RESTORE TOOLS
  // ============================================================================
}
