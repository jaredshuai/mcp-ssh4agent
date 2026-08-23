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
import { resolveServer } from './server-aliases.ts';
import { formatJSONResponse } from './config.ts';
import { initializeHooks, executeHook } from './hooks-system.ts';
import { getActiveProfileName } from './profile-loader.ts';
import { logger } from './logger.ts';
import { setServerConfigProvider } from './server-groups.ts';
import { loadToolConfig, isToolEnabled } from './tool-config-manager.ts';
import { evaluatePolicy } from './policy.ts';
import { auditLog } from './audit.ts';
import { ConnectionPool, execCommandWithTimeout } from './connection-pool.ts';
import { resolveEnvFilePath } from './env-path.ts';
import type { ToolContext, ToolPolicy } from './tool-registry.ts';
import { wrapWithPolicy } from './tool-registry.ts';
import { expandCommandAlias } from './command-aliases.ts';
import { registerCoreTools } from './tools/core.ts';
import { registerSessionsTools } from './tools/sessions.ts';
import { registerMonitoringTools } from './tools/monitoring.ts';
import { registerBackupTools } from './tools/backup.ts';
import { registerDatabaseTools } from './tools/database.ts';
import { registerAdvancedTools } from './tools/advanced.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve .env through the ONE shared fallback chain (src/env-path.ts) —
// the same chain the CLI uses, so both processes always agree on the file.
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

// Load server configuration (backward compatibility wrapper)
async function loadServerConfig() {
  // This function is kept for backward compatibility
  return serverConfigManager.getServers();
}

// ── Connection pool (deep module — src/connection-pool.ts) ────────────────────
// All pooling concerns (reuse, keepalive, jump chains, ProxyCommand, idle
// cleanup, timeout execution) live behind four operations plus lifecycle
// helpers; the raw Maps are private to the pool (issue #3).

const pool = new ConnectionPool({
  loadServers: () => loadServerConfig(),
  createConnection: (serverConfig) => new SSHManager(serverConfig),
  executeHook,
});

const getConnection = (serverName: string) => pool.get(serverName);
const closeConnection = (serverName: string) => pool.close(serverName);
const execWithTimeout = (ssh: any, command: string, options: any, timeoutMs: number) =>
  execCommandWithTimeout(pool, ssh, command, options, timeoutMs);
const cleanupOldConnections = () => pool.cleanupAged();

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
  handler: (args: any, extra?: any) => any,
  policy?: ToolPolicy
) {
  if (isToolEnabled(toolName)) {
    // The single registration funnel: policy gate + audit trail wrap every
    // handler according to its declaration (see wrapWithPolicy). Tools carry
    // business logic only (issue #6).
    const wrapped = wrapWithPolicy(toolName, handler, policy, {
      applyServerPolicy,
      auditOk,
      expandCommandAlias,
    });
    // Cast: registerTool infers its handler signature from the zod schema, which
    // this generic wrapper cannot express while staying one helper for 37 tools.
    server.registerTool(toolName, schema, wrapped as any);
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
  pool,
  getConnection,
  closeConnection,
  execCommandWithTimeout: execWithTimeout,
  loadServerConfig,
  resolveServer: resolveServerEntry,
  getServerConfig,
  applyServerPolicy,
  cleanupOldConnections,
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
  pool.disposeAll();
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
