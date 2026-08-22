// Auto-split from src/index.js (candidate 3). Tool definitions for the
// monitoring group — bodies moved verbatim; see src/tool-registry.ts for the
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

export function registerMonitoringTools(ctx: import('../tool-registry.ts').ToolContext) {
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
    'ssh_tail',
    {
      description:
        'Reads the tail of a remote log file on the named server, optionally filtered by a grep pattern. Read-only; it does not modify remote state. Behavior depends on follow, which defaults to true: in follow mode it starts a streaming tail whose output is written to the server process stderr rather than returned, and the response only reports a session note, so to capture content directly set follow to false to get the last N lines back. The lines parameter defaults to 10.',
      inputSchema: {
        server: z.string().describe('Server name from configuration'),
        file: z.string().describe('Path to the log file to tail'),
        lines: z.number().optional().describe('Number of lines to show initially (default: 10)'),
        follow: z.boolean().optional().describe('Follow file for new content (default: true)'),
        grep: z.string().optional().describe('Filter lines with grep pattern'),
      },
    },
    async ({ server: serverName, file, lines = 10, follow = true, grep }) => {
      try {
        const ssh = await getConnection(serverName);

        // Build tail command
        let command = `tail -n ${lines}`;
        if (follow) {
          command += ' -f';
        }
        command += ` "${file}"`;

        // Add grep filter if specified
        if (grep) {
          command += ` | grep "${grep}"`;
        }

        logger.info(`Starting tail on ${serverName}`, {
          file,
          lines,
          follow,
          grep,
        });

        // For follow mode, we need to handle streaming
        if (follow) {
          // Create a unique session ID for this tail
          const sessionId = `tail_${Date.now()}`;

          // Store the SSH stream for later cleanup
          await ssh.execCommandStream(command, {
            onStdout: (chunk) => {
              // In a real implementation, this would stream to the client
              console.error(`[${serverName}:${file}] ${chunk}`);
            },
            onStderr: (chunk) => {
              console.error(`[ERROR] ${chunk}`);
            },
          });

          return {
            content: [
              {
                type: 'text',
                text: `📜 Tailing ${file} on ${serverName}\nSession ID: ${sessionId}\nShowing last ${lines} lines${grep ? ` (filtered: ${grep})` : ''}\n\n⚠️ Note: In follow mode, output is streamed to stderr.\nTo stop tailing, you'll need to kill the session.`,
              },
            ],
          };
        } else {
          // Non-follow mode - just get the output
          const tailServers = await loadServerConfig();
          const tailServerConfig = tailServers[serverName.toLowerCase()];
          const result = await execCommandWithTimeout(
            ssh,
            command,
            { platform: tailServerConfig?.platform },
            15000
          );

          if (result.code !== 0) {
            throw new Error(result.stderr || 'Failed to tail file');
          }

          logger.info(`Tail completed on ${serverName}`, {
            file,
            lines: result.stdout.split('\n').length,
          });

          return {
            content: [
              {
                type: 'text',
                text: `📜 Last ${lines} lines of ${file} on ${serverName}${grep ? ` (filtered: ${grep})` : ''}:\n\n${result.stdout}`,
              },
            ],
          };
        }
      } catch (error) {
        logger.error(`Tail failed on ${serverName}`, {
          file,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Tail error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_monitor',
    {
      description:
        'Collects a read-only snapshot of system resources on the named Linux server by running inspection commands such as top, free, df, ss, and ps. The type parameter selects the view and defaults to overview; other values are cpu, memory, disk, network, and process. Does not change remote state and needs no sudo. The interval and duration parameters are accepted for continuous monitoring intent but a single snapshot is gathered. Targets Linux tooling, so output may be empty on Windows hosts.',
      inputSchema: {
        server: z.string().describe('Server name from configuration'),
        type: z
          .enum(['overview', 'cpu', 'memory', 'disk', 'network', 'process'])
          .optional()
          .describe('Type of monitoring (default: overview)'),
        interval: z
          .number()
          .optional()
          .describe('Update interval in seconds for continuous monitoring'),
        duration: z.number().optional().describe('Duration in seconds for continuous monitoring'),
      },
    },
    async ({ server: serverName, type = 'overview', interval, duration }) => {
      try {
        const ssh = await getConnection(serverName);

        logger.info(`Starting system monitoring on ${serverName}`, {
          type,
          interval,
          duration,
        });

        // Record<string, string>: commands map metric name -> shell command;
        // output maps metric name -> captured stdout (or an Error: line).
        // (In .js these were expando-evolving literals; .ts needs the shape.)
        let commands: Record<string, string> = {};
        let output: Record<string, string> = {};

        // Define monitoring commands based on type
        switch (type) {
          case 'cpu':
            commands.cpu = 'top -bn1 | head -20';
            commands.load = 'uptime';
            commands.cores = 'nproc';
            break;

          case 'memory':
            commands.memory = 'free -h';
            commands.swap = 'swapon --show';
            commands.top_mem = 'ps aux --sort=-%mem | head -10';
            break;

          case 'disk':
            commands.disk = 'df -h';
            commands.inodes = 'df -i';
            commands.io = 'iostat -x 1 2 | tail -n +4';
            break;

          case 'network':
            commands.interfaces = 'ip -s link show';
            commands.connections = 'ss -tunap | head -20';
            commands.netstat = 'netstat -i';
            break;

          case 'process':
            commands.process = 'ps aux --sort=-%cpu | head -20';
            commands.count = 'ps aux | wc -l';
            commands.zombies = 'ps aux | grep -c defunct || echo 0';
            break;

          case 'overview':
          default:
            commands.uptime = 'uptime';
            commands.cpu = "mpstat 1 1 2>/dev/null || top -bn1 | grep 'Cpu'";
            commands.memory = 'free -h';
            commands.disk = "df -h | grep -E '^/dev/' | head -5";
            commands.load = 'cat /proc/loadavg';
            commands.processes = 'ps aux | wc -l';
            break;
        }

        // Execute all monitoring commands
        const startTime = Date.now();
        const monServers = await loadServerConfig();
        const monServerConfig = monServers[serverName.toLowerCase()];

        for (const [key, cmd] of Object.entries(commands)) {
          try {
            const result = await execCommandWithTimeout(
              ssh,
              cmd,
              { platform: monServerConfig?.platform },
              10000
            );
            if (result.code === 0) {
              output[key] = result.stdout.trim();
            } else {
              output[key] = `Error: ${result.stderr || 'Command failed'}`;
            }
          } catch (err) {
            output[key] = `Error: ${err.message}`;
          }
        }

        const monitoringDuration = Date.now() - startTime;

        // Format the output based on type
        let formattedOutput = `📊 System Monitor - ${serverName}\n`;
        formattedOutput += `Type: ${type} | Time: ${new Date().toISOString()}\n`;
        formattedOutput += `Collection time: ${monitoringDuration}ms\n`;
        formattedOutput += '━'.repeat(50) + '\n\n';

        switch (type) {
          case 'overview':
            formattedOutput += `⏱️ UPTIME\n${output.uptime || 'N/A'}\n\n`;
            formattedOutput += `💻 CPU\n${output.cpu || 'N/A'}\n\n`;
            formattedOutput += `📈 LOAD AVERAGE\n${output.load || 'N/A'}\n\n`;
            formattedOutput += `💾 MEMORY\n${output.memory || 'N/A'}\n\n`;
            formattedOutput += `💿 DISK USAGE\n${output.disk || 'N/A'}\n\n`;
            formattedOutput += `📝 PROCESSES: ${output.processes || 'N/A'}\n`;
            break;

          case 'cpu':
            formattedOutput += `🖥️ CPU CORES: ${output.cores || 'N/A'}\n\n`;
            formattedOutput += `📊 LOAD\n${output.load || 'N/A'}\n\n`;
            formattedOutput += `📈 TOP PROCESSES\n${output.cpu || 'N/A'}\n`;
            break;

          case 'memory':
            formattedOutput += `💾 MEMORY USAGE\n${output.memory || 'N/A'}\n\n`;
            formattedOutput += `🔄 SWAP\n${output.swap || 'No swap configured'}\n\n`;
            formattedOutput += `📊 TOP MEMORY CONSUMERS\n${output.top_mem || 'N/A'}\n`;
            break;

          case 'disk':
            formattedOutput += `💿 DISK SPACE\n${output.disk || 'N/A'}\n\n`;
            formattedOutput += `📁 INODE USAGE\n${output.inodes || 'N/A'}\n\n`;
            formattedOutput += `⚡ I/O STATS\n${output.io || 'N/A'}\n`;
            break;

          case 'network':
            formattedOutput += `🌐 NETWORK INTERFACES\n${output.interfaces || 'N/A'}\n\n`;
            formattedOutput += `🔌 CONNECTIONS\n${output.connections || 'N/A'}\n\n`;
            formattedOutput += `📊 INTERFACE STATS\n${output.netstat || 'N/A'}\n`;
            break;

          case 'process':
            formattedOutput += `📝 PROCESS COUNT: ${output.count || 'N/A'}\n`;
            formattedOutput += `⚠️ ZOMBIE PROCESSES: ${output.zombies || '0'}\n\n`;
            formattedOutput += `📊 TOP PROCESSES BY CPU\n${output.process || 'N/A'}\n`;
            break;
        }

        // Log monitoring results
        logger.info(`System monitoring completed on ${serverName}`, {
          type,
          duration: `${monitoringDuration}ms`,
          metrics: Object.keys(output).length,
        });

        // If continuous monitoring requested
        if (interval && duration) {
          formattedOutput += `\n\n⏰ Continuous monitoring: Every ${interval}s for ${duration}s\n`;
          formattedOutput += '(Not implemented in this version - would require streaming support)';
        }

        return {
          content: [
            {
              type: 'text',
              text: formattedOutput,
            },
          ],
        };
      } catch (error) {
        logger.error(`Monitoring failed on ${serverName}`, {
          type,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Monitor error: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_health_check',
    {
      description:
        'Runs a comprehensive read-only health check on the named server by executing diagnostic shell commands over SSH, then returns parsed JSON with overall status, CPU, memory, disk usage, and uptime. It only reads metrics and changes nothing on the remote host. Set detailed to true to additionally include load average and network metrics; it defaults to false. Critical CPU, memory, or disk conditions are surfaced in a critical_issues list.',
      inputSchema: {
        server: z.string().describe('Server name'),
        detailed: z
          .boolean()
          .optional()
          .describe('Include detailed metrics (network, load average)'),
      },
    },
    async ({ server: serverName, detailed = false }) => {
      try {
        const ssh = await getConnection(serverName);

        logger.info(`Running health check on ${serverName}`, { detailed });

        // Build and execute comprehensive health check
        const healthCommand = buildComprehensiveHealthCheckCommand();
        const result = await ssh.execCommand(healthCommand);

        if (result.code !== 0) {
          throw new Error(`Health check failed: ${result.stderr}`);
        }

        // Parse results
        // any: health-monitor's inferred return type omits the optional
        // load_average/network fields read in the detailed branch.
        const health: any = parseComprehensiveHealthCheck(result.stdout);

        // Build response
        // any: detailed/critical branches add load_average/network/critical_issues
        // (expando in the .js original).
        const response: any = {
          server: serverName,
          timestamp: new Date().toISOString(),
          overall_status: health.overall_status || HEALTH_STATUS.UNKNOWN,
          cpu: health.cpu,
          memory: health.memory,
          disks: health.disks,
          uptime: health.uptime,
        };

        if (detailed) {
          response.load_average = health.load_average;
          response.network = health.network;
        }

        // Check if there are any critical issues
        const criticalIssues = [];
        if (health.cpu && health.cpu.status === HEALTH_STATUS.CRITICAL) {
          criticalIssues.push(`CPU usage critical: ${health.cpu.percent}%`);
        }
        if (health.memory && health.memory.status === HEALTH_STATUS.CRITICAL) {
          criticalIssues.push(`Memory usage critical: ${health.memory.percent}%`);
        }
        if (health.disks) {
          for (const disk of health.disks) {
            if (disk.status === HEALTH_STATUS.CRITICAL) {
              criticalIssues.push(`Disk ${disk.mount} critical: ${disk.percent}%`);
            }
          }
        }

        if (criticalIssues.length > 0) {
          response.critical_issues = criticalIssues;
        }

        logger.info(`Health check completed: ${health.overall_status}`, {
          server: serverName,
          status: health.overall_status,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Health check failed', {
          server: serverName,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Health check failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_service_status',
    {
      description:
        'Checks the running state of the named system services on a remote server by querying each one over SSH, returning JSON per service plus running and stopped counts and an aggregate health rating. Read-only: it inspects status without starting, stopping, or restarting anything. The services array parameter is required and lists the service names to check, for example nginx, mysql, or docker; common names are resolved to their actual unit names automatically.',
      inputSchema: {
        server: z.string().describe('Server name'),
        services: z
          .array(z.string())
          .describe('Service names to check (e.g., nginx, mysql, docker)'),
      },
    },
    async ({ server: serverName, services }) => {
      try {
        const ssh = await getConnection(serverName);

        logger.info(`Checking service status on ${serverName}`, {
          services: services.join(', '),
        });

        const serviceStatuses = [];

        // Check each service
        for (const serviceName of services) {
          const resolvedName = resolveServiceName(serviceName);
          const statusCommand = buildServiceStatusCommand(resolvedName);
          const result = await ssh.execCommand(statusCommand);

          const status = parseServiceStatus(result.stdout, serviceName);
          serviceStatuses.push(status);
        }

        // Count running vs stopped
        const running = serviceStatuses.filter((s) => s.status === 'running').length;
        const stopped = serviceStatuses.filter((s) => s.status === 'stopped').length;

        const response = {
          server: serverName,
          timestamp: new Date().toISOString(),
          total: serviceStatuses.length,
          running,
          stopped,
          services: serviceStatuses,
          overall_health:
            stopped === 0
              ? HEALTH_STATUS.HEALTHY
              : running > stopped
                ? HEALTH_STATUS.WARNING
                : HEALTH_STATUS.CRITICAL,
        };

        logger.info('Service check completed', {
          server: serverName,
          running,
          stopped,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Service status check failed', {
          server: serverName,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Service status check failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_process_manager',
    {
      description:
        'Lists, inspects, or terminates processes on a remote server over SSH. The action parameter selects: list returns top processes (read-only), info returns details for one process (read-only), and kill sends a signal to terminate a process and mutates remote state. pid is required for kill and info. kill is blocked on servers configured as readonly. signal defaults to TERM, sortBy defaults to cpu, and limit defaults to 20; filter narrows the list by name or command.',
      inputSchema: {
        server: z.string().describe('Server name'),
        action: z
          .enum(['list', 'kill', 'info'])
          .describe('Action: list processes, kill process, or get process info'),
        pid: z.number().optional().describe('Process ID (required for kill and info actions)'),
        signal: z
          .enum(['TERM', 'KILL', 'HUP', 'INT', 'QUIT'])
          .optional()
          .describe('Signal to send when killing (default: TERM)'),
        sortBy: z
          .enum(['cpu', 'memory'])
          .optional()
          .describe('Sort processes by CPU or memory (default: cpu)'),
        limit: z.number().optional().describe('Number of processes to return (default: 20)'),
        filter: z.string().optional().describe('Filter processes by name/command'),
      },
    },
    async ({
      server: serverName,
      action,
      pid,
      signal = 'TERM',
      sortBy = 'cpu',
      limit = 20,
      filter,
    }) => {
      // Only the `kill` action mutates remote state — gate just that branch so
      // operators on readonly servers can still `list` / `info` processes.
      if (action === 'kill') {
        const denied = await applyServerPolicy(serverName, 'ssh_process_manager', {
          action,
          pid,
          signal,
        });
        if (denied) return denied;
      }
      try {
        const ssh = await getConnection(serverName);

        logger.info(`Process manager action: ${action}`, {
          server: serverName,
          pid,
          filter,
        });

        let response;

        switch (action) {
          case 'list': {
            const listCommand = buildProcessListCommand({ sortBy, limit, filter });
            const result = await ssh.execCommand(listCommand);

            if (result.code !== 0) {
              throw new Error(`Failed to list processes: ${result.stderr}`);
            }

            const processes = parseProcessList(result.stdout);

            response = {
              server: serverName,
              action: 'list',
              count: processes.length,
              sorted_by: sortBy,
              processes,
            };
            break;
          }

          case 'kill': {
            if (!pid) {
              throw new Error('pid parameter required for kill action');
            }

            // Get process info first
            const infoCommand = buildProcessInfoCommand(pid);
            const infoResult = await ssh.execCommand(infoCommand);

            let processInfo = {};
            if (infoResult.code === 0 && infoResult.stdout) {
              try {
                processInfo = JSON.parse(infoResult.stdout);
              } catch (e) {
                // Process might not exist
              }
            }

            // Kill the process
            const killCommand = buildKillProcessCommand(pid, signal);
            const killResult = await ssh.execCommand(killCommand);

            if (killResult.code !== 0) {
              throw new Error(`Failed to kill process ${pid}: ${killResult.stderr}`);
            }

            response = {
              server: serverName,
              action: 'kill',
              pid,
              signal,
              process: processInfo,
              success: true,
            };

            logger.info(`Process killed: ${pid}`, {
              server: serverName,
              signal,
            });
            break;
          }

          case 'info': {
            if (!pid) {
              throw new Error('pid parameter required for info action');
            }

            const infoCommand = buildProcessInfoCommand(pid);
            const result = await ssh.execCommand(infoCommand);

            if (result.code !== 0 || !result.stdout) {
              throw new Error(`Process ${pid} not found`);
            }

            const processInfo = JSON.parse(result.stdout);

            response = {
              server: serverName,
              action: 'info',
              process: processInfo,
            };
            break;
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Process manager failed', {
          server: serverName,
          action,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Process manager failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_alert_setup',
    {
      description:
        'Configures and evaluates CPU, memory, and disk usage alert thresholds for a remote server. The action parameter selects: set writes the threshold config to /etc/ssh-manager-alerts.json on the remote host (mutating, may need write access to /etc, and is blocked on readonly servers); get reads back that config; check reads current metrics and compares them to stored thresholds. get and check are read-only. enabled defaults to true; check errors if no config exists yet.',
      inputSchema: {
        server: z.string().describe('Server name'),
        action: z
          .enum(['set', 'get', 'check'])
          .describe(
            'Action: set thresholds, get config, or check current metrics against thresholds'
          ),
        cpuThreshold: z.number().optional().describe('CPU usage threshold percentage (e.g., 80)'),
        memoryThreshold: z
          .number()
          .optional()
          .describe('Memory usage threshold percentage (e.g., 90)'),
        diskThreshold: z.number().optional().describe('Disk usage threshold percentage (e.g., 85)'),
        enabled: z.boolean().optional().describe('Enable or disable alerts (default: true)'),
      },
    },
    async ({
      server: serverName,
      action,
      cpuThreshold,
      memoryThreshold,
      diskThreshold,
      enabled = true,
    }) => {
      // `set` writes config on the remote; `get` and `check` are read-only.
      if (action === 'set') {
        const denied = await applyServerPolicy(serverName, 'ssh_alert_setup', {
          action,
          cpuThreshold,
          memoryThreshold,
          diskThreshold,
          enabled,
        });
        if (denied) return denied;
      }
      try {
        const ssh = await getConnection(serverName);
        const configPath = '/etc/ssh-manager-alerts.json';

        logger.info(`Alert setup action: ${action}`, {
          server: serverName,
        });

        let response;

        switch (action) {
          case 'set': {
            // Create alert configuration
            const config = createAlertConfig({
              cpu: cpuThreshold,
              memory: memoryThreshold,
              disk: diskThreshold,
              enabled,
            });

            // Save to server
            const saveCommand = buildSaveAlertConfigCommand(config, configPath);
            const saveResult = await ssh.execCommand(saveCommand);

            if (saveResult.code !== 0) {
              throw new Error(`Failed to save alert config: ${saveResult.stderr}`);
            }

            response = {
              server: serverName,
              action: 'set',
              config,
              config_path: configPath,
              success: true,
            };

            logger.info('Alert thresholds configured', {
              server: serverName,
              thresholds: config,
            });
            break;
          }

          case 'get': {
            // Load configuration
            const loadCommand = buildLoadAlertConfigCommand(configPath);
            const result = await ssh.execCommand(loadCommand);

            let config = {};
            if (result.stdout && result.stdout.trim()) {
              try {
                config = JSON.parse(result.stdout);
              } catch (e) {
                config = { error: 'Failed to parse config' };
              }
            }

            response = {
              server: serverName,
              action: 'get',
              config,
              config_path: configPath,
            };
            break;
          }

          case 'check': {
            // Load thresholds
            const loadCommand = buildLoadAlertConfigCommand(configPath);
            const loadResult = await ssh.execCommand(loadCommand);

            // any: reassigned from JSON.parse below; .enabled is read off it.
            let thresholds: any = {};
            if (loadResult.stdout && loadResult.stdout.trim()) {
              try {
                thresholds = JSON.parse(loadResult.stdout);
              } catch (e) {
                throw new Error('No alert configuration found. Use action=set to configure.');
              }
            } else {
              throw new Error('No alert configuration found. Use action=set to configure.');
            }

            if (!thresholds.enabled) {
              response = {
                server: serverName,
                action: 'check',
                message: 'Alerts are disabled',
                thresholds,
              };
              break;
            }

            // Get current metrics
            const healthCommand = buildComprehensiveHealthCheckCommand();
            const healthResult = await ssh.execCommand(healthCommand);

            if (healthResult.code !== 0) {
              throw new Error('Failed to get current metrics');
            }

            const metrics = parseComprehensiveHealthCheck(healthResult.stdout);

            // Check thresholds
            const alerts = checkAlertThresholds(metrics, thresholds);

            response = {
              server: serverName,
              action: 'check',
              thresholds,
              current_metrics: {
                cpu: metrics.cpu,
                memory: metrics.memory,
                disks: metrics.disks,
              },
              alerts,
              alert_count: alerts.length,
              status: alerts.length === 0 ? 'ok' : 'alerts_triggered',
            };

            if (alerts.length > 0) {
              logger.warn('Health alerts triggered', {
                server: serverName,
                alert_count: alerts.length,
                alerts,
              });
            }
            break;
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Alert setup failed', {
          server: serverName,
          action,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Alert setup failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // ============================================================================
  // DATABASE MANAGEMENT TOOLS
  // ============================================================================
}
