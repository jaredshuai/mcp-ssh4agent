/**
 * ProxyCommand socket factory (OpenSSH ProxyCommand semantics).
 *
 * Extracted from the entry point so ConnectionPool can own the full connect
 * path without importing src/index.ts (no import cycles).
 */

/**
 * Create a socket from a proxy command (e.g., "ncat --proxy 127.0.0.1:1080
 * --proxy-type socks5 %h %p"). The command is executed through the system
 * shell, so quoted arguments and shell metacharacters work as users expect.
 */
export async function createProxyCommandSocket(
  proxyCommand: string,
  host: string,
  port: number
): Promise<any> {
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
