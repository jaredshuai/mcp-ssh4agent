/**
 * Remote-tunnel tests driven by an in-memory fake TunnelableConnection
 * (issue #2).
 *
 * Before the TunnelableConnection seam existed, the remote path called
 * `forwardIn` / `on('tcp connection')` / `unforwardIn` on the SSHManager
 * wrapper, which never implemented them — `ssh_tunnel_create` with type
 * "remote" crashed with `TypeError: forwardIn is not a function`. The
 * fake adapter here proves the remote path works end to end without any
 * network: forwardIn is requested, incoming remote connections are piped
 * to the local service, and teardown unforwards.
 */

import assert from 'assert';
import net from 'net';
import { PassThrough } from 'stream';
import { createTunnel, closeTunnel, listTunnels } from '../src/tunnel-manager.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

const HOST = '127.0.0.1';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * In-memory fake of the tunnel side of an ssh2 Client. Records every call so
 * the tests can assert on the remote-forwarding protocol without a network.
 */
function makeFakeConnection() {
  const state = {
    forwardInCalls: [],
    unforwardInCalls: [],
    tcpHandlers: [],
  };
  const fake = {
    async forwardOut(srcAddr, srcPort, dstAddr, dstPort) {
      return new PassThrough();
    },
    forwardIn(remoteAddr, remotePort, callback) {
      state.forwardInCalls.push({ remoteAddr, remotePort });
      if (callback) callback();
    },
    unforwardIn(remoteAddr, remotePort) {
      state.unforwardInCalls.push({ remoteAddr, remotePort });
    },
    on(event, listener) {
      assert.strictEqual(event, 'tcp connection', 'tunnels only subscribe to tcp connection');
      state.tcpHandlers.push(listener);
    },
    removeListener(event, listener) {
      assert.strictEqual(event, 'tcp connection', 'tunnels only detach tcp connection');
      const i = state.tcpHandlers.indexOf(listener);
      if (i !== -1) state.tcpHandlers.splice(i, 1);
    },
    /** Test hook: simulate the remote side opening a connection. */
    emitTcpConnection(info) {
      const socket = new PassThrough();
      for (const handler of state.tcpHandlers) handler(info, () => socket);
      return socket;
    },
  };
  return { fake, state };
}

async function main() {
  // Local "service" the remote tunnel forwards to: echoes each chunk back.
  const echoServer = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const echoPort = await freePort();
  await new Promise((resolve) => echoServer.listen(echoPort, HOST, () => resolve()));

  const { fake, state } = makeFakeConnection();
  const REMOTE = { host: '10.9.8.7', port: 8080 };

  // ── create + forwardIn ──────────────────────────────────────────────────
  const tunnel = await createTunnel('fake-server', fake, {
    type: 'remote',
    localHost: HOST,
    localPort: echoPort,
    remoteHost: REMOTE.host,
    remotePort: REMOTE.port,
  });

  assert.strictEqual(
    state.forwardInCalls.length,
    1,
    'remote tunnel must request exactly one forwardIn'
  );
  assert.deepStrictEqual(state.forwardInCalls[0], {
    remoteAddr: REMOTE.host,
    remotePort: REMOTE.port,
  });
  assert.strictEqual(tunnel.state, 'active', 'tunnel reaches active state');
  ok('remote tunnel starts: forwardIn requested with remote host/port');

  // ── incoming remote connection is piped to the local service ────────────
  const remoteSocket = fake.emitTcpConnection({ destIP: REMOTE.host, destPort: REMOTE.port });

  // Data written by the remote side must reach the echo service and come back.
  const echoed = await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('no echo within 2s')), 2000);
    remoteSocket.on('data', (chunk) => {
      chunks.push(chunk);
      if (chunks.join('') === 'ping-from-remote') {
        clearTimeout(timer);
        resolve(chunks.join(''));
      }
    });
    remoteSocket.write('ping-from-remote');
  });
  assert.strictEqual(echoed, 'ping-from-remote', 'echo round-trip through the tunnel');
  ok('incoming remote connection is forwarded to the local service and back');

  // A connection for a different remote port must be ignored by this tunnel.
  const otherSocket = fake.emitTcpConnection({ destIP: REMOTE.host, destPort: 9999 });
  const before = tunnel.stats.connectionsTotal;
  otherSocket.write('should-be-ignored');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(
    tunnel.stats.connectionsTotal,
    before,
    'connections for other ports must not be counted'
  );
  otherSocket.destroy();
  remoteSocket.destroy();
  ok('connections for a foreign remote port are ignored');

  // ── reconnect must not accumulate handlers ──────────────────────────────
  // reconnect() re-runs start() → startRemoteForwarding() on the SAME
  // emitter; the previous 'tcp connection' handler must be detached or
  // every forwarded connection is dispatched once per stale handler.
  assert.strictEqual(state.tcpHandlers.length, 1, 'one handler after initial start');
  const reconnected = await tunnel.reconnect();
  assert.strictEqual(reconnected, true, 'reconnect succeeds');
  assert.strictEqual(state.forwardInCalls.length, 2, 'reconnect re-requests forwardIn');
  assert.strictEqual(
    state.tcpHandlers.length,
    1,
    'reconnect detaches the stale handler instead of stacking listeners'
  );
  ok('reconnect re-registers exactly one tcp connection handler');

  // ── teardown unforwards ──────────────────────────────────────────────────
  const tunnelId = tunnel.id;
  closeTunnel(tunnelId);
  assert.strictEqual(
    state.unforwardInCalls.length,
    1,
    'closing a remote tunnel must call unforwardIn'
  );
  assert.deepStrictEqual(state.unforwardInCalls[0], {
    remoteAddr: REMOTE.host,
    remotePort: REMOTE.port,
  });
  assert.strictEqual(
    state.tcpHandlers.length,
    0,
    'closing a remote tunnel must detach its tcp connection handler'
  );
  assert.strictEqual(listTunnels().length, 0, 'closed tunnel leaves the registry');
  ok('closeTunnel unforwards the remote port and deregisters the tunnel');

  // ── forwardIn failure surfaces as a rejected createTunnel ────────────────
  const failing = {
    ...fake,
    forwardIn(remoteAddr, remotePort, callback) {
      callback(new Error('administratively prohibited'));
    },
    on() {
      /* no-op: this fake never receives forwarded connections */
    },
  };
  await assert.rejects(
    () =>
      createTunnel('fake-server', failing, {
        type: 'remote',
        localHost: HOST,
        localPort: echoPort,
        remoteHost: REMOTE.host,
        remotePort: REMOTE.port,
      }),
    /administratively prohibited/,
    'a refused forwardIn must reject createTunnel, not crash'
  );
  ok('forwardIn refusal rejects createTunnel cleanly');

  await closeServer(echoServer);
  console.log(`\n✅ remote tunnel tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
