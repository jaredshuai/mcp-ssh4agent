/**
 * SSH Tunnel Manager
 * Manages SSH port forwarding and SOCKS proxy tunnels
 */

import { randomUUID } from 'node:crypto';
import net from 'net';
import { logger } from './logger.ts';

// Map to store active tunnels
const tunnels = new Map();

/**
 * The seam between SSHTunnel and whatever SSH connection drives it.
 *
 * Signatures follow ssh2's Client (`forwardIn` / `unforwardIn` /
 * 'tcp connection'), not invented: before this interface existed the field
 * was `any`, so the remote-tunnel path called `forwardIn` on the SSHManager
 * wrapper — which never implemented it — and crashed at runtime with
 * `TypeError: forwardIn is not a function` (issue #2).
 *
 * Two implementations make the seam real: SSHManager (forwards to its
 * internal ssh2 Client) and the in-memory fake used by
 * tests/test-tunnel-remote.js.
 */
export interface TcpConnectionInfo {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
}

export interface TunnelableConnection {
  /** Local/dynamic forwarding: open a channel to dstAddr:dstPort. */
  forwardOut(srcAddr: string, srcPort: number, dstAddr: string, dstPort: number): Promise<any>;
  /** Remote forwarding: ask the server to listen on remoteAddr:remotePort. */
  forwardIn(remoteAddr: string, remotePort: number, callback?: (err?: Error) => void): unknown;
  /** Remove a remote forwarding request. */
  unforwardIn(remoteAddr: string, remotePort: number): unknown;
  /** Incoming remote-forwarded connections. */
  on(
    event: 'tcp connection',
    listener: (info: TcpConnectionInfo, accept: () => any) => void
  ): unknown;
  /** Detach a previously-registered listener (tunnel teardown /
   * re-registration on reconnect). MANDATORY: an adapter without it cannot
   * stop a closed tunnel from receiving later 'tcp connection' events. */
  removeListener(
    event: 'tcp connection',
    listener: (info: TcpConnectionInfo, accept: () => any) => void
  ): unknown;
}

/**
 * Bind a local server, rejecting when the bind fails.
 *
 * `net.Server#listen` does NOT pass an error to its callback — the callback
 * only ever fires on success. A failed bind (EADDRINUSE, the common case when
 * the requested tunnel port is already taken) surfaces as an `'error'` event
 * instead. With no listener for it, Node rethrows as an uncaught exception:
 * that used to kill the whole MCP server process, while the awaited promise
 * never settled either way.
 *
 * @param {import('net').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<void>}
 */
export function listenOrReject(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Tunnel types
const TUNNEL_TYPES = {
  LOCAL: 'local', // Local port forwarding (access remote service locally)
  REMOTE: 'remote', // Remote port forwarding (expose local service remotely)
  DYNAMIC: 'dynamic', // SOCKS proxy
};

// Tunnel states
const TUNNEL_STATES = {
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
  CLOSED: 'closed',
};

class SSHTunnel {
  id: string;
  serverName: string;
  // Anything that can drive tunnels: SSHManager wrapping ssh2, or the test fake.
  ssh: TunnelableConnection;
  type: string;
  // Tunnel config shape varies by type (local/remote/dynamic).
  config: any;
  state: string;
  // The 'tcp connection' handler registered on the connection (kept so
  // close() can detach it — a stale handler on a shared SSH connection
  // would fire on later, unrelated forwards).
  tcpHandler: ((info: TcpConnectionInfo, accept: () => any) => void) | null;
  createdAt: Date;
  lastActivity: Date;
  connections: Set<net.Socket>;
  server: net.Server | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  stats: {
    bytesTransferred: number;
    connectionsTotal: number;
    connectionsActive: number;
    errors: number;
  };

  constructor(id, serverName, ssh, config) {
    this.id = id;
    this.serverName = serverName;
    this.ssh = ssh;
    this.type = config.type;
    this.config = config;
    this.state = TUNNEL_STATES.CONNECTING;
    this.tcpHandler = null;
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.connections = new Set();
    this.server = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.stats = {
      bytesTransferred: 0,
      connectionsTotal: 0,
      connectionsActive: 0,
      errors: 0,
    };
  }

  /**
   * Start the tunnel
   */
  async start() {
    try {
      switch (this.type) {
        case TUNNEL_TYPES.LOCAL:
          await this.startLocalForwarding();
          break;

        case TUNNEL_TYPES.REMOTE:
          await this.startRemoteForwarding();
          break;

        case TUNNEL_TYPES.DYNAMIC:
          await this.startDynamicForwarding();
          break;

        default:
          throw new Error(`Unknown tunnel type: ${this.type}`);
      }

      this.state = TUNNEL_STATES.ACTIVE;
      this.lastActivity = new Date();

      logger.info(`SSH tunnel ${this.id} started`, {
        type: this.type,
        server: this.serverName,
        local: `${this.config.localHost}:${this.config.localPort}`,
        remote:
          this.type !== TUNNEL_TYPES.DYNAMIC
            ? `${this.config.remoteHost}:${this.config.remotePort}`
            : 'SOCKS',
      });
    } catch (error) {
      this.state = TUNNEL_STATES.FAILED;
      logger.error(`Failed to start tunnel ${this.id}`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Start local port forwarding
   */
  async startLocalForwarding() {
    const { localHost, localPort, remoteHost, remotePort } = this.config;

    // Create local server
    this.server = net.createServer(async (localSocket) => {
      this.stats.connectionsTotal++;
      this.stats.connectionsActive++;
      this.connections.add(localSocket);
      this.lastActivity = new Date();

      logger.debug(`New connection to tunnel ${this.id}`, {
        from: localSocket.remoteAddress,
      });

      try {
        // Forward to remote via SSH
        const stream = await this.ssh.forwardOut(
          localSocket.remoteAddress || '127.0.0.1',
          localSocket.remotePort || 0,
          remoteHost,
          remotePort
        );

        // Pipe data between local and remote
        localSocket.pipe(stream).pipe(localSocket);

        // Track data transfer
        localSocket.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });

        stream.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });

        // Handle disconnection — idempotent: error-then-close fires this
        // up to four times (close+error on BOTH sockets); without the
        // guard, connectionsActive undercounts or goes negative
        // (PR #9 r6).
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          this.stats.connectionsActive--;
          this.connections.delete(localSocket);
          localSocket.destroy();
          stream.destroy();
        };

        localSocket.on('close', cleanup);
        localSocket.on('error', cleanup);
        stream.on('close', cleanup);
        stream.on('error', cleanup);
      } catch (error) {
        this.stats.errors++;
        logger.error('Tunnel forwarding error', {
          tunnel: this.id,
          error: error.message,
        });
        // forwardOut failed: the increment above must not leak.
        this.stats.connectionsActive--;
        this.connections.delete(localSocket);
        localSocket.destroy();
      }
    });

    // Start listening
    await listenOrReject(this.server, localPort, localHost);

    logger.info('Local forwarding established', {
      local: `${localHost}:${localPort}`,
      remote: `${remoteHost}:${remotePort}`,
    });
  }

  /**
   * Start remote port forwarding
   */
  async startRemoteForwarding() {
    const { localHost, localPort, remoteHost, remotePort } = this.config;

    // Request remote forwarding from SSH server
    const forwarded = new Promise<void>((resolve, reject) => {
      this.ssh.forwardIn(remoteHost, remotePort, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await forwarded;

    // Handle incoming connections from remote (handler stored for teardown).
    // A reconnect runs start() → here again on the SAME emitter: detach the
    // handler a previous run registered first, or listeners accumulate and
    // every forwarded connection is dispatched (and accept()ed) once per
    // stale handler — close() could only ever detach the latest one
    // (PR #9 review).
    if (this.tcpHandler) {
      this.ssh.removeListener('tcp connection', this.tcpHandler);
    }
    this.tcpHandler = (info, accept) => {
      if (info.destPort !== remotePort) return;

      this.stats.connectionsTotal++;
      this.stats.connectionsActive++;
      this.lastActivity = new Date();

      const remoteSocket = accept();

      // Connect to local service
      const localSocket = net.connect(localPort, localHost, () => {
        // Pipe data between remote and local
        remoteSocket.pipe(localSocket).pipe(remoteSocket);

        // Track data transfer
        remoteSocket.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });

        localSocket.on('data', (chunk) => {
          this.stats.bytesTransferred += chunk.length;
          this.lastActivity = new Date();
        });
      });

      // Track both sockets so close() can terminate ESTABLISHED remote
      // forwards too — without this, closing the tunnel only cancelled
      // future forwards while live channels kept proxying traffic
      // (PR #9 review, round 4).
      this.connections.add(remoteSocket);
      this.connections.add(localSocket);

      // Handle errors and cleanup — idempotent: both 'close' events fire.
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        this.stats.connectionsActive--;
        this.connections.delete(remoteSocket);
        this.connections.delete(localSocket);
        remoteSocket.destroy();
        localSocket.destroy();
      };

      localSocket.on('error', (err) => {
        this.stats.errors++;
        logger.error('Remote forwarding error', {
          tunnel: this.id,
          error: err.message,
        });
        cleanup();
      });

      remoteSocket.on('close', cleanup);
      localSocket.on('close', cleanup);
    };
    this.ssh.on('tcp connection', this.tcpHandler);

    logger.info('Remote forwarding established', {
      local: `${localHost}:${localPort}`,
      remote: `${remoteHost}:${remotePort}`,
    });
  }

  /**
   * Start dynamic port forwarding (SOCKS proxy)
   */
  async startDynamicForwarding() {
    const { localHost, localPort } = this.config;

    // Create SOCKS server
    this.server = net.createServer(async (localSocket) => {
      this.stats.connectionsTotal++;
      this.stats.connectionsActive++;
      this.connections.add(localSocket);
      this.lastActivity = new Date();

      let targetHost = null;
      let targetPort = null;
      let stream = null;

      // Simple SOCKS5 implementation (basic)
      localSocket.once('data', async (chunk) => {
        // Parse SOCKS request (simplified)
        if (chunk[0] === 0x05) {
          // SOCKS5
          // Send auth method response
          localSocket.write(Buffer.from([0x05, 0x00]));

          localSocket.once('data', async (chunk2: Buffer) => {
            // Parse connection request
            if (chunk2[0] === 0x05 && chunk2[1] === 0x01) {
              // CONNECT
              const addrType = chunk2[3];
              let offset = 4;

              if (addrType === 0x01) {
                // IPv4
                targetHost = `${chunk2[4]}.${chunk2[5]}.${chunk2[6]}.${chunk2[7]}`;
                offset = 8;
              } else if (addrType === 0x03) {
                // Domain
                const domainLen = chunk2[4];
                targetHost = chunk2.slice(5, 5 + domainLen).toString();
                offset = 5 + domainLen;
              }

              targetPort = (chunk2[offset] << 8) | chunk2[offset + 1];

              try {
                // Create SSH forwarding stream
                stream = await this.ssh.forwardOut('127.0.0.1', 0, targetHost, targetPort);

                // Send success response
                const response = Buffer.from([
                  0x05,
                  0x00,
                  0x00,
                  0x01,
                  0,
                  0,
                  0,
                  0, // Bind address (0.0.0.0)
                  0,
                  0, // Bind port
                ]);
                localSocket.write(response);

                // Pipe data
                localSocket.pipe(stream).pipe(localSocket);

                // Track data
                localSocket.on('data', (chunk) => {
                  this.stats.bytesTransferred += chunk.length;
                  this.lastActivity = new Date();
                });

                stream.on('data', (chunk) => {
                  this.stats.bytesTransferred += chunk.length;
                  this.lastActivity = new Date();
                });
              } catch (error) {
                // Send error response
                const response = Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                localSocket.write(response);
                localSocket.destroy();
                this.stats.errors++;
              }
            }
          });
        } else {
          // Not SOCKS5, close connection
          localSocket.destroy();
        }
      });

      // Cleanup on disconnect — idempotent: an error emits 'error' AND
      // 'close', and both handlers decremented, driving connectionsActive
      // negative over time (PR #9 r6).
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        this.stats.connectionsActive--;
        this.connections.delete(localSocket);
        if (stream) stream.destroy();
      };

      localSocket.on('close', cleanup);

      localSocket.on('error', () => {
        this.stats.errors++;
        cleanup();
      });
    });

    // Start listening
    await listenOrReject(this.server, localPort, localHost);

    logger.info('SOCKS proxy established', {
      local: `${localHost}:${localPort}`,
    });
  }

  /**
   * Get tunnel information
   */
  getInfo() {
    return {
      id: this.id,
      server: this.serverName,
      type: this.type,
      state: this.state,
      config: {
        localHost: this.config.localHost,
        localPort: this.config.localPort,
        remoteHost: this.config.remoteHost,
        remotePort: this.config.remotePort,
      },
      stats: this.stats,
      created: this.createdAt,
      lastActivity: this.lastActivity,
      // Logical connection count (one forwarded connection = 1). The
      // socket set is for teardown only and holds BOTH ends of each
      // connection — reporting its size double-counted (PR #9 r5).
      activeConnections: this.stats.connectionsActive,
    };
  }

  /**
   * Close the tunnel
   */
  close() {
    logger.info(`Closing tunnel ${this.id}`);

    this.state = TUNNEL_STATES.CLOSED;

    // Close all active connections
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Cancel remote forwarding if needed: detach the handler FIRST so a
    // shared connection never dispatches later 'tcp connection' events to
    // this dead tunnel, then unforward. removeListener is mandatory on
    // TunnelableConnection — a silent skip would leave a closed tunnel
    // live on the emitter.
    if (this.type === TUNNEL_TYPES.REMOTE) {
      if (this.tcpHandler) {
        this.ssh.removeListener('tcp connection', this.tcpHandler);
        this.tcpHandler = null;
      }
      this.ssh.unforwardIn(this.config.remoteHost, this.config.remotePort);
    }

    tunnels.delete(this.id);
  }

  /**
   * Reconnect tunnel
   */
  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnect attempts reached for tunnel ${this.id}`);
      this.state = TUNNEL_STATES.FAILED;
      return false;
    }

    this.reconnectAttempts++;
    this.state = TUNNEL_STATES.RECONNECTING;

    logger.info(`Reconnecting tunnel ${this.id}`, {
      attempt: this.reconnectAttempts,
    });

    try {
      await this.start();
      this.reconnectAttempts = 0;
      return true;
    } catch (error) {
      logger.error(`Reconnect failed for tunnel ${this.id}`, {
        error: error.message,
      });

      // Retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => this.reconnect(), delay);

      return false;
    }
  }
}

/**
 * Create a new SSH tunnel
 */
export async function createTunnel(serverName: string, ssh: TunnelableConnection, config: any) {
  const tunnelId = `tunnel_${Date.now()}_${randomUUID().substring(0, 8)}`;

  // Validate config
  if (!config.type || !Object.values(TUNNEL_TYPES).includes(config.type)) {
    throw new Error(`Invalid tunnel type: ${config.type}`);
  }

  // Set defaults
  config.localHost = config.localHost || '127.0.0.1';

  if (config.type !== TUNNEL_TYPES.DYNAMIC) {
    if (!config.remoteHost || !config.remotePort) {
      throw new Error('Remote host and port required for port forwarding');
    }
  }

  if (!config.localPort) {
    throw new Error('Local port required');
  }

  const tunnel = new SSHTunnel(tunnelId, serverName, ssh, config);
  tunnels.set(tunnelId, tunnel);

  try {
    await tunnel.start();

    logger.info('SSH tunnel created', {
      id: tunnelId,
      type: config.type,
      server: serverName,
    });

    return tunnel;
  } catch (error) {
    tunnels.delete(tunnelId);
    throw error;
  }
}

/**
 * List all active tunnels
 */
export function listTunnels(serverName = null) {
  const activeTunnels = [];

  for (const [, tunnel] of tunnels.entries()) {
    if (tunnel.state !== TUNNEL_STATES.CLOSED) {
      if (!serverName || tunnel.serverName === serverName) {
        activeTunnels.push(tunnel.getInfo());
      }
    }
  }

  return activeTunnels;
}

/**
 * Close a tunnel
 */
export function closeTunnel(tunnelId) {
  const tunnel = tunnels.get(tunnelId);

  if (!tunnel) {
    throw new Error(`Tunnel ${tunnelId} not found`);
  }

  tunnel.close();
  return true;
}

/**
 * Close all tunnels for a server
 */
export function closeServerTunnels(serverName) {
  let closedCount = 0;

  for (const [, tunnel] of tunnels.entries()) {
    if (tunnel.serverName === serverName) {
      tunnel.close();
      closedCount++;
    }
  }

  return closedCount;
}

/**
 * Monitor tunnel health
 */
function monitorTunnels() {
  const now = Date.now();
  const healthTimeout = 60 * 1000; // 1 minute

  for (const [id, tunnel] of tunnels.entries()) {
    if (tunnel.state === TUNNEL_STATES.ACTIVE) {
      const idle = now - tunnel.lastActivity.getTime();

      // Check if tunnel is still healthy
      if (idle > healthTimeout && tunnel.connections.size === 0) {
        logger.debug(`Tunnel ${id} idle for ${idle}ms`);
      }

      // Auto-reconnect failed tunnels
      if (tunnel.state === TUNNEL_STATES.FAILED) {
        tunnel.reconnect();
      }
    }
  }
}

// Monitor tunnels periodically.
// unref() so this interval never keeps the process alive on its own: as part of
// a stdio MCP server we must exit when the transport closes, not stay pinned by
// a background timer.
const tunnelMonitor = setInterval(monitorTunnels, 30 * 1000); // Every 30 seconds
if (typeof tunnelMonitor.unref === 'function') tunnelMonitor.unref();
