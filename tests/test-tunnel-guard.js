/**
 * ssh_tunnel_create hop-policy tests.
 *
 * Single-hop proxyJump/proxyCommand is dialed (see test-tunnel-proxy.js).
 * This file locks the handler-level refusals that must still fire BEFORE
 * a real SSHManager is constructed: missing jump host, nested/circular
 * hops, unknown server. A plain server still proceeds to the dial path.
 *
 * Drives the real handler from src/tools/advanced.ts through a captured
 * registration (ADR-0002).
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
    resolveServer: async (serverName) => {
      const servers = {
        'behind-bastion': {
          name: 'behind-bastion',
          config: { host: '10.0.0.8', port: 22, proxyJump: 'bastion' },
        },
        bastion: { name: 'bastion', config: { host: '127.0.0.1', port: 1 } },
        nested: {
          name: 'nested',
          config: { host: '10.0.0.9', port: 22, proxyJump: 'mid' },
        },
        mid: {
          name: 'mid',
          config: { host: '10.0.0.2', port: 22, proxyJump: 'bastion' },
        },
        orphan: {
          name: 'orphan',
          config: { host: '10.0.0.8', port: 22, proxyJump: 'ghost' },
        },
        plain: { name: 'plain', config: { host: '127.0.0.1', port: 1 } },
      };
      return servers[String(serverName).toLowerCase()] ?? null;
    },
  };
  /** @type {any} */
  const ctxAny = ctx;
  registerAdvancedTools(ctxAny);

  const handler = handlers['ssh_tunnel_create'];
  assert.ok(typeof handler === 'function', 'ssh_tunnel_create handler captured');

  const call = (server) =>
    handler({ server, type: 'local', localPort: 12345, remoteHost: 'h', remotePort: 80 });

  // ── nested hop: refuse before dial ──────────────────────────────────────
  await assert.rejects(
    () => call('nested'),
    /Tunnels support only a single hop/,
    'nested proxyJump must fail with the single-hop error'
  );
  ok('nested jump host: refused before dialing');

  // ── missing jump host ───────────────────────────────────────────────────
  await assert.rejects(
    () => call('orphan'),
    /Proxy jump server "ghost" not found/,
    'missing jump host must fail before dialing'
  );
  ok('missing jump host: not-found error before dial');

  // ── single hop proceeds to dial (loopback port 1 refuses instantly) ─────
  await assert.rejects(
    () => call('behind-bastion'),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return !/single hop|not found/i.test(message);
    },
    'single-hop proxyJump is not rejected by the nested/missing guards'
  );
  ok('single-hop proxyJump proceeds to the dial path');

  // ── a plain server still proceeds to dial ───────────────────────────────
  await assert.rejects(
    () => call('plain'),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return !/proxy_jump|proxy_command|single hop/i.test(message);
    },
    'plain server is not rejected by hop policy'
  );
  ok('plain server passes hop policy (proceeds to the dial path)');

  // ── unknown server still gets the not-found error ────────────────────────
  await assert.rejects(
    () => call('no-such-server'),
    /not found/i,
    'unknown server keeps the existing not-found error'
  );
  ok('unknown server: not-found error unchanged');

  console.log(`\n✅ tunnel hop-policy tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
