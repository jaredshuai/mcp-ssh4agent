/**
 * Test Suite for src/server-fields.js — the shared field table.
 *
 * Locks the contract BOTH sides depend on:
 *  - table integrity (unique camel/env keys, no cross-field TOML alias clashes)
 *  - quoting rules for .env export lines (the drift that motivated the table:
 *    the CLI used to write PASSWORD= unquoted, the server exported "quoted")
 *  - value coercion (int / bool-absent-is-false / lowercase / pattern lists)
 *  - CLI-writes → server-reads round-trip through the REAL writers:
 *    cli/lib/config.ts add_server_to_env / update_server_in_env produce a file
 *    that src/config-loader.js parses back into the expected camelCase config,
 *    including passwords containing quotes, spaces, `#` and `$()`.
 *
 * This closes the gap noted on test-config-field-names.js, which only locks
 * the server side. Run via tsx (imports the CLI's TypeScript directly):
 *   npx tsx tests/test-server-fields.ts
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVER_FIELDS,
  FIELD_BY_CAMEL,
  serverEnvLine,
  serverFromEnvRecord,
  serverFromTomlRecord,
  canonicalTomlKey,
} from '../src/server-fields.js';
import { ConfigLoader } from '../src/config-loader.js';

let passed = 0;
let failed = 0;
function ok(label: string) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }
function bad(label: string, e: Error) { console.log(`\x1b[31m✗\x1b[0m ${passed + 1}. ${label}\n  ${e.message}`); failed++; }
function test(label: string, fn: () => void) {
  try { fn(); ok(label); } catch (e) { bad(label, e as Error); }
}

async function asyncTest(label: string, fn: () => Promise<void>) {
  try { await fn(); ok(label); } catch (e) { bad(label, e as Error); }
}

const spec = (camel: string) => {
  const s = FIELD_BY_CAMEL.get(camel);
  assert.ok(s, `field ${camel} must exist`);
  return s!;
};

// ── Table integrity ──────────────────────────────────────────────────────────

test('every field has non-empty camel, env and toml keys', () => {
  for (const f of SERVER_FIELDS) {
    assert.ok(f.camel && f.env && f.toml.length > 0, JSON.stringify(f));
  }
});

test('camel and env keys are unique', () => {
  const camels = SERVER_FIELDS.map((f) => f.camel);
  const envs = SERVER_FIELDS.map((f) => f.env);
  assert.equal(new Set(camels).size, camels.length);
  assert.equal(new Set(envs).size, envs.length);
});

test('TOML aliases never clash across fields', () => {
  const all = SERVER_FIELDS.flatMap((f) => f.toml);
  assert.equal(new Set(all).size, all.length);
});

test('the expected fields are all present (superset check)', () => {
  for (const camel of [
    'host', 'user', 'password', 'keyPath', 'passphrase', 'port', 'defaultDir',
    'sudoPassword', 'description', 'group', 'platform', 'proxyJump',
    'proxyCommand', 'forwardAgent', 'mode', 'allowPatterns', 'denyPatterns', 'auditLog',
  ]) {
    assert.ok(FIELD_BY_CAMEL.has(camel), camel);
  }
});

// ── env line rendering (quoting rules) ──────────────────────────────────────

test('free-form values are double-quoted, machine values are not', () => {
  assert.equal(serverEnvLine('S', spec('host'), 'h1'), 'SSH_SERVER_S_HOST=h1');
  assert.equal(serverEnvLine('S', spec('password'), 'pw'), 'SSH_SERVER_S_PASSWORD="pw"');
  assert.equal(serverEnvLine('S', spec('sudoPassword'), 'pw'), 'SSH_SERVER_S_SUDO_PASSWORD="pw"');
  assert.equal(serverEnvLine('S', spec('description'), 'd'), 'SSH_SERVER_S_DESCRIPTION="d"');
  assert.equal(serverEnvLine('S', spec('group'), 'g'), 'SSH_SERVER_S_GROUP="g"');
  assert.equal(serverEnvLine('S', spec('keyPath'), '/k'), 'SSH_SERVER_S_KEYPATH=/k');
  assert.equal(serverEnvLine('S', spec('mode'), 'readonly'), 'SSH_SERVER_S_MODE=readonly');
  assert.equal(serverEnvLine('S', spec('port'), 22), 'SSH_SERVER_S_PORT=22');
});

test('pattern lists join with ; inside quotes', () => {
  assert.equal(
    serverEnvLine('S', spec('allowPatterns'), ['^ls', '^cat']),
    'SSH_SERVER_S_ALLOW_PATTERNS="^ls;^cat"',
  );
});

// ── coercion ─────────────────────────────────────────────────────────────────

test('int coercion: numeric string becomes number', () => {
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_PORT: '2222' }, 'S').port, 2222);
});

test('bool coercion: absent → explicit false, truthy strings → true', () => {
  assert.equal(serverFromEnvRecord({}, 'S').forwardAgent, false);
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_FORWARD_AGENT: 'true' }, 'S').forwardAgent, true);
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_FORWARD_AGENT: 'yes' }, 'S').forwardAgent, true);
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_FORWARD_AGENT: 'false' }, 'S').forwardAgent, false);
  assert.equal(serverFromTomlRecord({ forward_agent: true }).forwardAgent, true);
  assert.equal(serverFromTomlRecord({}).forwardAgent, false);
});

test('lowercase coercion: platform normalizes', () => {
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_PLATFORM: 'Windows' }, 'S').platform, 'windows');
  assert.equal(serverFromTomlRecord({ platform: 'LINUX' }).platform, 'linux');
});

test('patternList coercion: TOML arrays and ;-strings both become string[]', () => {
  assert.deepEqual(serverFromTomlRecord({ allow_patterns: ['^a', '^b'] }).allowPatterns, ['^a', '^b']);
  assert.deepEqual(serverFromTomlRecord({ allow_patterns: '^a; ^b' }).allowPatterns, ['^a', '^b']);
});

test('TOML alias chains resolve first-wins', () => {
  assert.equal(serverFromTomlRecord({ key_path: '/a', keypath: '/b', ssh_key: '/c' }).keyPath, '/a');
  assert.equal(serverFromTomlRecord({ keypath: '/b', ssh_key: '/c' }).keyPath, '/b');
  assert.equal(serverFromTomlRecord({ ssh_key: '/c' }).keyPath, '/c');
  assert.equal(serverFromTomlRecord({ user: 'u', username: 'v' }).user, 'u');
  assert.equal(serverFromTomlRecord({ username: 'v' }).user, 'v');
  assert.equal(serverFromTomlRecord({ default_directory: '/x' }).defaultDir, '/x');
  assert.equal(serverFromTomlRecord({ cwd: '/y' }).defaultDir, '/y');
  assert.equal(serverFromTomlRecord({ proxycommand: 'nc %h %p' }).proxyCommand, 'nc %h %p');
});

test('canonical TOML export key is the first alias', () => {
  assert.equal(canonicalTomlKey(spec('keyPath')), 'key_path');
  assert.equal(canonicalTomlKey(spec('sudoPassword')), 'sudo_password');
  assert.equal(canonicalTomlKey(spec('forwardAgent')), 'forward_agent');
});

// ── CLI writes → server reads round-trip (the drift killer) ─────────────────

const NASTY_PASSWORDS = ['Jx"ds$2016', "pa';ss", 'a b c', 'trailing#hash', 'semi;colon'];

async function roundTrip(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-fields-rt-'));
  const envPath = path.join(dir, '.env');

  // Point the CLI's module-level SSH_MANAGER_ENV at the temp file BEFORE
  // importing cli/lib/config.ts (it resolves the path at import time).
  process.env.SSH_MANAGER_ENV = envPath;
  const cli = await import('../cli/lib/config.ts');

  for (const pw of NASTY_PASSWORDS) {
    const name = 'rt_' + Buffer.from(pw).toString('hex').slice(0, 10);
    const added = cli.add_server_to_env(
      name, '203.0.113.10', 'demo', 'password', pw, '2222',
      'desc with spaces', 'readonly', '^ls;^df', '',
    );
    assert.ok(added, `add_server_to_env(${name}) must succeed`);

    const loader = new ConfigLoader();
    loader.loadEnvConfig(envPath);
    const server = loader.getServer(name);
    assert.ok(server, `server ${name} must load back`);
    assert.equal(server.host, '203.0.113.10');
    assert.equal(server.user, 'demo');
    assert.equal(server.port, 2222);
    assert.equal(server.password, pw, `password round-trip failed for ${JSON.stringify(pw)}`);
    assert.equal(server.description, 'desc with spaces');
    assert.equal(server.mode, 'readonly');
    assert.deepEqual(server.allowPatterns, ['^ls', '^df']);
  }

  // update path: add a plain server, then rewrite it with a defaultDir
  assert.ok(cli.add_server_to_env('rt_plain', '198.51.100.1', 'op', 'password', 'first-pw'));
  const cli2 = cli as unknown as {
    update_server_in_env: (n: string, h: string, u: string, a: string, v: string, p?: string, d?: string, dd?: string) => boolean;
  };
  assert.ok(cli2.update_server_in_env(
    'rt_plain', '198.51.100.1', 'op', 'password', 'up-pw', '22', '', '/opt/app',
  ));
  const loader2 = new ConfigLoader();
  loader2.loadEnvConfig(envPath);
  const updated = loader2.getServer('rt_plain');
  assert.ok(updated);
  assert.equal(updated.defaultDir, '/opt/app');
  assert.equal(updated.password, 'up-pw');
}

await asyncTest('CLI add/update writes load back through ConfigLoader (incl. hostile passwords)', roundTrip);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
