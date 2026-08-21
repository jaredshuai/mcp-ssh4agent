#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import SSHManager from './ssh-manager.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { ServerConfigManager } from './server-config-manager.js';
import {
  getTempFilename,
  buildDeploymentStrategy,
  detectDeploymentNeeds
} from './deploy-helper.js';
import {
  resolveServerName,
  addAlias,
  removeAlias,
  listAliases
} from './server-aliases.js';
import {
  expandCommandAlias,
  addCommandAlias,
  removeCommandAlias,
  listCommandAliases,
  suggestAliases
} from './command-aliases.js';
import {
  TIMEOUTS,
  truncateOutput,
  formatJSONResponse
} from './config.js';
import {
  initializeHooks,
  executeHook,
  toggleHook,
  listHooks
} from './hooks-system.js';
import {
  loadProfile,
  listProfiles,
  setActiveProfile,
  getActiveProfileName
} from './profile-loader.js';
import { logger } from './logger.js';
import { shSingleQuote, buildCdPrefix, buildSudoPipeline } from './shell-quote.js';
import { parseRsyncStats } from './rsync-stats.js';
import { toRsyncLocalPath } from './rsync-path.js';
import {
  createSession,
  getSession,
  listSessions,
  closeSession
} from './session-manager.js';
import {
  setServerConfigProvider,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addServersToGroup,
  removeServersFromGroup,
  listGroups,
  executeOnGroup
} from './server-groups.js';
import {
  createTunnel,
  listTunnels,
  closeTunnel,
  closeServerTunnels
} from './tunnel-manager.js';
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
  extractHostFromSSHError
} from './ssh-key-manager.js';
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
  buildCronScheduleCommand
} from './backup-manager.js';
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
  resolveServiceName
} from './health-monitor.js';
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
  formatBytes
} from './database-manager.js';
import { loadToolConfig, isToolEnabled } from './tool-config-manager.js';
import { evaluatePolicy } from './policy.js';
import { auditLog } from './audit.js';
import { registerCoreTools } from './tools/core.ts';
import { registerSessionsTools } from './tools/sessions.ts';
import { registerMonitoringTools } from './tools/monitoring.ts';
import { registerBackupTools } from './tools/backup.ts';
import { registerDatabaseTools } from './tools/database.ts';
import { registerAdvancedTools } from './tools/advanced.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve .env file path with fallback chain:
// 1. SSH_ENV_PATH env var (explicit override)
// 2. ~/.ssh-manager/.env (user config dir — where ssh-manager CLI writes)
// 3. process.cwd()/.env (standard working directory)
// 4. ~/.env (home directory)
// 5. __dirname/../.env (backward compat for local installs)
function resolveEnvFilePath() {
  if (process.env.SSH_ENV_PATH) {
    return process.env.SSH_ENV_PATH;
  }
  const sshManagerHome = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  const candidates = [
    path.join(sshManagerHome, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(process.cwd(), '.env');
}

const envFilePath = resolveEnvFilePath();
const envFile = dotenv.config({ path: envFilePath, processEnv: {} });
const envFileValues = envFile.parsed || {};

function getRuntimeEnv(name) {
  return process.env[name] ?? envFileValues[name];
}

// Initialize logger
logger.info('MCP SSH Manager starting', {
  logLevel: getRuntimeEnv('SSH_LOG_LEVEL') || 'INFO',
  verbose: getRuntimeEnv('SSH_VERBOSE') === 'true',
  envFilePath
});

// Load SSH server configuration
const serverConfigManager = new ServerConfigManager({
  envPath: envFilePath,
  tomlPath: getRuntimeEnv('SSH_CONFIG_PATH'),
  preferToml: getRuntimeEnv('PREFER_TOML_CONFIG') === 'true'
});

// Let the group layer read the loaded servers, so groups can be derived from
// each server's `group` field (and so the 'all' group also sees TOML servers).
setServerConfigProvider(() => serverConfigManager.servers);

try {
  const loadedServers = await serverConfigManager.loadInitial();
  logger.info(`Loaded ${Object.keys(loadedServers).length} SSH server configurations`);
} catch (error) {
  logger.error('Failed to load server configuration', { error: error.message });
}

// Initialize hooks system
try {
  await initializeHooks();
} catch (error) {
  logger.error('Failed to initialize hooks', { error: error.message });
}

// Load tool configuration
let toolConfig = null;
try {
  toolConfig = await loadToolConfig();
  const summary = toolConfig.getSummary();
  logger.info(`Tool configuration loaded: ${summary.mode} mode, ${summary.enabledCount}/${summary.totalTools} tools enabled`);
  if (summary.mode === 'all') {
    logger.info('💡 Tip: Run "ssh-manager tools configure" to reduce context usage in Claude Code');
  }
} catch (error) {
  logger.error('Failed to load tool configuration', { error: error.message });
  logger.info('Using default configuration (all tools enabled)');
}

// Map to store active connections
const connections = new Map();

// Map to store connection timestamps for timeout management
const connectionTimestamps = new Map();

// Connection timeout in milliseconds (30 minutes)
const CONNECTION_TIMEOUT = 30 * 60 * 1000;

// Keepalive interval in milliseconds (5 minutes)
const KEEPALIVE_INTERVAL = 5 * 60 * 1000;

// Map to store keepalive intervals
const keepaliveIntervals = new Map();

// Extra grace window so the remote `timeout` wrapper can exit cleanly
// and return its timeout exit code before the local SSH exec timeout fires.
const WRAPPED_COMMAND_TIMEOUT_GRACE_MS = 5000;

// Map to track proxy jump dependencies (target -> jump server)
const jumpDependencies = new Map();

// Load server configuration (backward compatibility wrapper)
async function loadServerConfig() {
  // This function is kept for backward compatibility
  return serverConfigManager.getServers();
}

// ── Per-server security policy plumbing (v3.5.0+) ──────────────────────────────
//
// Wire any handler that mutates remote state (or executes arbitrary commands)
// through the helpers below. They are *always* safe to call: for any server
// without a security mode configured (default `unrestricted`), evaluatePolicy()
// early-returns { allowed: true } and auditLog() is a no-op when AUDIT_LOG is
// absent — so pre-v3.5.0 configs see zero behavior change.

async function getServerConfig(serverName) {
  if (!serverName) return null;
  const servers = await loadServerConfig();
  return servers[String(serverName).toLowerCase()] || null;
}

// Apply policy + audit a denial in one shot. Returns null when allowed; returns
// an MCP error response object when denied (handler should `return` it directly).
async function applyServerPolicy(serverName, toolName, args, command) {
  const serverConfig = await getServerConfig(serverName);
  const policy = evaluatePolicy(serverConfig, toolName, command);
  if (!policy.allowed) {
    auditLog(serverConfig, toolName, args, policy);
    return {
      content: [
        {
          type: 'text',
          text: formatJSONResponse({
            server: serverName,
            tool: toolName,
            success: false,
            error: `Policy denied: ${policy.reason}`,
            code: -2,
          }),
        },
      ],
      isError: true,
    };
  }
  return null;
}

// Convenience for the success-path audit: handlers call this after execution to
// record the outcome. No-op when AUDIT_LOG is not configured.
async function auditOk(serverName, toolName, args, executionResult) {
  const serverConfig = await getServerConfig(serverName);
  auditLog(serverConfig, toolName, args, { allowed: true }, executionResult);
}

// Execute command with timeout - using child_process timeout for real kill
/**
 * @param {any} ssh
 * @param {string} command
 * @param {{rawCommand?: boolean, platform?: string, execOptions?: Record<string, any>,
 *   [key: string]: any}} [options]
 * @param {number} [timeoutMs]
 */
async function execCommandWithTimeout(ssh, command, options = {}, timeoutMs = 30000) {
  // Pass through rawCommand and platform if specified
  const { rawCommand, platform = 'linux', ...otherOptions } = options;

  // Windows targets: encode the command as PowerShell -EncodedCommand (UTF-16
  // LE base64). This is the standard approach (used by Ansible / Chef / Puppet)
  // because cmd.exe's quoting rules are inconsistent across versions and break
  // commands containing $vars, $(...) subexpressions, double-quoted strings,
  // pipes, etc. Base64 sidesteps all escape issues entirely.
  if (platform === 'windows' && !rawCommand) {
    // Suppress progress (avoids CLIXML sentinels in stderr) + force UTF-8 stdout
    const prelude = '$ProgressPreference=\'SilentlyContinue\'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';
    const fullPSCommand = `${prelude} ${command}`;
    const utf16le = Buffer.from(fullPSCommand, 'utf16le');
    const b64 = utf16le.toString('base64');
    // -OutputFormat Text prevents stderr/info streams from being CLIXML-encoded
    const wrappedCommand = `powershell -NoProfile -OutputFormat Text -EncodedCommand ${b64}`;
    return ssh.execCommand(wrappedCommand, { ...otherOptions, execOptions: { ...(otherOptions.execOptions || {}) } });
  }

  // For commands that might hang, use the system's timeout command if available.
  // Note: the `!isWindows` guard that existed here previously is intentionally
  // removed. Windows targets return early above (the `if (platform === 'windows'
  // && !rawCommand)` block), so by the time execution reaches this line it is
  // guaranteed to be a Linux/macOS target. The behaviour is identical; the old
  // guard was made redundant by the early-return path.
  const useSystemTimeout = timeoutMs > 0 && timeoutMs < 300000 && !rawCommand; // Max 5 minutes, not for raw commands

  if (useSystemTimeout) {
    // Wrap command with timeout command (works on Linux/Mac)
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    const wrappedCommand = `timeout ${timeoutSeconds} sh -c '${command.replace(/'/g, '\'\\\'\'')}'`;

    try {
      const result = await ssh.execCommand(wrappedCommand, {
        ...otherOptions,
        timeout: timeoutMs + WRAPPED_COMMAND_TIMEOUT_GRACE_MS
      });

      // Check if timeout occurred (exit code 124 on Linux, 124 or 143 on Mac)
      if (result.code === 124 || result.code === 143) {
        throw new Error(`Command timeout after ${timeoutMs}ms: ${command.substring(0, 100)}...`);
      }

      return result;
    } catch (error) {
      // If timeout occurred, remove connection from pool
      if (error.message.includes('timeout')) {
        invalidateConnection(ssh);
      }
      throw error;
    }
  } else {
    // No timeout or very long timeout, execute normally
    return ssh.execCommand(command, { ...options, timeout: timeoutMs });
  }
}

// Check if a connection is still valid
async function isConnectionValid(ssh) {
  try {
    return await ssh.ping();
  } catch (error) {
    logger.debug('Connection validation failed', { error: error.message });
    return false;
  }
}

// Setup keepalive for a connection
function setupKeepalive(serverName, ssh) {
  // Clear existing keepalive if any
  if (keepaliveIntervals.has(serverName)) {
    clearInterval(keepaliveIntervals.get(serverName));
  }

  // Set up new keepalive interval
  const interval = setInterval(async () => {
    try {
      const isValid = await isConnectionValid(ssh);
      if (!isValid) {
        logger.warn(`Connection to ${serverName} lost, will reconnect on next use`);
        closeConnection(serverName);
      } else {
        // Update timestamp on successful keepalive
        connectionTimestamps.set(serverName, Date.now());
        logger.debug('Keepalive successful', { server: serverName });
      }
    } catch (error) {
      logger.error(`Keepalive failed for ${serverName}`, { error: error.message });
    }
  }, KEEPALIVE_INTERVAL);

  // Don't let the keepalive timer keep the process alive on its own. As a stdio
  // MCP server we must exit when our transport closes; an active interval would
  // otherwise pin the event loop and leave the process orphaned.
  if (typeof interval.unref === 'function') interval.unref();

  keepaliveIntervals.set(serverName, interval);
}

// Close a connection and clean up
function closeConnection(serverName) {
  const normalizedName = serverName.toLowerCase();

  // Clear keepalive interval
  if (keepaliveIntervals.has(normalizedName)) {
    clearInterval(keepaliveIntervals.get(normalizedName));
    keepaliveIntervals.delete(normalizedName);
  }

  // Close SSH connection
  const ssh = connections.get(normalizedName);
  if (ssh) {
    ssh.dispose();
    connections.delete(normalizedName);
  }

  // Remove timestamp
  connectionTimestamps.delete(normalizedName);

  // Clean up jump dependency tracking
  jumpDependencies.delete(normalizedName);

  logger.logConnection(serverName, 'closed');
}

// Remove a pooled connection by instance identity. Used when only the SSH
// handle is at hand (e.g. the command running on it timed out) rather than
// the server name it is pooled under. Delegates to closeConnection so the
// keepalive timer, timestamp and jump-dependency records are all cleaned
// up consistently — the inline cleanup this replaced missed jumpDependencies.
function invalidateConnection(ssh) {
  for (const [name, conn] of connections.entries()) {
    if (conn === ssh) {
      logger.warn(`Removing unhealthy connection for ${name}`);
      closeConnection(name);
      break;
    }
  }
}

// Clean up old connections
function cleanupOldConnections() {
  const now = Date.now();
  for (const [serverName, timestamp] of connectionTimestamps.entries()) {
    if (now - timestamp > CONNECTION_TIMEOUT) {
      logger.info(`Connection to ${serverName} timed out, closing`, { timeout: CONNECTION_TIMEOUT });
      closeConnection(serverName);
    }
  }
}

// Create a socket from a proxy command (e.g., "ncat --proxy 127.0.0.1:1080 --proxy-type socks5 %h %p")
// The command is executed through the system shell, matching OpenSSH ProxyCommand semantics,
// so quoted arguments and shell metacharacters work as users expect.
async function createProxyCommandSocket(proxyCommand, host, port) {
  const { spawn } = await import('child_process');
  const { Duplex } = await import('stream');

  const cmd = proxyCommand.replace(/%h/g, host).replace(/%p/g, port.toString());

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Cast: Node accepts a {readable, writable} pair here, but the bundled
    // types only model the stream/iterable overloads.
    const socket = Duplex.from(/** @type {any} */ ({
      readable: child.stdout,
      writable: child.stdin,
      allowHalfOpen: false
    }));

    // Forward proxy stderr to the MCP server's stderr for debugging
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[proxy-command] ${chunk}`);
    });

    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    socket.on('close', () => {
      if (!child.killed) child.kill();
    });

    child.on('error', (err) => settle(reject, err));
    child.on('spawn', () => settle(resolve, socket));
    child.on('exit', (code, signal) => {
      // Only surface unexpected exits — a kill() after a successful connection is normal.
      if (!settled && code !== 0) {
        settle(reject, new Error(`Proxy command exited with code ${code}${signal ? ` (${signal})` : ''}`));
      } else if (settled && code !== 0 && !signal && !socket.destroyed) {
        socket.destroy(new Error(`Proxy command exited with code ${code}`));
      }
    });
  });
}

// Get or create SSH connection with reconnection support
async function getConnection(serverName) {
  const servers = await loadServerConfig();

  // Execute pre-connect hook
  await executeHook('pre-connect', { server: serverName });

  // Try to resolve through aliases first
  const resolvedName = resolveServerName(serverName, servers);

  if (!resolvedName) {
    const availableServers = Object.keys(servers);
    const aliases = listAliases();
    const aliasInfo = aliases.length > 0 ?
      ` Aliases: ${aliases.map(a => `${a.alias}->${a.target}`).join(', ')}` : '';
    throw new Error(
      `Server "${serverName}" not found. Available servers: ${availableServers.join(', ') || 'none'}.${aliasInfo}`
    );
  }

  const normalizedName = resolvedName;

  // Check if we have an existing connection
  if (connections.has(normalizedName)) {
    const existingSSH = connections.get(normalizedName);

    // Verify the connection is still valid
    const isValid = await isConnectionValid(existingSSH);

    if (isValid) {
      // Update timestamp and return existing connection
      connectionTimestamps.set(normalizedName, Date.now());
      return existingSSH;
    } else {
      // Connection is dead, remove it
      logger.info(`Connection to ${serverName} lost, reconnecting`);
      closeConnection(normalizedName);
    }
  }

  // Create new connection
  const serverConfig = servers[normalizedName];
  const ssh = new SSHManager(serverConfig);

  try {
    if (serverConfig.proxyJump) {
      const jumpServerName = serverConfig.proxyJump.toLowerCase();

      // Validate jump server exists
      if (!servers[jumpServerName]) {
        throw new Error(
          `Proxy jump server "${serverConfig.proxyJump}" not found. ` +
          `Available servers: ${Object.keys(servers).join(', ')}`
        );
      }

      // Detect circular proxy jumps
      const visited = new Set([normalizedName]);
      let current = jumpServerName;
      while (current) {
        if (visited.has(current)) {
          throw new Error(`Circular proxy jump detected: ${[...visited, current].join(' -> ')}`);
        }
        visited.add(current);
        current = servers[current]?.proxyJump?.toLowerCase() || null;
      }

      // Connect to jump server (recursive — handles chained jumps)
      const jumpSSH = await getConnection(serverConfig.proxyJump);

      // Create forwarded stream through the jump server
      const stream = await jumpSSH.forwardOut(
        '127.0.0.1', 0,
        serverConfig.host, serverConfig.port || 22
      );

      // Connect target through the forwarded stream
      await ssh.connect({ sock: stream });
      jumpDependencies.set(normalizedName, jumpServerName);
      ssh.jumpConnection = jumpSSH;
    } else if (serverConfig.proxyCommand) {
      // Create socket via proxy command (e.g., SOCKS5 proxy)
      const socket = await createProxyCommandSocket(
        serverConfig.proxyCommand,
        serverConfig.host,
        serverConfig.port || 22
      );
      await ssh.connect({ sock: socket });
    } else {
      await ssh.connect();
    }

    connections.set(normalizedName, ssh);
    connectionTimestamps.set(normalizedName, Date.now());

    // Setup keepalive
    setupKeepalive(normalizedName, ssh);

    logger.logConnection(serverName, 'established', {
      host: serverConfig.host,
      port: serverConfig.port,
      method: serverConfig.password ? 'password' : 'key',
      proxyJump: serverConfig.proxyJump || null,
      proxyCommand: serverConfig.proxyCommand ? '<set>' : null
    });

    // Execute post-connect hook
    await executeHook('post-connect', { server: serverName });
  } catch (error) {
    logger.logConnection(serverName, 'failed', { error: error.message });
    // Execute error hook
    await executeHook('on-error', { server: serverName, error: error.message });
    throw new Error(`Failed to connect to ${serverName}: ${error.message}`);
  }

  return connections.get(normalizedName);
}

// Server version reported to MCP clients — derived from package.json so it
// always reflects the real build instead of a literal that drifts across
// releases. Resolves both in-repo (src/../package.json) and installed, since
// package.json always sits at the package root.
function getServerVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    if (version) return version;
  } catch (error) {
    logger.warn('Could not read version from package.json', { error: error.message });
  }

  return '0.0.0-unknown';
}

// Create MCP server
const serverVersion = getServerVersion();
const server = new McpServer({
  name: 'mcp-ssh-manager',
  version: serverVersion,
});

logger.info('MCP Server initialized', { version: serverVersion });

/**
 * Helper function to conditionally register tools based on configuration
 * @param {string} toolName - Name of the tool
 * @param {any} schema - Tool schema (description + zod inputSchema)
 * @param {(args: any, extra?: any) => any} handler - Tool handler function
 */
function registerToolConditional(toolName, schema, handler) {
  if (isToolEnabled(toolName)) {
    // Cast: registerTool infers its handler signature from the zod schema, which
    // this generic wrapper cannot express while staying one helper for 37 tools.
    server.registerTool(toolName, schema, /** @type {any} */ (handler));
    logger.debug(`Registered tool: ${toolName}`);
  } else {
    logger.debug(`Skipped disabled tool: ${toolName}`);
  }
}

// Register available tools

// ── Tool registration ────────────────────────────────────────────────────────
// Tool definitions live in src/tools/<group>.ts (37 tools, 6 groups — see
// src/tool-registry.js), loaded natively via Node type stripping. Each group
// module receives this shared runtime context instead of importing it, keeping
// the tool files free of circular dependencies on this entry point.
const toolContext = {
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
};

registerCoreTools(toolContext);
registerSessionsTools(toolContext);
registerMonitoringTools(toolContext);
registerBackupTools(toolContext);
registerDatabaseTools(toolContext);
registerAdvancedTools(toolContext);

let isShuttingDown = false;
function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`\n🔌 Closing SSH connections (${reason})...`);
  for (const [name, ssh] of connections) {
    try {
      ssh.dispose();
      console.error(`  Closed connection to ${name}`);
    } catch (error) {
      console.error(`  Error closing ${name}: ${error.message}`);
    }
  }
  // Best-effort flush of any final stdout the host may still read, but never
  // hang if it has already stopped reading: a short unref'd timer forces exit
  // regardless, so this can't reintroduce a stuck process.
  const force = setTimeout(() => process.exit(0), 250);
  if (typeof force.unref === 'function') force.unref();
  process.stdout.write('', () => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
// When launched as a stdio MCP server the host closes our stdin to signal
// teardown; treat that EOF as a shutdown request. 'end' fires when the readable
// side is fully consumed; 'close' covers the fd being torn down without a clean
// 'end'. The idempotent guard above makes the overlap harmless.
process.stdin.on('end', () => shutdown('stdin ended'));
process.stdin.on('close', () => shutdown('stdin closed'));

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const servers = await loadServerConfig();
  const serverList = Object.keys(servers);
  const activeProfile = getActiveProfileName();

  console.error('🚀 MCP SSH Manager Server started');
  console.error(`📦 Profile: ${activeProfile}`);
  console.error(`🖥️  Available servers: ${serverList.length > 0 ? serverList.join(', ') : 'none configured'}`);
  console.error('💡 Use server-manager.py to configure servers');
  console.error('🔄 Connection management: Auto-reconnect enabled, 30min timeout');

  // Set up periodic cleanup of old connections (every 10 minutes).
  // unref() so this timer alone never keeps the process alive after the
  // stdio transport has closed.
  const cleanupTimer = setInterval(() => {
    cleanupOldConnections();
  }, 10 * 60 * 1000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

main().catch(console.error);
