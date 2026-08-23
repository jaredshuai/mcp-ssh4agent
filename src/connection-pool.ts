/**
 * ConnectionPool — the deep module owning every live SSH connection.
 *
 * Before this module existed the pool was four raw Maps (`connections`,
 * `connectionTimestamps`, `keepaliveIntervals`, `jumpDependencies`) living in
 * the entry point and leaked into all six tool modules through ToolContext.
 * The pool's cleanup invariant (timestamp + keepalive timer + jump dependency
 * must be cleared together) had a single guardian (closeConnection) that tool
 * code could — and did — bypass (issue #3).
 *
 * Everything about connection lifetime is now private to this class:
 * reuse + revalidation, keepalive timers, proxyJump recursion with cycle
 * detection, ProxyCommand sockets, idle-age cleanup, and timeout-wrapped
 * command execution. Callers see four operations — get / close / invalidate /
 * status — plus exec (timeout-wrapped execution that can evict a hung
 * connection) and sweep/cleanupAged/disposeAll for lifecycle management.
 *
 * TypeScript run directly by Node (type stripping): private #fields and
 * optional params only — no enums, namespaces, or parameter properties.
 */

import { resolveServer, listAliases } from './server-aliases.ts';
import { logger } from './logger.ts';

/** What the pool needs from a connection to manage its lifecycle. SSHManager
 * (src/ssh-manager.ts) satisfies this structurally; tests provide fakes. */
export interface PoolConnection {
  connect(options?: { sock?: any }): Promise<void>;
  ping(): Promise<boolean>;
  dispose(): void;
  forwardOut(srcAddr: string, srcPort: number, dstAddr: string, dstPort: number): Promise<any>;
  [key: string]: any; // SSHManager carries more (execCommand, sftp, ...); pool stays hands-off.
}

export interface ConnectionPoolOptions {
  /** Load the current servers table (resolved configs, keyed by name). */
  loadServers(): Promise<Record<string, any>>;
  /** Build a fresh (unconnected) connection for a resolved server config. */
  createConnection(serverConfig: any): PoolConnection;
  /** Hook bus (pre-connect / post-connect / on-error). Optional. */
  executeHook?(event: string, payload: any): unknown;
  connectionTimeoutMs?: number;
  keepaliveIntervalMs?: number;
}

// Idle lifetime of a pooled connection (30 minutes) and keepalive cadence
// (5 minutes). Single source of truth — previously duplicated between
// src/index.ts and a dead TIMEOUTS block in src/config.ts (issue #4).
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

// Extra grace window so the remote `timeout` wrapper can exit cleanly and
// return its timeout exit code before the local SSH exec timeout fires.
const WRAPPED_COMMAND_TIMEOUT_GRACE_MS = 5000;

export interface ConnectionStatusEntry {
  server: string;
  alive: boolean;
  /** Milliseconds since the connection was last used (or validated). */
  idleMs: number;
  keepalive: boolean;
  /** Name of the jump server this connection dials through, if any. */
  jumpServer: string | null;
}

export interface ConnectionPoolStatus {
  servers: ConnectionStatusEntry[];
  settings: {
    timeoutMinutes: number;
    keepaliveMinutes: number;
  };
}

export class ConnectionPool {
  #options: ConnectionPoolOptions;
  #connections = new Map<string, PoolConnection>();
  #timestamps = new Map<string, number>();
  #keepalives = new Map<string, ReturnType<typeof setInterval>>();
  #jumpDeps = new Map<string, string>();

  constructor(options: ConnectionPoolOptions) {
    this.#options = options;
  }

  get connectionTimeoutMs(): number {
    return this.#options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  get keepaliveIntervalMs(): number {
    return this.#options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  }

  /**
   * Get a live connection for `serverName` (name or alias), creating one if
   * needed. Pooled connections are revalidated with a ping before reuse;
   * dead ones are replaced transparently.
   */
  async get(serverName: string): Promise<PoolConnection> {
    const servers = await this.#options.loadServers();

    await Promise.resolve(this.#options.executeHook?.('pre-connect', { server: serverName }));

    const resolved = resolveServer(serverName, servers);
    if (!resolved) {
      const availableServers = Object.keys(servers);
      const aliases = listAliases();
      const aliasInfo =
        aliases.length > 0
          ? ` Aliases: ${aliases.map((a) => `${a.alias}->${a.target}`).join(', ')}`
          : '';
      throw new Error(
        `Server "${serverName}" not found. Available servers: ${
          availableServers.join(', ') || 'none'
        }.${aliasInfo}`
      );
    }

    const name = resolved.name;

    const existing = this.#connections.get(name);
    if (existing) {
      if (await this.#isAlive(existing)) {
        this.#timestamps.set(name, Date.now());
        return existing;
      }
      logger.info(`Connection to ${serverName} lost, reconnecting`);
      this.close(name);
    }

    const serverConfig = resolved.config;
    const ssh = this.#options.createConnection(serverConfig);

    try {
      if (serverConfig.proxyJump) {
        await this.#connectViaJump(name, serverConfig, servers, ssh);
      } else if (serverConfig.proxyCommand) {
        const { createProxyCommandSocket } = await import('./proxy-command.ts');
        const socket = await createProxyCommandSocket(
          serverConfig.proxyCommand,
          serverConfig.host,
          serverConfig.port || 22
        );
        await ssh.connect({ sock: socket });
      } else {
        await ssh.connect();
      }

      this.#connections.set(name, ssh);
      this.#timestamps.set(name, Date.now());
      this.#setupKeepalive(name, ssh);

      logger.logConnection(serverName, 'established', {
        host: serverConfig.host,
        port: serverConfig.port,
        method: serverConfig.password ? 'password' : 'key',
        proxyJump: serverConfig.proxyJump || null,
        proxyCommand: serverConfig.proxyCommand ? '<set>' : null,
      });

      await Promise.resolve(this.#options.executeHook?.('post-connect', { server: serverName }));
    } catch (error) {
      logger.logConnection(serverName, 'failed', { error: error.message });
      await Promise.resolve(
        this.#options.executeHook?.('on-error', {
          server: serverName,
          error: error.message,
        })
      );
      throw new Error(`Failed to connect to ${serverName}: ${error.message}`);
    }

    return ssh;
  }

  /** Dial `target` through its configured jump server (recursive for chains). */
  async #connectViaJump(
    name: string,
    serverConfig: any,
    servers: Record<string, any>,
    ssh: PoolConnection
  ) {
    const jumpServerName = serverConfig.proxyJump.toLowerCase();

    if (!servers[jumpServerName]) {
      throw new Error(
        `Proxy jump server "${serverConfig.proxyJump}" not found. ` +
          `Available servers: ${Object.keys(servers).join(', ')}`
      );
    }

    // Circular proxy jumps would recurse forever — walk the chain and refuse
    // any server already on the path.
    const visited = new Set([name]);
    let current: string | null = jumpServerName;
    while (current) {
      if (visited.has(current)) {
        throw new Error(`Circular proxy jump detected: ${[...visited, current].join(' -> ')}`);
      }
      visited.add(current);
      current = servers[current]?.proxyJump?.toLowerCase() || null;
    }

    const jumpSSH = await this.get(serverConfig.proxyJump);
    const stream = await jumpSSH.forwardOut(
      '127.0.0.1',
      0,
      serverConfig.host,
      serverConfig.port || 22
    );

    await ssh.connect({ sock: stream });
    this.#jumpDeps.set(name, jumpServerName);
    ssh.jumpConnection = jumpSSH;
  }

  /**
   * Close the connection pooled under `serverName` (case-insensitive) and
   * clear ALL of its bookkeeping — keepalive timer, timestamp, jump
   * dependency — in one place. This is the single guardian of the pool's
   * cleanup invariant.
   */
  close(serverName: string): void {
    const name = String(serverName).toLowerCase();

    const timer = this.#keepalives.get(name);
    if (timer) {
      clearInterval(timer);
      this.#keepalives.delete(name);
    }

    const ssh = this.#connections.get(name);
    if (ssh) {
      ssh.dispose();
      this.#connections.delete(name);
    }

    this.#timestamps.delete(name);
    this.#jumpDeps.delete(name);

    logger.logConnection(serverName, 'closed');
  }

  /**
   * Remove a pooled connection by instance identity — for when only the SSH
   * handle is at hand (e.g. the command running on it timed out). Delegates
   * to close() so the full invariant is preserved.
   */
  invalidate(conn: PoolConnection): void {
    for (const [name, pooled] of this.#connections.entries()) {
      if (pooled === conn) {
        logger.warn(`Removing unhealthy connection for ${name}`);
        this.close(name);
        break;
      }
    }
  }

  /** Whether a connection is pooled under this name (case-insensitive). */
  has(serverName: string): boolean {
    return this.#connections.has(String(serverName).toLowerCase());
  }

  /** Snapshot for display/monitoring; per-entry liveness is probed lazily. */
  async status(): Promise<ConnectionPoolStatus> {
    const now = Date.now();
    const servers: ConnectionStatusEntry[] = [];
    for (const [name, ssh] of this.#connections.entries()) {
      servers.push({
        server: name,
        alive: await this.#isAlive(ssh),
        idleMs: now - (this.#timestamps.get(name) || now),
        keepalive: this.#keepalives.has(name),
        jumpServer: this.#jumpDeps.get(name) || null,
      });
    }
    return {
      servers,
      settings: {
        timeoutMinutes: this.connectionTimeoutMs / 1000 / 60,
        keepaliveMinutes: this.keepaliveIntervalMs / 1000 / 60,
      },
    };
  }

  /** Close connections idle longer than the pool timeout. Returns count closed. */
  cleanupAged(): number {
    const now = Date.now();
    let closed = 0;
    for (const [name, timestamp] of this.#timestamps.entries()) {
      if (now - timestamp > this.connectionTimeoutMs) {
        logger.info(`Connection to ${name} timed out, closing`, {
          timeout: this.connectionTimeoutMs,
        });
        this.close(name);
        closed++;
      }
    }
    return closed;
  }

  /** Close aged-out AND dead connections. Returns count closed. */
  async sweep(): Promise<number> {
    const before = this.#connections.size;
    this.cleanupAged();
    for (const [name, ssh] of [...this.#connections.entries()]) {
      if (!(await this.#isAlive(ssh))) {
        this.close(name);
      }
    }
    return before - this.#connections.size;
  }

  /** Number of live entries (mostly for messages/tests). */
  get size(): number {
    return this.#connections.size;
  }

  /** Close everything (shutdown path). */
  disposeAll(): void {
    for (const [name, ssh] of this.#connections) {
      try {
        ssh.dispose();
        logger.logConnection(name, 'closed');
      } catch (error) {
        logger.warn(`Error closing ${name}: ${error.message}`);
      }
    }
    for (const timer of this.#keepalives.values()) clearInterval(timer);
    this.#connections.clear();
    this.#timestamps.clear();
    this.#keepalives.clear();
    this.#jumpDeps.clear();
  }

  async #isAlive(conn: PoolConnection): Promise<boolean> {
    try {
      return await conn.ping();
    } catch (error) {
      logger.debug('Connection validation failed', { error: error.message });
      return false;
    }
  }

  #setupKeepalive(name: string, ssh: PoolConnection): void {
    const existing = this.#keepalives.get(name);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      try {
        if (await this.#isAlive(ssh)) {
          this.#timestamps.set(name, Date.now());
          logger.debug('Keepalive successful', { server: name });
        } else {
          logger.warn(`Connection to ${name} lost, will reconnect on next use`);
          this.close(name);
        }
      } catch (error) {
        logger.error(`Keepalive failed for ${name}`, { error: error.message });
      }
    }, this.keepaliveIntervalMs);

    // A stdio MCP server must exit when its transport closes; an active
    // interval would otherwise pin the event loop and orphan the process.
    if (typeof interval.unref === 'function') interval.unref();

    this.#keepalives.set(name, interval);
  }
}

/**
 * Timeout-wrapped remote command execution with platform handling
 * (PowerShell -EncodedCommand for Windows targets, `timeout` wrapper
 * elsewhere). A timed-out command evicts its connection from the pool —
 * exported as a pool-aware function because eviction needs pool.invalidate.
 */
export async function execCommandWithTimeout(
  pool: ConnectionPool,
  ssh: PoolConnection,
  command: string,
  options: {
    rawCommand?: boolean;
    platform?: string;
    execOptions?: Record<string, any>;
    [key: string]: any;
  } = {},
  timeoutMs = 30000
) {
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
  // Windows targets returned early above, so this is Linux/macOS only.
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
        pool.invalidate(ssh);
      }
      throw error;
    }
  } else {
    // No timeout or very long timeout, execute normally
    return ssh.execCommand(command, { ...options, timeout: timeoutMs });
  }
}
