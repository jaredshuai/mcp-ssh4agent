/**
 * Single-hop tunnel dial tests (ISSUE-01 / ADR-0003).
 *
 * ssh_tunnel_create now traverses one proxyJump or proxyCommand hop on a
 * dedicated jump connection — never ConnectionPool.get(jump). These tests
 * drive dialTunnelConnection with in-memory fakes: no network, no real
 * bastion. Nested hops still refuse before any connect().
 */

import assert from 'assert';
import { PassThrough } from 'stream';
import { dialTunnelConnection } from '../src/tunnel-dial.ts';
import SSHManager from '../src/ssh-manager.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

/**
 * 构造可记录 connect / forwardOut / dispose 的假连接，供拨号函数注入。
 */
function makeFake(label, options = {}) {
  const state = {
    label,
    connectCalls: [],
    forwardOutCalls: [],
    disposeCalls: 0,
    stream: new PassThrough(),
    failConnect: Boolean(options.failConnect),
  };
  const fake = {
    ownedJumpConnection: null,
    async connect(opts = {}) {
      state.connectCalls.push(opts);
      if (state.failConnect) {
        throw new Error(`dial failed: ${label}`);
      }
    },
    async forwardOut(srcAddr, srcPort, dstAddr, dstPort) {
      state.forwardOutCalls.push({ srcAddr, srcPort, dstAddr, dstPort });
      return state.stream;
    },
    dispose() {
      state.disposeCalls += 1;
    },
  };
  return { fake, state };
}

function serversTable() {
  return {
    target: {
      name: 'target',
      config: { host: '10.0.0.8', port: 22, proxyJump: 'bastion', role: 'target' },
    },
    bastion: {
      name: 'bastion',
      config: { host: '10.0.0.1', port: 22, role: 'jump' },
    },
    nested: {
      name: 'nested',
      config: { host: '10.0.0.9', port: 22, proxyJump: 'mid' },
    },
    mid: {
      name: 'mid',
      config: { host: '10.0.0.2', port: 22, proxyJump: 'bastion' },
    },
    viaCmd: {
      name: 'via-cmd',
      config: { host: '10.0.0.8', port: 22, proxyCommand: 'ncat --proxy 127.0.0.1:1080 %h %p' },
    },
    circular: {
      name: 'circular',
      config: { host: '10.0.0.8', port: 22, proxyJump: 'loop-b' },
    },
    'loop-b': {
      name: 'loop-b',
      config: { host: '10.0.0.2', port: 22, proxyJump: 'circular' },
    },
  };
}

async function resolveFromTable(table, name) {
  return table[String(name).toLowerCase()] ?? null;
}

async function main() {
  const table = serversTable();

  // ── proxyJump success: dedicated jump, sock is jump's forwardOut stream ─
  {
    const jump = makeFake('jump');
    const target = makeFake('target');
    const created = [];
    const ssh = await dialTunnelConnection(table.target, (n) => resolveFromTable(table, n), {
      createConnection: (config) => {
        created.push(config.role);
        return config.role === 'jump' ? jump.fake : target.fake;
      },
    });
    assert.strictEqual(created.join(','), 'jump,target', 'jump is dialed before target');
    assert.strictEqual(jump.state.connectCalls.length, 1, 'jump connect once');
    assert.ok(!jump.state.connectCalls[0].sock, 'jump is a direct dial');
    assert.strictEqual(jump.state.forwardOutCalls.length, 1, 'one forwardOut through jump');
    assert.deepStrictEqual(jump.state.forwardOutCalls[0], {
      srcAddr: '127.0.0.1',
      srcPort: 0,
      dstAddr: '10.0.0.8',
      dstPort: 22,
    });
    assert.strictEqual(target.state.connectCalls.length, 1, 'target connect once');
    assert.strictEqual(
      target.state.connectCalls[0].sock,
      jump.state.stream,
      'target sock is the jump forwardOut stream'
    );
    assert.strictEqual(ssh, target.fake, 'returned connection is the target');
    assert.strictEqual(target.fake.ownedJumpConnection, jump.fake, 'target owns the jump');
    ok('proxyJump: dedicated jump forwardOut becomes target sock');
  }

  // ── SSHManager-like cascade: dispose target clears and disposes jump ────
  {
    const jump = makeFake('jump');
    const target = makeFake('target');
    target.fake.dispose = function disposeTarget() {
      target.state.disposeCalls += 1;
      const owned = target.fake.ownedJumpConnection;
      target.fake.ownedJumpConnection = null;
      if (owned && typeof owned.dispose === 'function') owned.dispose();
    };
    const ssh = await dialTunnelConnection(table.target, (n) => resolveFromTable(table, n), {
      createConnection: (config) => (config.role === 'jump' ? jump.fake : target.fake),
    });
    ssh.dispose();
    ssh.dispose();
    assert.strictEqual(target.state.disposeCalls, 2, 'target dispose is idempotent on caller');
    assert.strictEqual(jump.state.disposeCalls, 1, 'jump disposed exactly once');
    ok('proxyJump: target.dispose cascades to jump once');
  }

  // ── target connect failure disposes an already-up jump ──────────────────
  {
    const jump = makeFake('jump');
    const target = makeFake('target', { failConnect: true });
    await assert.rejects(
      () =>
        dialTunnelConnection(table.target, (n) => resolveFromTable(table, n), {
          createConnection: (config) => (config.role === 'jump' ? jump.fake : target.fake),
        }),
      /dial failed: target/
    );
    assert.strictEqual(jump.state.disposeCalls, 1, 'failed target dial must not leak the jump');
    assert.strictEqual(target.fake.ownedJumpConnection, null, 'ownership not assigned on failure');
    ok('proxyJump: failed target connect disposes the jump');
  }

  // ── missing jump server ────────────────────────────────────────────────
  await assert.rejects(
    () =>
      dialTunnelConnection(table.target, async () => null, {
        createConnection: () => makeFake('unused').fake,
      }),
    /Proxy jump server "bastion" not found/
  );
  ok('proxyJump: missing jump host errors before any dial');

  // ── nested jump refused, zero connect ──────────────────────────────────
  {
    const created = [];
    await assert.rejects(
      () =>
        dialTunnelConnection(table.nested, (n) => resolveFromTable(table, n), {
          createConnection: (config) => {
            created.push(config.host);
            return makeFake('should-not-dial').fake;
          },
        }),
      /Tunnels support only a single hop/
    );
    assert.deepStrictEqual(created, [], 'nested jump must not create connections');
    ok('nested proxyJump is refused before dial');
  }

  // ── circular A→B→A is nested (B has proxyJump) ─────────────────────────
  await assert.rejects(
    () =>
      dialTunnelConnection(table.circular, (n) => resolveFromTable(table, n), {
        createConnection: () => makeFake('should-not-dial').fake,
      }),
    /single hop/
  );
  ok('circular proxyJump is refused as a nested hop');

  // ── proxyCommand injects sock, no jump connection ──────────────────────
  {
    const target = makeFake('target');
    const sock = new PassThrough();
    let opened = null;
    await dialTunnelConnection(table.viaCmd, async () => null, {
      createConnection: () => target.fake,
      openProxyCommandSocket: async (cmd, host, port) => {
        opened = { cmd, host, port };
        return sock;
      },
    });
    assert.deepStrictEqual(opened, {
      cmd: table.viaCmd.config.proxyCommand,
      host: '10.0.0.8',
      port: 22,
    });
    assert.strictEqual(target.state.connectCalls[0].sock, sock);
    assert.strictEqual(target.fake.ownedJumpConnection, null);
    ok('proxyCommand: local sock is passed to connect, no owned jump');
  }

  // ── proxyCommand connect failure destroys the sock ─────────────────────
  {
    const target = makeFake('target', { failConnect: true });
    let destroyed = 0;
    const sock = {
      destroy() {
        destroyed += 1;
      },
    };
    await assert.rejects(
      () =>
        dialTunnelConnection(table.viaCmd, async () => null, {
          createConnection: () => target.fake,
          openProxyCommandSocket: async () => sock,
        }),
      /dial failed: target/
    );
    assert.strictEqual(destroyed, 1, 'failed proxyCommand dial must destroy the sock');
    ok('proxyCommand: failed connect destroys the sock');
  }

  // ── production dispose: ownedJumpConnection once, jumpConnection spared ─
  {
    const mgr = new SSHManager({ host: '127.0.0.1', user: 'x' });
    let owned = 0;
    let pooled = 0;
    mgr.ownedJumpConnection = {
      dispose() {
        owned += 1;
      },
    };
    mgr.jumpConnection = {
      dispose() {
        pooled += 1;
      },
    };
    mgr.dispose();
    mgr.dispose();
    assert.strictEqual(owned, 1, 'owned jump disposed once');
    assert.strictEqual(pooled, 0, 'pool jumpConnection must not be disposed by SSHManager');
    ok('SSHManager.dispose cascades ownedJumpConnection only');
  }

  console.log(`\n✅ tunnel proxy dial tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
