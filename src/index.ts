#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import SSHManager from './ssh-manager.ts';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { ServerConfigManager } from './server-config-manager.ts';
import { resolveServer, listAliases } from './server-aliases.ts';
import { formatJSONResponse } from './config.ts';
import { initializeHooks, executeHook } from './hooks-system.ts';
import { getActiveProfileName } from './profile-loader.ts';
import { logger } from './logger.ts';
import { setServerConfigProvider } from './server-groups.ts';
import { loadToolConfig, isToolEnabled } from './tool-config-manager.ts';
import { evaluatePolicy } from './policy.ts';
import { auditLog } from './audit.ts';
import type { ToolContext } from './tool-registry.ts';
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
// 2. ~/.ssh4agent/.env (user config dir — where ssh4agent CLI writes)
// 3. ~/.ssh-manager/.env (legacy dir, read-only fallback)
// 4. process.cwd()/.env (standard working directory)
// 5. ~/.env (home directory)
// 6. __dirname/../.env (backward compat for local installs)
function resolveEnvFilePath() {
  if (process.env.SSH_ENV_PATH) {
    return process.env.SSH_ENV_PATH;
  }
  const home = process.env.SSH4AGENT_HOME || path.join(os.homedir(), '.ssh4agent');
  const legacyHome = path.join(os.homedir(), '.ssh-manager');
  const candidates = [
    path.join(home, '.env'),
    path.join(legacyHome, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (candidate === path.join(legacyHome, '.env')) {
        console.error(
          `ℹ️ Using legacy config ${candidate} — move it to ${path.join(home, '.env')} to migrate`
        );
      }
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
logger.info('MCP SSH4Agent starting', {
  logLevel: getRuntimeEnv('SSH_LOG_LEVEL') || 'INFO',
  verbose: getRuntimeEnv('SSH_VERBOSE') === 'true',
  envFilePath,
});

// Load SSH server configuration
const serverConfigManager = new ServerConfigManager({
  envPath: envFilePath,
  tomlPath: getRuntimeEnv('SSH_CONFIG_PATH'),
  preferToml: getRuntimeEnv('PREFER_TOML_CONFIG') === 'true',
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
  logger.info(
    `Tool configuration loaded: ${summary.mode} mode, ${summary.enabledCount}/${summary.totalTools} tools enabled`
  );
  if (summary.mode === 'all') {
    logger.info('💡 Tip: Run "ssh4agent tools configure" to reduce context usage in Claude Code');
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

// Single resolution path for "name or alias → { name, config }". Every config
// consumer (getServerConfig, getConnection, tools) goes through this — a bare
// `servers[name]` lookup skips alias expansion and lets an alias bypass the
// server's policy (issue #1).
async function resolveServerEntry(serverName) {
  if (!serverName) return null;
  const servers = await loadServerConfig();
  return resolveServer(serverName, servers);
}

async function getServerConfig(serverName) {
  const resolved = await resolveServerEntry(serverName);
  return resolved?.config || null;
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
async function execCommandWithTimeout(
  ssh: any,
  command: string,
  options: {
    rawCommand?: boolean;
    platform?: string;
    execOptions?: Record<string, any>;
    [key: string]: any;
  } = {},
  timeoutMs = 30000
) {
  // Pass through rawCommand and platform if specified
  const { rawCommand, platform = 'linux', ...otherOptions } = options;

  // Windows targets: encode the command as PowerShell -EncodedCommand (UTF-16
  // LE base64). This is the standard approach (used by Ansible / Chef / Puppet)
  // because cmd.exe's quoting rules are inconsistent across versions and break
  // commands containing $vars, $(...) subexpressions, double-quoted strings,
  // pipes, etc. Base64 sidesteps all escape issues entirely.
  if (platform === 'windows' && !rawCommand) {
    // Suppress progress (avoids CLIXML sentinels in stderr) + force UTF-8 stdout
    const prelude =
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
    const fullPSCommand = `${prelude} ${command}`;
    const utf16le = Buffer.from(fullPSCommand, 'utf16le');
    const b64 = utf16le.toString('base64');
    // -OutputFormat Text prevents stderr/info streams from being CLIXML-encoded
    const wrappedCommand = `powershell -NoProfile -OutputFormat Text -EncodedCommand ${b64}`;
    return ssh.execCommand(wrappedCommand, {
      ...otherOptions,
      execOptions: { ...(otherOptions.execOptions || {}) },
    });
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
    const wrappedCommand = `timeout ${timeoutSeconds} sh -c '${command.replace(/'/g, "'\\''")}'`;

    try {
      const result = await ssh.execCommand(wrappedCommand, {
        ...otherOptions,
        timeout: timeoutMs + WRAPPED_COMMAND_TIMEOUT_GRACE_MS,
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
      logger.info(`Connection to ${serverName} timed out, closing`, {
        timeout: CONNECTION_TIMEOUT,
      });
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Cast: Node accepts a {readable, writable} pair here, but the bundled
    // types only model the stream/iterable overloads.
    const socket = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
      allowHalfOpen: false,
    } as any);

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
        settle(
          reject,
          new Error(`Proxy command exited with code ${code}${signal ? ` (${signal})` : ''}`)
        );
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

  // Resolve through the single resolution interface (alias → name → prefix →
  // domain), so connections and policy always see the same canonical server.
  const resolved = resolveServer(serverName, servers);

  if (!resolved) {
    const availableServers = Object.keys(servers);
    const aliases = listAliases();
    const aliasInfo =
      aliases.length > 0
        ? ` Aliases: ${aliases.map((a) => `${a.alias}->${a.target}`).join(', ')}`
        : '';
    throw new Error(
      `Server "${serverName}" not found. Available servers: ${availableServers.join(', ') || 'none'}.${aliasInfo}`
    );
  }

  const normalizedName = resolved.name;

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
  const serverConfig = resolved.config;
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
        '127.0.0.1',
        0,
        serverConfig.host,
        serverConfig.port || 22
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
      proxyCommand: serverConfig.proxyCommand ? '<set>' : null,
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
  name: 'ssh4agent',
  version: serverVersion,
});

logger.info('MCP Server initialized', { version: serverVersion });

function registerToolConditional(
  toolName: string,
  schema: any,
  handler: (args: any, extra?: any) => any
) {
  if (isToolEnabled(toolName)) {
    // Cast: registerTool infers its handler signature from the zod schema, which
    // this generic wrapper cannot express while staying one helper for 37 tools.
    server.registerTool(toolName, schema, handler as any);
    logger.debug(`Registered tool: ${toolName}`);
  } else {
    logger.debug(`Skipped disabled tool: ${toolName}`);
  }
}

// Register available tools

// ── Tool registration ────────────────────────────────────────────────────────
// Tool definitions live in src/tools/<group>.ts (37 tools, 6 groups — see
// src/tool-registry.ts), loaded natively via Node type stripping. Each group
// module receives this shared runtime context instead of importing it, keeping
// the tool files free of circular dependencies on this entry point.
const toolContext: ToolContext = {
  register: registerToolConditional,
  getConnection,
  closeConnection,
  execCommandWithTimeout,
  loadServerConfig,
  resolveServer: resolveServerEntry,
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

  console.error('🚀 MCP SSH4Agent Server started');
  console.error(`📦 Profile: ${activeProfile}`);
  console.error(
    `🖥️  Available servers: ${serverList.length > 0 ? serverList.join(', ') : 'none configured'}`
  );
  console.error('💡 Use "ssh4agent server add" (or edit ~/.ssh4agent/.env) to configure servers');
  console.error('🔄 Connection management: Auto-reconnect enabled, 30min timeout');

  // Set up periodic cleanup of old connections (every 10 minutes).
  // unref() so this timer alone never keeps the process alive after the
  // stdio transport has closed.
  const cleanupTimer = setInterval(
    () => {
      cleanupOldConnections();
    },
    10 * 60 * 1000
  );
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

main().catch(console.error);
