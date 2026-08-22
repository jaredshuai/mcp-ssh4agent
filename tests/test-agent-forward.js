// Behavioural test for issue #52: per-server SSH agent forwarding.
// Verifies how SSHManager.connect() wires ssh2's `agentForward` connection
// option — the option is only ever set alongside a valid `agent`, because ssh2
// THROWS ("You must set a valid agent path to allow agent forwarding") if
// agentForward is true without an agent. We drive connect() with a stubbed ssh2
// client that captures the connConfig instead of opening a socket.
import assert from 'assert';
import SSHManager from '../src/ssh-manager.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

// Run connect() with a fake ssh2 client and return the connConfig it built.
// authSock === null removes SSH_AUTH_SOCK for the call; a string sets it.
// The original environment is always restored.
function captureConnConfig(config, authSock) {
  const had = Object.hasOwn(process.env, 'SSH_AUTH_SOCK');
  const prev = process.env.SSH_AUTH_SOCK;
  if (authSock === null) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = authSock;

  try {
    const mgr = new SSHManager(config);
    let captured = null;
    mgr.client = {
      // no-op event stubs — the fake client never emits
      on: () => {
        /* noop */
      },
      once: () => {
        /* noop */
      },
      // connect() builds connConfig synchronously then calls client.connect();
      // capturing here is enough. The returned promise never resolves (no
      // 'ready' event) so we deliberately ignore it.
      connect: (cfg) => {
        captured = cfg;
      },
    };
    mgr.connect().catch(() => {
      /* expected to never resolve */
    });
    return captured;
  } finally {
    if (had) process.env.SSH_AUTH_SOCK = prev;
    else delete process.env.SSH_AUTH_SOCK;
  }
}

const base = { host: 'example.com', user: 'demo' };

function testForwardingEnabled() {
  const cfg = captureConnConfig({ ...base, forwardAgent: true }, '/tmp/agent.sock');
  assert.strictEqual(cfg.agent, '/tmp/agent.sock', 'agent must be set from SSH_AUTH_SOCK');
  assert.strictEqual(
    cfg.agentForward,
    true,
    'agentForward must be true when forwardAgent + agent are set'
  );
  ok('forwardAgent:true with SSH_AUTH_SOCK present enables agentForward');
}

function testForwardingDisabledExplicitly() {
  const cfg = captureConnConfig({ ...base, forwardAgent: false }, '/tmp/agent.sock');
  assert.strictEqual(cfg.agent, '/tmp/agent.sock', 'agent still set for normal agent auth');
  assert.strictEqual(
    cfg.agentForward,
    undefined,
    'agentForward must stay unset when forwardAgent is false'
  );
  ok('forwardAgent:false leaves agentForward unset (agent auth unaffected)');
}

function testForwardingDefaultOff() {
  const cfg = captureConnConfig({ ...base }, '/tmp/agent.sock');
  assert.strictEqual(cfg.agentForward, undefined, 'agentForward must default to unset');
  ok('no forwardAgent field → agentForward unset (opt-in default off)');
}

function testNoAgentNoForwardNoThrow() {
  // The critical guard: forwardAgent requested but no agent available. ssh2
  // would throw if agentForward were set without agent, so connect() must set
  // neither. captureConnConfig would surface a throw as an unhandled rejection;
  // reaching the assertions with a captured config proves no synchronous throw.
  const cfg = captureConnConfig({ ...base, forwardAgent: true }, null);
  assert.strictEqual(cfg.agent, undefined, 'no agent when SSH_AUTH_SOCK is absent');
  assert.strictEqual(
    cfg.agentForward,
    undefined,
    'agentForward must not be set without an agent (would make ssh2 throw)'
  );
  ok('forwardAgent:true without SSH_AUTH_SOCK sets neither agent nor agentForward (no ssh2 throw)');
}

function main() {
  testForwardingEnabled();
  testForwardingDisabledExplicitly();
  testForwardingDefaultOff();
  testNoAgentNoForwardNoThrow();
  console.log(`\n✅ agent forwarding tests passed (${passed} checks)`);
}

main();
