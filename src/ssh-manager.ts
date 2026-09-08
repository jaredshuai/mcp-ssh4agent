import { Client } from 'ssh2';
import fs from 'fs';
import os from 'os';
import { isHostKnown, addHostKey } from './ssh-key-manager.ts';
import { logger } from './logger.ts';
import { buildCdPrefix } from './shell-quote.ts';
// Type-only (erased at runtime — no import cycle): the tunnel seam this
// class implements. `implements` makes the issue-#2 contract machine-
// checked: if TunnelableConnection grows a method this class lacks,
// typecheck fails instead of remote tunnels crashing at runtime (knip
// also requires the import to be real).
import type { TunnelableConnection } from './tunnel-manager.ts';

// Validate liveness-probe output across shells (bash, cmd.exe, PowerShell).
// Normalize CRLF, stray quotes/backslashes and case before matching so quoted
// or escaped variants (e.g. `"ping"`, `\"ping\"\r\n`) still count as alive.
// `includes` (not strict `===`) is deliberate: a liveness probe should err
// toward "alive" — a false positive merely lets the next real command
// reconnect, whereas a false negative needlessly tears down a healthy pooled
// connection.
export function isPingAlive(stdout) {
  const normalized = (stdout || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["'`\\]/g, '')
    .trim()
    .toLowerCase();
  return normalized.includes('ping');
}

class SSHManager implements TunnelableConnection {
  // Resolved server config plus manager-specific flags; shapes vary by source.
  config: any;
  client: Client;
  connected: boolean;
  // ssh2 SFTP wrapper; ships no bundled types, null until getSFTP().
  sftp: any;
  cachedHomeDir: string | null;
  autoAcceptHostKey: boolean;
  hostKeyVerification: boolean;
  /** Pool-owned jump SSHManager. Must NOT be disposed here — other pooled
   * targets may still share that bastion (see ConnectionPool.#jumpDeps). */
  jumpConnection: any;
  /** Tunnel-owned jump SSHManager. Disposed after this client ends. */
  ownedJumpConnection: any;

  constructor(config) {
    this.config = config;
    this.client = new Client();
    this.connected = false;
    this.sftp = null;
    this.cachedHomeDir = null;
    this.autoAcceptHostKey = config.autoAcceptHostKey || false;
    this.hostKeyVerification = config.hostKeyVerification !== false; // Default true
    this.jumpConnection = null;
    this.ownedJumpConnection = null;
  }

  /** @returns {Promise<void>} */
  async connect(options: { sock?: any } = {}) {
    return new Promise<void>((resolve, reject) => {
      this.client.on('ready', () => {
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err) => {
        this.connected = false;
        reject(err);
      });

      this.client.on('end', () => {
        this.connected = false;
      });

      // Build connection config (ssh2 ConnectConfig, extended below).
      const connConfig: Record<string, any> = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.user,
        readyTimeout: 60000, // Increased from 20000 to 60000 for slow connections
        keepaliveInterval: 10000,
        algorithms: {
          kex: [
            'curve25519-sha256',
            'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group16-sha512',
            'diffie-hellman-group15-sha512',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group14-sha1',
          ],
          cipher: [
            'aes128-gcm@openssh.com',
            'aes256-gcm@openssh.com',
            'aes128-ctr',
            'aes192-ctr',
            'aes256-ctr',
            'aes128-gcm',
            'aes256-gcm',
            'aes128-cbc',
            'aes192-cbc',
            'aes256-cbc',
          ],
          serverHostKey: [
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-ed25519',
            'ssh-rsa',
          ],
          hmac: [
            'hmac-sha2-256-etm@openssh.com',
            'hmac-sha2-512-etm@openssh.com',
            'hmac-sha1-etm@openssh.com',
            'hmac-sha2-256',
            'hmac-sha2-512',
            'hmac-sha1',
          ],
        },
        debug: (info) => {
          if (info.includes('Handshake') || info.includes('error')) {
            logger.debug('SSH2 Debug', { info });
          }
        },
      };

      // Add host key verification callback if enabled
      if (this.hostKeyVerification) {
        connConfig.hostVerifier = () => {
          const port = this.config.port || 22;
          const host = this.config.host;

          // Check if host is already known
          if (isHostKnown(host, port)) {
            // For now, accept all known hosts
            // TODO: Implement proper fingerprint comparison once we understand SSH2's hash format
            logger.info('Host key verified', { host, port });
            return true;
          }

          // Host is not known
          logger.info('New host detected', { host, port });

          // If autoAcceptHostKey is enabled, accept and add the key
          if (this.autoAcceptHostKey) {
            logger.info('Auto-accept host key', { host, port });
            // Schedule key addition after connection
            setImmediate(async () => {
              try {
                await addHostKey(host, port);
                logger.info('Host key added', { host, port });
              } catch (err) {
                logger.warn('Failed to add host key', {
                  host,
                  port,
                  error: err.message,
                });
              }
            });
            return true;
          }

          // For backward compatibility, accept new hosts by default
          // In production, you might want to prompt the user or check a whitelist
          logger.warn('Auto-accepting new host', { host, port });
          return true;
        };
      }

      // Use ssh-agent if available (handles passphrase-protected keys transparently)
      if (process.env.SSH_AUTH_SOCK) {
        connConfig.agent = process.env.SSH_AUTH_SOCK;
        // Opt-in per-server agent forwarding. ssh2 requires `agent` to be set,
        // so we only enable it inside this block — otherwise ssh2 throws at
        // connect. With allowAgentFwd on, every exec/shell channel forwards the
        // agent automatically, so no per-command change is needed.
        if (this.config.forwardAgent) {
          connConfig.agentForward = true;
        }
      }

      // Add authentication (support both keyPath and keypath for compatibility)
      const keyPath = this.config.keyPath || this.config.keypath;
      if (keyPath) {
        const resolvedKeyPath = keyPath.replace('~', os.homedir());
        connConfig.privateKey = fs.readFileSync(resolvedKeyPath);
        if (this.config.passphrase) {
          connConfig.passphrase = this.config.passphrase;
        }
      } else if (this.config.password) {
        connConfig.password = this.config.password;
      }

      // Use provided stream for proxy jump connections
      if (options.sock) {
        connConfig.sock = options.sock;
      }

      this.client.connect(connConfig);
    });
  }

  async execCommand(
    command,
    options: { timeout?: number; cwd?: string; rawCommand?: boolean } = {}
  ) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }

    const { timeout = 30000, cwd, rawCommand = false } = options;
    const fullCommand = cwd && !rawCommand ? buildCdPrefix(cwd) + command : command;

    return new Promise<{ stdout: string; stderr: string; code: number; signal?: string }>(
      (resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let completed = false;
        let stream = null;
        let timeoutId = null;

        // Setup timeout first
        if (timeout > 0) {
          timeoutId = setTimeout(() => {
            if (!completed) {
              completed = true;

              // Try multiple ways to kill the stream
              if (stream) {
                try {
                  stream.write('\x03'); // Send Ctrl+C
                  stream.end();
                  stream.destroy();
                } catch (e) {
                  // Ignore errors
                }
              }

              // Kill the entire client connection as last resort
              try {
                this.client.end();
                this.connected = false;
              } catch (e) {
                // Ignore errors
              }

              reject(
                new Error(`Command timeout after ${timeout}ms: ${command.substring(0, 100)}...`)
              );
            }
          }, timeout);
        }

        this.client.exec(fullCommand, (err, streamObj) => {
          if (err) {
            completed = true;
            if (timeoutId) clearTimeout(timeoutId);
            reject(err);
            return;
          }

          stream = streamObj;

          stream.on('close', (code, signal) => {
            if (!completed) {
              completed = true;
              if (timeoutId) clearTimeout(timeoutId);
              resolve({
                stdout,
                stderr,
                code: code || 0,
                signal,
              });
            }
          });

          stream.on('data', (data) => {
            stdout += data.toString();
          });

          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          stream.on('error', (err) => {
            if (!completed) {
              completed = true;
              if (timeoutId) clearTimeout(timeoutId);
              reject(err);
            }
          });
        });
      }
    );
  }

  async execCommandStream(
    command,
    options: {
      cwd?: string;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    } = {}
  ) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }

    const { cwd, onStdout, onStderr } = options;
    const fullCommand = cwd ? buildCdPrefix(cwd) + command : command;

    return new Promise((resolve, reject) => {
      this.client.exec(fullCommand, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          resolve({
            stdout,
            stderr,
            code: code || 0,
            signal,
            stream,
          });
        });

        stream.on('data', (data) => {
          const chunk = data.toString();
          stdout += chunk;
          if (onStdout) onStdout(chunk);
        });

        stream.stderr.on('data', (data) => {
          const chunk = data.toString();
          stderr += chunk;
          if (onStderr) onStderr(chunk);
        });

        stream.on('error', reject);
      });
    });
  }

  async requestShell(options: Record<string, any> = {}) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }

    return new Promise((resolve, reject) => {
      this.client.shell(options, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stream);
      });
    });
  }

  async getSFTP() {
    if (this.sftp) return this.sftp;

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        this.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async resolveHomePath() {
    if (this.cachedHomeDir) {
      return this.cachedHomeDir;
    }

    let homeDir = null;

    // Method 1: Try getent (most reliable)
    try {
      const result = await this.execCommand('getent passwd $USER | cut -d: -f6', {
        timeout: 5000,
        rawCommand: true,
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // getent might not be available, try next method
    }

    // Method 2: Try env -i to get clean HOME
    try {
      const result = await this.execCommand('env -i HOME=$HOME bash -c "echo $HOME"', {
        timeout: 5000,
        rawCommand: true,
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // env method failed, try next
    }

    // Method 3: Parse /etc/passwd directly
    try {
      const result = await this.execCommand('grep "^$USER:" /etc/passwd | cut -d: -f6', {
        timeout: 5000,
        rawCommand: true,
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // /etc/passwd parsing failed, try last resort
    }

    // Method 4: Last resort - try cd ~ && pwd
    try {
      const result = await this.execCommand('cd ~ && pwd', {
        timeout: 5000,
        rawCommand: true,
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // All methods failed
    }

    throw new Error('Unable to determine home directory on remote server');
  }

  async putFile(localPath, remotePath) {
    // SFTP doesn't resolve ~ automatically, we need to get the real path
    let resolvedRemotePath = remotePath;
    if (remotePath.includes('~')) {
      try {
        const homeDir = await this.resolveHomePath();
        // Replace ~ with the actual home directory
        // Handle both ~/path and ~ alone
        if (remotePath === '~') {
          resolvedRemotePath = homeDir;
        } else if (remotePath.startsWith('~/')) {
          resolvedRemotePath = homeDir + remotePath.substring(1);
        } else {
          // If ~ is not at the beginning, don't replace it
          resolvedRemotePath = remotePath;
        }
      } catch (err) {
        // If we can't resolve home, throw a more descriptive error
        throw new Error(`Failed to resolve home directory for path: ${remotePath}. ${err.message}`);
      }
    }

    const sftp = await this.getSFTP();
    return new Promise((resolve, reject) => {
      // Check if local file exists and is readable
      if (!fs.existsSync(localPath)) {
        reject(new Error(`Local file does not exist: ${localPath}`));
        return;
      }

      sftp.fastPut(localPath, resolvedRemotePath, (err) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
  }

  async getFile(localPath, remotePath) {
    // SFTP doesn't resolve ~ automatically, we need to get the real path
    let resolvedRemotePath = remotePath;
    if (remotePath.includes('~')) {
      try {
        const homeDir = await this.resolveHomePath();
        // Replace ~ with the actual home directory
        // Handle both ~/path and ~ alone
        if (remotePath === '~') {
          resolvedRemotePath = homeDir;
        } else if (remotePath.startsWith('~/')) {
          resolvedRemotePath = homeDir + remotePath.substring(1);
        } else {
          // If ~ is not at the beginning, don't replace it
          resolvedRemotePath = remotePath;
        }
      } catch (err) {
        // If we can't resolve home, throw a more descriptive error
        throw new Error(`Failed to resolve home directory for path: ${remotePath}. ${err.message}`);
      }
    }

    const sftp = await this.getSFTP();
    return new Promise((resolve, reject) => {
      sftp.fastGet(resolvedRemotePath, localPath, (err) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
  }

  async putFiles(files, options: { stopOnError?: boolean } = {}) {
    await this.getSFTP();
    const results = [];

    for (const file of files) {
      try {
        await this.putFile(file.local, file.remote);
        results.push({ ...file, success: true });
      } catch (error) {
        results.push({ ...file, success: false, error: error.message });
        if (options.stopOnError) break;
      }
    }

    return results;
  }

  isConnected() {
    return this.connected && this.client && !this.client.destroyed;
  }

  /**
   * 结束本连接；若这是隧道专属目标，再拆掉它自握的门卫 Connection。
   * 不释放 jumpConnection（那是池里可能被共享的 bastion）。
   */
  dispose() {
    if (this.sftp) {
      this.sftp.end();
      this.sftp = null;
    }
    if (this.client) {
      this.client.end();
      this.connected = false;
    }
    const owned = this.ownedJumpConnection;
    this.ownedJumpConnection = null;
    if (owned && owned !== this && typeof owned.dispose === 'function') {
      try {
        owned.dispose();
      } catch {
        /* 门卫拆除失败不挡住目标已经结束 */
      }
    }
  }

  async forwardOut(srcAddr, srcPort, dstAddr, dstPort) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }
    return new Promise((resolve, reject) => {
      this.client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });
  }

  // Remote-forwarding surface required by TunnelableConnection
  // (src/tunnel-manager.ts). These forward verbatim to the ssh2 Client —
  // before they existed, remote tunnels crashed with
  // `TypeError: forwardIn is not a function` (issue #2).

  forwardIn(remoteAddr: string, remotePort: number, callback?: (err?: Error) => void) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }
    return this.client.forwardIn(remoteAddr, remotePort, callback);
  }

  unforwardIn(remoteAddr: string, remotePort: number) {
    // Teardown path: the connection may already be gone — nothing to unforward
    // (and the ssh2 call would throw on a dead client).
    if (!this.connected) return;
    return this.client.unforwardIn(remoteAddr, remotePort);
  }

  on(event: string, listener: (...args: any[]) => void) {
    return this.client.on(event, listener);
  }

  removeListener(event: string, listener: (...args: any[]) => void) {
    return this.client.removeListener(event, listener);
  }

  async ping() {
    try {
      // Use `echo ping` WITHOUT quotes: cmd.exe echoes surrounding quotes
      // literally (outputs `"ping"`), which broke the strict equality check and
      // marked healthy Windows/OpenSSH sessions as dead. Output handling lives
      // in isPingAlive() so it can be unit-tested without a live connection.
      const result = await this.execCommand('echo ping', { timeout: 5000 });
      return isPingAlive(result.stdout);
    } catch (error) {
      return false;
    }
  }
}

export default SSHManager;
