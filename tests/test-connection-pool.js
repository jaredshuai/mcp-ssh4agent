/**
 * ConnectionPool interface tests (issue #3).
 *
 * The pool is the single owner of connection state; these tests drive it
 * through its public surface (get / close / invalidate / status / sweep)
 * with fake connections — no network, no SSH.
 */

import './lib/isolated-home.js'; // must precede src imports: isolates SSH4AGENT_HOME
import assert from 'assert';
import { ConnectionPool, execCommandWithTimeout } from '../src/connection-pool.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

function makeFakeConn(overrides = {}) {
  const conn = {
    connectCalls: [],
    disposed: false,
    alive: true,
    async connect(options = {}) {
      this.connectCalls.push(options);
    },
    async ping() {
      return this.alive;
    },
    dispose() {
      this.disposed = true;
      this.alive = false;
    },
    async forwardOut(srcAddr, srcPort, dstAddr, dstPort) {
      return { via: `${dstAddr}:${dstPort}` };
    },
    ...overrides,
  };
  return conn;
}

function makePool(servers, created, options = {}) {
  return new ConnectionPool({
    loadServers: async () => servers,
    createConnection: (serverConfig) => {
      /** @type {any} */
      const conn = makeFakeConn();
      conn.serverConfig = serverConfig; // test bookkeeping only
      created.push(conn);
      return conn;
    },
    ...options,
  });
}

async function main() {
  // ── get: create once, then reuse ────────────────────────────────────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    const first = await pool.get('pool-web-1');
    const second = await pool.get('POOL-WEB-1'); // case-insensitive reuse
    assert.strictEqual(created.length, 1, 'second get must reuse the pooled connection');
    assert.strictEqual(first, second, 'same instance returned');
    ok('get creates once and reuses (case-insensitive)');
  }

  // ── get through an alias resolves to the same pooled connection ─────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    await pool.get('pool-web-1');
    // 'pool-w' is a unique partial match → resolves to pool-web-1
    const again = await pool.get('pool-w');
    assert.strictEqual(created.length, 1, 'resolved alias must reuse the same connection');
    assert.strictEqual(again, created[0]);
    ok('get resolves partial matches to the same pooled connection');
  }

  // ── dead connection is replaced transparently ───────────────────────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    const first = await pool.get('pool-web-1');
    first.alive = false; // connection dies
    const second = await pool.get('pool-web-1');
    assert.strictEqual(created.length, 2, 'dead connection must be replaced');
    assert.strictEqual(first.disposed, true, 'dead connection must be disposed');
    assert.strictEqual(second, created[1]);
    ok('a dead pooled connection is disposed and replaced on next get');
  }

  // ── status reflects bookkeeping; close clears ALL of it ─────────────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    await pool.get('pool-web-1');

    let status = await pool.status();
    assert.strictEqual(status.servers.length, 1, 'one pooled connection');
    assert.strictEqual(status.servers[0].server, 'pool-web-1');
    assert.strictEqual(status.servers[0].alive, true);
    assert.strictEqual(status.servers[0].keepalive, true, 'keepalive timer armed');
    assert.ok(status.settings.timeoutMinutes > 0 && status.settings.keepaliveMinutes > 0);

    pool.close('POOL-WEB-1');

    status = await pool.status();
    assert.strictEqual(status.servers.length, 0, 'close must remove the entry entirely');
    assert.strictEqual(created[0].disposed, true, 'close must dispose the connection');
    assert.strictEqual(pool.size, 0);
    ok('close disposes the connection and clears timestamp/keepalive/entry together');
  }

  // ── invalidate by instance identity ─────────────────────────────────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    const conn = await pool.get('pool-web-1');
    pool.invalidate(conn); // e.g. the command running on it timed out
    assert.strictEqual(pool.size, 0, 'invalidate must evict by identity');
    assert.strictEqual(conn.disposed, true);
    ok('invalidate evicts by connection identity with full cleanup');
  }

  // ── proxyJump chains: both pooled, dependency recorded, teardown clean ──
  {
    const created = [];
    const pool = makePool(
      {
        'pool-bastion-1': { host: '10.0.0.9' },
        'pool-target-1': { host: '10.0.0.10', proxyJump: 'pool-bastion-1' },
      },
      created
    );
    const target = await pool.get('pool-target-1');
    // The target's connection object is created first; the recursion for the
    // jump server creates the second one.
    const bastion = created[1];

    assert.strictEqual(created.length, 2, 'jump server connected too');
    assert.strictEqual(target.connectCalls[0].sock.via, '10.0.0.10:22', 'dialed via jump stream');
    assert.strictEqual(target.jumpConnection, bastion, 'jump connection attached');

    let status = await pool.status();
    const targetEntry = status.servers.find((s) => s.server === 'pool-target-1');
    assert.strictEqual(targetEntry.jumpServer, 'pool-bastion-1', 'dependency recorded');

    pool.close('pool-target-1');
    status = await pool.status();
    assert.strictEqual(
      status.servers.find((s) => s.server === 'pool-target-1'),
      undefined,
      'target gone after close'
    );
    assert.ok(
      status.servers.some((s) => s.server === 'pool-bastion-1'),
      'jump server stays pooled'
    );
    ok('proxyJump: chain dialed, dependency recorded, close cleans only the target');
  }

  // ── circular proxy jumps are refused ────────────────────────────────────
  {
    const created = [];
    const pool = makePool(
      {
        'pool-loop-a': { host: '10.1.0.1', proxyJump: 'pool-loop-b' },
        'pool-loop-b': { host: '10.1.0.2', proxyJump: 'pool-loop-a' },
      },
      created
    );
    await assert.rejects(() => pool.get('pool-loop-a'), /Circular proxy jump/);
    assert.strictEqual(pool.size, 0, 'nothing stays pooled after a refused connect');
    ok('circular proxy jumps are detected and refused');
  }

  // ── unknown server error message lists what IS available ────────────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    await assert.rejects(
      () => pool.get('pool-nope-xyz'),
      /Server "pool-nope-xyz" not found.*pool-web-1/s
    );
    ok('unknown servers fail with the available-server list');
  }

  // ── dangling alias (target server removed) fails cleanly ───────────────
  {
    const created = [];
    // Plant an alias pointing at a server that is NOT in the table (the
    // isolated home keeps this away from any real aliases).
    const { addAlias } = await import('../src/server-aliases.ts');
    addAlias('gone', 'pool-removed-1');
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created);
    await assert.rejects(
      () => pool.get('gone'),
      /resolves to "pool-removed-1" which has no configuration.*stale alias/s
    );
    assert.strictEqual(pool.size, 0, 'nothing pooled from a dangling alias');
    ok('dangling alias (target removed) fails with a stale-alias hint, not a null-config crash');
  }

  // ── sweep closes dead connections, keeps live ones ──────────────────────
  {
    const created = [];
    const pool = makePool(
      {
        'pool-live-1': { host: '10.2.0.1' },
        'pool-dead-1': { host: '10.2.0.2' },
      },
      created
    );
    await pool.get('pool-live-1');
    await pool.get('pool-dead-1');
    created[1].alive = false;

    const closed = await pool.sweep();
    assert.strictEqual(closed, 1, 'one dead connection swept');
    assert.strictEqual(pool.size, 1);
    assert.strictEqual(created[0].disposed, false, 'live connection kept');
    ok('sweep closes dead connections and keeps live ones');
  }

  // ── cleanupAged honors the configured timeout ───────────────────────────
  {
    const created = [];
    const pool = makePool({ 'pool-web-1': { host: '10.0.0.1' } }, created, {
      connectionTimeoutMs: 1,
    });
    await pool.get('pool-web-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closed = pool.cleanupAged();
    assert.strictEqual(closed, 1, 'aged connection closed');
    assert.strictEqual(pool.size, 0);
    ok('cleanupAged closes connections idle past the pool timeout');
  }

  // ── concurrent get() calls share ONE connection attempt ────────────────
  {
    const created = [];
    /** @type {(v?: undefined) => void} */
    let releaseConnect = () => undefined;
    const gate = new Promise((resolve) => {
      releaseConnect = resolve;
    });
    const pool = new ConnectionPool({
      loadServers: async () => ({ 'pool-slow-1': { host: '10.3.0.1' } }),
      createConnection: () => {
        const conn = makeFakeConn();
        conn.connect = async () => {
          await gate; // hold the first attempt open until both callers pile up
        };
        created.push(conn);
        return conn;
      },
    });

    const p1 = pool.get('pool-slow-1');
    const p2 = pool.get('pool-slow-1');
    // Let both callers register: the first blocks inside connect() on the
    // gate, the second must join the in-flight attempt instead of dialing.
    await new Promise((resolve) => setImmediate(resolve));
    releaseConnect();
    const [a, b] = await Promise.all([p1, p2]);

    assert.strictEqual(created.length, 1, 'overlapping setups must share one attempt');
    assert.strictEqual(a, b, 'both callers receive the same connection');
    ok('concurrent get() for one server shares a single in-flight connection');
  }

  // ── a failed connect disposes the half-built client ────────────────────
  {
    const created = [];
    const pool = new ConnectionPool({
      loadServers: async () => ({ 'pool-bad-1': { host: '10.4.0.1' } }),
      createConnection: () => {
        const conn = makeFakeConn();
        conn.connect = async () => {
          throw new Error('dial refused');
        };
        created.push(conn);
        return conn;
      },
    });
    await assert.rejects(() => pool.get('pool-bad-1'), /Failed to connect to pool-bad-1/);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].disposed, true, 'failed client disposed, not leaked');
    assert.strictEqual(pool.size, 0);
    ok('failed connection setup disposes the SSH client before rethrowing');
  }

  // ── a post-connect hook failure clears the pooled entry (PR #9) ────────
  {
    const created = [];
    const pool = makePool({ 'pool-hook-1': { host: '10.7.0.1' } }, created, {
      executeHook: async (event) => {
        if (event === 'post-connect') throw new Error('hook exploded');
      },
    });
    await assert.rejects(() => pool.get('pool-hook-1'), /hook exploded/);
    assert.strictEqual(created[0].disposed, true, 'client disposed after hook failure');
    assert.strictEqual(pool.size, 0, 'no dead entry left in the pool');
    assert.strictEqual((await pool.status()).servers.length, 0, 'bookkeeping fully cleared');
    ok('post-connect hook failure routes through close() — no dead pooled entry');
  }

  // ── disposeAll during an in-flight connect cannot resurrect the pool ───
  {
    const created = [];
    /** @type {(v?: undefined) => void} */
    let releaseConnect = () => undefined;
    const gate = new Promise((resolve) => {
      releaseConnect = resolve;
    });
    const pool = new ConnectionPool({
      loadServers: async () => ({ 'pool-shut-1': { host: '10.6.0.1' } }),
      createConnection: () => {
        const conn = makeFakeConn();
        conn.connect = async () => {
          await gate; // hold the dial open across the disposeAll below
        };
        created.push(conn);
        return conn;
      },
    });
    const pending = pool.get('pool-shut-1');
    await new Promise((resolve) => setImmediate(resolve));
    pool.disposeAll(); // shutdown while the dial is still in flight
    releaseConnect();
    await assert.rejects(() => pending, /Failed to connect to pool-shut-1/);
    assert.strictEqual(created[0].disposed, true, 'in-flight client disposed after disposal');
    assert.strictEqual(pool.size, 0, 'a resolved attempt must not re-populate the pool');
    await assert.rejects(() => pool.get('pool-shut-1'), /disposed/);
    ok('disposeAll during an in-flight connect rejects it and keeps the pool empty');
  }

  // ── disposeAll during the liveness probe must not return a dead conn ──
  {
    const created = [];
    const pool = makePool({ 'pool-live-2': { host: '10.8.0.1' } }, created);
    const conn = await pool.get('pool-live-2');
    /** @type {(v?: undefined) => void} */
    let releasePing = () => undefined;
    conn.ping = async () => {
      await new Promise((resolve) => {
        releasePing = resolve;
      });
      return true;
    };

    const pending = pool.get('pool-live-2');
    await new Promise((resolve) => setImmediate(resolve)); // probe now in flight
    pool.disposeAll(); // shutdown while the probe is pending
    releasePing();
    await assert.rejects(() => pending, /disposed/);
    assert.strictEqual(conn.disposed, true, 'probe survivor was disposed by disposeAll');
    assert.strictEqual(pool.size, 0);
    ok('disposeAll during the liveness probe rejects get() instead of returning a dead connection');
  }

  // ── a timed-out Windows command evicts the connection (PR #9) ──────────
  {
    const created = [];
    const pool = makePool({ 'pool-win-1': { host: '10.5.0.1', platform: 'windows' } }, created);
    const conn = await pool.get('pool-win-1');
    conn.execCommand = async () => {
      throw new Error('Command timeout after 5000ms');
    };
    await assert.rejects(() =>
      execCommandWithTimeout(pool, conn, 'Get-Date', { platform: 'windows' }, 5000)
    );
    assert.strictEqual(pool.size, 0, 'timed-out Windows command must evict the connection');
    assert.strictEqual(conn.disposed, true, 'evicted connection disposed');
    ok('timed-out Windows command evicts the pooled connection like the POSIX path');
  }

  console.log(`\n✅ connection pool tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
