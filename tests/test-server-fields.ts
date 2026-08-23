/**
 * Test Suite for src/server-fields.ts — the shared field table.
 *
 * Locks the contract BOTH sides depend on:
 *  - table integrity (unique camel/env keys, no cross-field TOML alias clashes)
 *  - quoting rules for .env export lines (the drift that motivated the table:
 *    the CLI used to write PASSWORD= unquoted, the server exported "quoted")
 *  - value coercion (int / bool-absent-is-false / lowercase / pattern lists)
 *  - CLI-writes → server-reads round-trip through the REAL writers:
 *    cli/lib/config.ts add_server_to_env / update_server_in_env produce a file
 *    that src/config-loader.ts parses back into the expected camelCase config,
 *    including passwords containing quotes, spaces, `#` and `$()`.
 *
 * This closes the gap noted on test-config-field-names.js, which only locks
 * the server side. Run natively with Node's type stripping (imports the CLI's TypeScript directly):
 *   node tests/test-server-fields.ts
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
  parseEnvServersText,
} from '../src/server-fields.ts';
import { ConfigLoader } from '../src/config-loader.ts';

let passed = 0;
let failed = 0;
function ok(label: string) {
  console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`);
  passed++;
}
function bad(label: string, e: Error) {
  console.log(`\x1b[31m✗\x1b[0m ${passed + 1}. ${label}\n  ${e.message}`);
  failed++;
}
function test(label: string, fn: () => void) {
  try {
    fn();
    ok(label);
  } catch (e) {
    bad(label, e as Error);
  }
}

async function asyncTest(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    bad(label, e as Error);
  }
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
    'host',
    'user',
    'password',
    'keyPath',
    'passphrase',
    'port',
    'defaultDir',
    'sudoPassword',
    'description',
    'group',
    'platform',
    'proxyJump',
    'proxyCommand',
    'forwardAgent',
    'mode',
    'allowPatterns',
    'denyPatterns',
    'auditLog',
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
    'SSH_SERVER_S_ALLOW_PATTERNS="^ls;^cat"'
  );
});

// The CLI read path (get_server_config → parseEnvServersText) does NOT use
// the dotenv library — these tests lock its local parser to the same
// semantics for the writer's unescaped-interior-quote format (PR #9).
test('parseEnvServersText keeps interior quotes in fully-quoted values', () => {
  const lines = [
    serverEnvLine('Q', spec('host'), '203.0.113.10'),
    serverEnvLine('Q', spec('password'), 'Jx"ds$2016'),
    serverEnvLine('Q', spec('sudoPassword'), "pa';ss"),
  ].join('\n');
  const record = parseEnvServersText(lines).get('q');
  assert.ok(record, 'server must parse from the HOST anchor');
  assert.equal(record.host, '203.0.113.10');
  assert.equal(record.password, 'Jx"ds$2016', 'double quote inside a password must survive');
  assert.equal(record.sudoPassword, "pa';ss", 'apostrophe inside a password must survive');
});

test('parseEnvServersText stops at the first close quote before trailing content', () => {
  const lines = [
    serverEnvLine('C', spec('host'), '198.51.100.2'),
    'SSH_SERVER_C_DESCRIPTION="a description" # trailing comment',
    // The pathological round-3 case: the comment itself ends with the
    // delimiter quote — a greedy outer-strip would swallow the comment.
    'SSH_SERVER_C_GROUP="g1" # note ending with a "quote"',
  ].join('\n');
  const record = parseEnvServersText(lines).get('c');
  assert.ok(record);
  assert.equal(record.description, 'a description', 'comment after the close quote is ignored');
  assert.equal(record.group, 'g1', 'comment ending with a quote is still just a comment');
});

// Round-4 case: an interior quote followed by `#` inside a credential.
// The writer avoids the ambiguity by alternating the delimiter
// (single-quoted when the value contains `"` but no `'`), and the reader
// is the REAL dotenv parser — same bytes, same result on both sides.
test('credentials with interior quote + # round-trip via alternating quotes', () => {
  const lines = [
    serverEnvLine('H', spec('host'), '203.0.113.7'),
    serverEnvLine('H', spec('password'), 'a"#b'),
  ].join('\n');
  const record = parseEnvServersText(lines).get('h');
  assert.ok(record);
  assert.equal(record.password, 'a"#b', 'quote+hash password survives via single-quoting');
});

// Round-5: a value with BOTH quote characters is unrepresentable — dotenv
// escapes are not unescaped by dotenv.parse, so any escaping silently
// corrupts the credential. The writer must refuse instead of mangling.
test('values containing both quote characters are rejected, not mangled', () => {
  assert.throws(
    () => serverEnvLine('B', spec('password'), `x'"y`),
    /both quote characters.*TOML/s,
    'writer must throw for mixed-quote credentials'
  );
});

// Round-6: the rejection is gated on quoting being REQUIRED. Interior
// quotes alone never force quoting (dotenv's unquoted alternative passes
// them through verbatim), so a mixed-quote PATH with no #/whitespace
// round-trips unquoted instead of being refused.
test('mixed-quote values that need no quoting round-trip unquoted', () => {
  const lines = [
    serverEnvLine('U', spec('host'), '203.0.113.9'),
    serverEnvLine('U', spec('keyPath'), `/keys/a'b"c/id_rsa`),
    // r7: an UNPAIRED leading delimiter also needs no quoting — dotenv's
    // quoted alternative requires a closing delimiter at end-of-value, so
    // this falls through to the verbatim unquoted alternative.
    serverEnvLine('U', spec('auditLog'), '`a\'b"c'),
  ].join('\n');
  const record = parseEnvServersText(lines).get('u');
  assert.ok(record);
  assert.equal(record.keyPath, `/keys/a'b"c/id_rsa`, 'mixed-quote path survives unquoted');
  assert.equal(record.auditLog, '`a\'b"c', 'unpaired leading backtick survives unquoted');
});

// r7 counterpart: a PAIRED leading delimiter DOES require quoting — dotenv
// would strip the outer pair of e.g. 'abc' and reshape the value.
test('paired leading delimiter still forces quoting', () => {
  const line = serverEnvLine('P', spec('keyPath'), "'abc'");
  assert.equal(line, `SSH_SERVER_P_KEYPATH="'abc'"`, 'paired quotes are double-wrapped');
  const record = parseEnvServersText(serverEnvLine('P', spec('host'), 'h') + '\n' + line).get('p');
  assert.equal(record.keyPath, "'abc'", 'the literal outer quotes survive the round-trip');
});

// Round-5: machine fields (key path, audit-log path...) containing `#` are
// just as truncatable as passwords — quoting is content-driven now.
test('machine values containing # are quoted and round-trip', () => {
  const lines = [
    serverEnvLine('M', spec('host'), '203.0.113.8'),
    serverEnvLine('M', spec('keyPath'), '/keys/vault#2/id_rsa'),
    serverEnvLine('M', spec('auditLog'), '/var/log/audit#ops.jsonl'),
    // Values without special characters stay unquoted (wire format stable).
    serverEnvLine('M', spec('port'), 22),
  ].join('\n');
  const record = parseEnvServersText(lines).get('m');
  assert.ok(record);
  assert.equal(record.keyPath, '/keys/vault#2/id_rsa', 'hash in key path survives');
  assert.equal(record.auditLog, '/var/log/audit#ops.jsonl', 'hash in audit-log path survives');
  assert.equal(record.port, 22, 'plain machine value still unquoted');
});

// ── coercion ─────────────────────────────────────────────────────────────────

test('int coercion: numeric string becomes number', () => {
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_PORT: '2222' }, 'S').port, 2222);
});

test('bool coercion: absent → explicit false, truthy strings → true', () => {
  assert.equal(serverFromEnvRecord({}, 'S').forwardAgent, false);
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_FORWARD_AGENT: 'true' }, 'S').forwardAgent, true);
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_FORWARD_AGENT: 'yes' }, 'S').forwardAgent, true);
  assert.equal(
    serverFromEnvRecord({ SSH_SERVER_S_FORWARD_AGENT: 'false' }, 'S').forwardAgent,
    false
  );
  assert.equal(serverFromTomlRecord({ forward_agent: true }).forwardAgent, true);
  assert.equal(serverFromTomlRecord({}).forwardAgent, false);
});

test('lowercase coercion: platform normalizes', () => {
  assert.equal(serverFromEnvRecord({ SSH_SERVER_S_PLATFORM: 'Windows' }, 'S').platform, 'windows');
  assert.equal(serverFromTomlRecord({ platform: 'LINUX' }).platform, 'linux');
});

test('patternList coercion: TOML arrays and ;-strings both become string[]', () => {
  assert.deepEqual(serverFromTomlRecord({ allow_patterns: ['^a', '^b'] }).allowPatterns, [
    '^a',
    '^b',
  ]);
  assert.deepEqual(serverFromTomlRecord({ allow_patterns: '^a; ^b' }).allowPatterns, ['^a', '^b']);
});

test('TOML alias chains resolve first-wins', () => {
  assert.equal(
    serverFromTomlRecord({ key_path: '/a', keypath: '/b', ssh_key: '/c' }).keyPath,
    '/a'
  );
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

  // Point the CLI's module-level SSH4AGENT_ENV at the temp file BEFORE
  // importing cli/lib/config.ts (it resolves the path at import time).
  process.env.SSH4AGENT_ENV = envPath;
  const cli = await import('../cli/lib/config.ts');

  for (const pw of NASTY_PASSWORDS) {
    const name = 'rt_' + Buffer.from(pw).toString('hex').slice(0, 10);
    const added = cli.add_server_to_env(
      name,
      '203.0.113.10',
      'demo',
      'password',
      pw,
      '2222',
      'desc with spaces',
      'readonly',
      '^ls;^df',
      ''
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
    update_server_in_env: (
      n: string,
      h: string,
      u: string,
      a: string,
      v: string,
      p?: string,
      d?: string,
      dd?: string
    ) => boolean;
  };
  assert.ok(
    cli2.update_server_in_env(
      'rt_plain',
      '198.51.100.1',
      'op',
      'password',
      'up-pw',
      '22',
      '',
      '/opt/app'
    )
  );
  const loader2 = new ConfigLoader();
  loader2.loadEnvConfig(envPath);
  const updated = loader2.getServer('rt_plain');
  assert.ok(updated);
  assert.equal(updated.defaultDir, '/opt/app');
  assert.equal(updated.password, 'up-pw');

  // ── mixed-quote values are rejected BEFORE any file mutation (r5) ────
  const linesBefore = fs.readFileSync(envPath, 'utf8');
  const rejected = cli.add_server_to_env('mq', '198.51.100.7', 'op', 'password', `p'"q`);
  assert.equal(rejected, false, 'add must refuse a mixed-quote credential');
  assert.equal(
    fs.readFileSync(envPath, 'utf8'),
    linesBefore,
    'a rejected add must not touch the .env file'
  );

  // ── but only when quoting is required (r6): a key path with interior
  // quotes and no #/whitespace is representable unquoted and must add.
  const keyOk = cli.add_server_to_env('mqkey', '198.51.100.8', 'op', 'key', `/k'a"b`);
  assert.equal(keyOk, true, 'mixed-quote key path without #/space must be accepted');
  const loaderK = new ConfigLoader();
  loaderK.loadEnvConfig(envPath);
  assert.equal(loaderK.getServer('mqkey')?.keyPath, `/k'a"b`, 'key path round-trips unquoted');

  // ── case-insensitive markers (r3) ─────────────────────────────────────
  // Hand-authored mixed-case entry: listed as `cased` by load_servers().
  // add must detect the duplicate despite the casing mismatch, and update
  // must find and rewrite it (previously both were case-sensitive misses
  // while remove worked — the flows disagreed).
  fs.appendFileSync(
    envPath,
    [
      'SSH_SERVER_Cased_HOST=203.0.113.99',
      'SSH_SERVER_Cased_USER=demo',
      'SSH_SERVER_Cased_PASSWORD="pw"',
      '',
    ].join('\n'),
    'utf8'
  );
  const dup = cli.add_server_to_env('cased', '198.51.100.9', 'op', 'password', 'x');
  assert.equal(dup, false, 'add must refuse a mixed-case existing entry');
  const updatedCased = cli2.update_server_in_env(
    'cased',
    '203.0.113.99',
    'demo',
    'password',
    'new-pw',
    '22'
  );
  assert.equal(updatedCased, true, 'update must find a mixed-case entry');
  const loader3 = new ConfigLoader();
  loader3.loadEnvConfig(envPath);
  const cased = loader3.getServer('cased');
  assert.ok(cased, 'rewritten entry still loads');
  assert.equal(cased.password, 'new-pw', 'update rewrote the cased entry');

  // ── field-anchored removal (r4) ──────────────────────────────────────
  // `server remove foo` used to match `^SSH_SERVER_FOO_` as a bare prefix
  // and took `foo_bar`'s lines with it.
  assert.ok(cli.add_server_to_env('pfx', '198.51.100.3', 'op', 'password', 'p1'));
  assert.ok(cli.add_server_to_env('pfx_web', '198.51.100.4', 'op', 'password', 'p2'));
  assert.ok(cli.remove_server_from_env('pfx'), 'remove pfx must succeed');
  const loader4 = new ConfigLoader();
  loader4.loadEnvConfig(envPath);
  assert.equal(loader4.getServer('pfx'), undefined, 'pfx removed');
  assert.ok(loader4.getServer('pfx_web'), 'pfx_web must survive removing pfx');
  assert.equal(loader4.getServer('pfx_web')?.password, 'p2', 'pfx_web data intact');

  // Same for update: rewriting pfx2 must not touch pfx2_web.
  assert.ok(cli.add_server_to_env('pfx2', '198.51.100.5', 'op', 'password', 'q1'));
  assert.ok(cli.add_server_to_env('pfx2_web', '198.51.100.6', 'op', 'password', 'q2'));
  assert.ok(
    cli2.update_server_in_env('pfx2', '198.51.100.5', 'op', 'password', 'q3'),
    'update pfx2 must succeed'
  );
  const loader5 = new ConfigLoader();
  loader5.loadEnvConfig(envPath);
  assert.equal(loader5.getServer('pfx2')?.password, 'q3', 'pfx2 rewritten');
  assert.equal(loader5.getServer('pfx2_web')?.password, 'q2', 'pfx2_web untouched by pfx2 update');
}

await asyncTest(
  'CLI add/update writes load back through ConfigLoader (incl. hostile passwords + mixed-case markers)',
  roundTrip
);

// ── migration transaction in fresh subprocesses (r7) ────────────────────────
// The migration runs at module import time; these scenarios need processes
// with a controlled HOME and no SSH4AGENT_* overrides.
async function migrationGuards(): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const configTs = path.resolve('cli/lib/config.ts');
  const script = `import(${JSON.stringify(configTs)}).then(()=>0,(e)=>{console.error(e);process.exit(1)})`;
  const cleanEnv = (extra: Record<string, string>): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        typeof v === 'string' &&
        !k.startsWith('SSH4AGENT') &&
        k !== 'SSH_ENV_PATH' &&
        !k.startsWith('SSH_SERVER_')
      ) {
        env[k] = v;
      }
    }
    return { ...env, ...extra };
  };
  const run = (home: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, ['-e', script], {
      env: cleanEnv({ HOME: home, ...extra }),
      cwd: home,
      encoding: 'utf8',
    });

  // Phase 1 fails (legacy .env is a DIRECTORY → copyFileSync EISDIR) while
  // legacy config.json exists: Phase 2 must NOT recreate the home, or the
  // run splits servers (legacy .env) from CLI settings (new home).
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-fail-'));
    const legacy = path.join(home, '.ssh-manager');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(path.join(legacy, '.env')); // directory → the copy throws
    fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
    const r = run(home, {});
    assert.equal(r.status, 0, `subprocess must survive: ${r.stderr}`);
    assert.equal(
      fs.existsSync(path.join(home, '.ssh4agent')),
      false,
      'a failed .env migration must abort the settings phase for this run'
    );
    fs.rmSync(home, { recursive: true, force: true });
  }

  // An explicit SSH4AGENT_HOME is isolation intent: legacy files must not
  // be copied into the deliberately selected home.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-iso-'));
    const legacy = path.join(home, '.ssh-manager');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '.env'), 'SSH_SERVER_X_HOST=203.0.113.10\n');
    fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
    const explicit = path.join(home, 'explicit-home');
    const r = run(home, { SSH4AGENT_HOME: explicit });
    assert.equal(r.status, 0, `subprocess must survive: ${r.stderr}`);
    assert.equal(
      fs.existsSync(explicit),
      false,
      'an explicit SSH4AGENT_HOME must disable automatic legacy migration'
    );
    fs.rmSync(home, { recursive: true, force: true });
  }
}

await asyncTest(
  'migration: phase-1 failure aborts phase 2; explicit home disables migration',
  migrationGuards
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
