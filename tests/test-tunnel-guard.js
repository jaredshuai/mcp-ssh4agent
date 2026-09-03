/**
 * ssh_tunnel_create proxy guard tests (candidate-2 fix B).
 *
 * Tunnel connections dial directly — they own their connection and cannot
 * traverse proxyJump/proxyCommand (only the ConnectionPool implements
 * those). Before the guard, a tunnel on a jump-reachable server dialed the
 * target host directly and failed with an obscure connect timeout after a
 * long hang. The guard must fail LOUDLY, before any dial, with a hint at the
 * ssh_execute alternative.
 *
 * Drives the real handler from src/tools/advanced.ts through a captured
 * registration (ADR-0002: tool modules receive their context; nothing here
 * needs the entry point or a network).
 */

import assert from 'assert';
import { registerAdvancedTools } from '../src/tools/advanced.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

async function main() {
  const handlers = {};
  const ctx = {
    register: (toolName, _schema, handler, _policy) => {
      handlers[toolName] = handler;
    },
    // The tunnel handler only consults resolveServer before dialing.
    resolveServer: async (serverName) => {
      const servers = {
        'behind-bastion': { name: 'behind-bastion', config: { proxyJump: 'bastion' } },
        'via-command': { name: 'via-command', config: { proxyCommand: 'ncat ...' } },
        plain: { name: 'plain', config: { host: '127.0.0.1', port: 1 } },
      };
      return servers[String(serverName).toLowerCase()] ?? null;
    },
  };
  // Partial ToolContext on purpose: the tunnel handler only consults
  // resolveServer, and nothing else is called before the guard rejects.
  /** @type {any} */
  const ctxAny = ctx;
  registerAdvancedTools(ctxAny);

  const handler = handlers['ssh_tunnel_create'];
  assert.ok(typeof handler === 'function', 'ssh_tunnel_create handler captured');

  const call = (server) =>
    handler({ server, type: 'local', localPort: 12345, remoteHost: 'h', remotePort: 80 });

  // ── proxyJump server: guard fires before any dial ────────────────────────
  await assert.rejects(
    () => call('behind-bastion'),
    /proxy_jump "bastion"/,
    'proxyJump server must fail with the explicit guard error'
  );
  await assert.rejects(
    () => call('behind-bastion'),
    /ssh_execute/,
    'the guard error must point at the ssh_execute alternative'
  );
  ok('proxyJump-configured server: guard rejects before dialing, with a hint');

  // ── proxyCommand server: same guard ───────────────────────────────────────
  await assert.rejects(
    () => call('via-command'),
    /proxy_command/,
    'proxyCommand server must fail with the explicit guard error'
  );
  ok('proxyCommand-configured server: guard rejects before dialing');

  // ── a plain server passes the guard (failure, if any, is a dial failure) ─
  // Port 1 on loopback refuses instantly; whatever error comes back must NOT
  // be the guard's, proving the guard only trips on proxy configs.
  await assert.rejects(
    () => call('plain'),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return !/proxy_jump|proxy_command/.test(message);
    },
    'plain server is not rejected by the guard'
  );
  ok('plain server passes the guard (proceeds to the dial path)');

  // ── unknown server still gets the not-found error ────────────────────────
  await assert.rejects(
    () => call('no-such-server'),
    /not found/i,
    'unknown server keeps the existing not-found error'
  );
  ok('unknown server: not-found error unchanged');

  console.log(`\n✅ tunnel proxy guard tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
