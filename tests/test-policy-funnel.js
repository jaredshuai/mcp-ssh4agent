/**
 * Policy funnel tests (issue #6).
 *
 * wrapWithPolicy is the single place that enforces the per-server policy gate
 * and writes the audit trail for every tool call. These tests drive it with
 * injected deps — no MCP server, no config, no network.
 */

import assert from 'assert';
import { wrapWithPolicy } from '../src/tool-registry.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

function makeDeps() {
  const calls = { policy: [], audits: [], expanded: [] };
  return {
    calls,
    deps: {
      applyServerPolicy: async (server, tool, args, command) => {
        calls.policy.push({ server, tool, args, command });
        return calls.nextDenial || null;
      },
      auditOk: async (server, tool, args, result) => {
        calls.audits.push({ server, tool, args, result });
      },
      expandCommandAlias: (command) => {
        calls.expanded.push(command);
        return command === 'deploy-it' ? 'rm -rf /srv/app' : command;
      },
    },
  };
}

async function main() {
  // ── default server gate ────────────────────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    const handler = wrapWithPolicy('ssh_upload', async () => ({ content: [] }), {}, deps);
    await handler({ server: 'prod', localPath: 'a', remotePath: 'b' });

    assert.strictEqual(calls.policy.length, 1, 'policy evaluated once');
    assert.strictEqual(calls.policy[0].server, 'prod');
    assert.strictEqual(calls.policy[0].tool, 'ssh_upload');
    assert.strictEqual(calls.policy[0].command, undefined, 'no command for plain gate');
    assert.strictEqual(calls.audits.length, 1, 'success audit written');
    assert.strictEqual(calls.audits[0].result.success, true);
    ok('default gate: policy before handler, audit after success');
  }

  // ── denial short-circuits the handler ──────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    calls.nextDenial = { content: [{ type: 'text', text: 'denied' }], isError: true };
    let handlerRan = false;
    const handler = wrapWithPolicy(
      'ssh_upload',
      async () => {
        handlerRan = true;
      },
      {},
      deps
    );
    const response = await handler({ server: 'prod' });

    assert.strictEqual(handlerRan, false, 'handler must not run when denied');
    assert.strictEqual(response.isError, true, 'denial response passed through');
    assert.strictEqual(calls.audits.length, 0, 'no success audit on denial (denial audit is written by applyServerPolicy)');
    ok('denial short-circuits: handler skipped, denial returned');
  }

  // ── failure paths always audited ───────────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    const handler = wrapWithPolicy(
      'ssh_upload',
      async () => ({ content: [], isError: true }),
      {},
      deps
    );
    await handler({ server: 'prod' });
    assert.strictEqual(calls.audits[0].result.success, false, 'isError response audited as failure');

    const throwing = wrapWithPolicy(
      'ssh_upload',
      async () => {
        throw new Error('boom');
      },
      {},
      deps
    );
    await assert.rejects(() => throwing({ server: 'prod' }), /boom/);
    assert.strictEqual(calls.audits[1].result.success, false, 'thrown handler audited as failure');
    assert.strictEqual(calls.audits[1].result.error, 'boom');
    ok('audit written on BOTH failure paths (isError response and throw)');
  }

  // ── exitCode passthrough ───────────────────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    const handler = wrapWithPolicy(
      'ssh_execute',
      async () => ({ content: [], exitCode: 127 }),
      { commandArg: 'command' },
      deps
    );
    await handler({ server: 'prod', command: 'ls' });
    assert.strictEqual(calls.audits[0].result.code, 127, 'exitCode lands in the audit entry');
    ok('handler exitCode feeds the audit entry');
  }

  // ── commandArg + expandAlias ───────────────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    const handler = wrapWithPolicy(
      'ssh_execute',
      async () => ({ content: [] }),
      { commandArg: 'command', expandAlias: true },
      deps
    );
    await handler({ server: 'prod', command: 'deploy-it' });

    assert.deepStrictEqual(calls.expanded, ['deploy-it'], 'command alias expanded');
    assert.strictEqual(
      calls.policy[0].command,
      'rm -rf /srv/app',
      'policy matches the EXPANDED command, not the alias'
    );
    ok('commandArg: policy matches the alias-expanded command');
  }

  // ── explicit exemptions ────────────────────────────────────────────────
  for (const gate of /** @type {('exempt' | 'manual')[]} */ (['exempt', 'manual'])) {
    const { calls, deps } = makeDeps();
    const original = async (args) => ({ content: [], marker: args.server });
    const handler = wrapWithPolicy('ssh_download', original, { gate }, deps);
    const response = await handler({ server: 'prod' });

    assert.strictEqual(calls.policy.length, 0, `${gate}: no policy evaluation`);
    assert.strictEqual(calls.audits.length, 0, `${gate}: no funnel audit`);
    assert.strictEqual(response.marker, 'prod', `${gate}: handler returned as-is`);
    ok(`gate '${gate}' is explicit: no policy, no audit, handler untouched`);
  }

  // ── conditional gate (when) ────────────────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    const handler = wrapWithPolicy(
      'ssh_process_manager',
      async () => ({ content: [] }),
      { when: (args) => args.action === 'kill' },
      deps
    );

    await handler({ server: 'prod', action: 'list' });
    assert.strictEqual(calls.policy.length, 0, 'list action skips the gate');
    assert.strictEqual(calls.audits.length, 1, 'but is still audited');

    await handler({ server: 'prod', action: 'kill', pid: 42 });
    assert.strictEqual(calls.policy.length, 1, 'kill action is gated');
    ok('when(): only matching invocations are gated; all are audited');
  }

  // ── serverFrom (session-style subjects) ────────────────────────────────
  {
    const { calls, deps } = makeDeps();
    const handler = wrapWithPolicy(
      'ssh_session_send',
      async () => ({ content: [] }),
      { serverFrom: (args) => (args.session === 's1' ? 'web-1' : undefined), commandArg: 'command' },
      deps
    );

    await handler({ session: 's1', command: 'uptime' });
    assert.strictEqual(calls.policy[0].server, 'web-1', 'subject from serverFrom');
    assert.strictEqual(calls.policy[0].command, 'uptime');

    calls.policy.length = 0;
    await handler({ session: 'missing', command: 'uptime' });
    assert.strictEqual(calls.policy.length, 0, 'unresolvable subject → no gate');
    assert.strictEqual(calls.audits.length, 1, 'and no audit (no subject)');
    ok('serverFrom derives the policy subject (and skips cleanly when unresolvable)');
  }

  console.log(`\n✅ policy funnel tests passed (${passed} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
