// CLI command tests: the codex / monitor / session command modules.
//
// Everything runs against os.tmpdir() — the real ~/.codex/config.toml is
// never touched. The codex e2e boots the real MCP server through the entry
// `codex setup` writes (setup → test), verifying the full handshake and the
// 37-tool registry.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TOML from '@iarna/toml';
import {
  cmd_codex,
  cmd_codex_setup,
  cmd_codex_migrate,
  cmd_codex_convert,
  cmd_codex_test,
} from '../cli/commands/codex.ts';
import { MONITOR_TYPES, monitorCommandFor } from '../cli/commands/monitor.ts';
import { cmd_session } from '../cli/commands/session.ts';

let passed = 0;
function ok(label) {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}\n`);
  passed++;
}

// Run an async fn with stdout captured (the commands report via stdout).
async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk, ...args) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

// Ambient SSH_SERVER_* variables would bleed into loadEnvConfig and skew the
// server counts; stash them for the duration of the config round-trip tests.
function stashAmbientServers() {
  const stashed = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SSH_SERVER_')) {
      stashed[key] = process.env[key];
      delete process.env[key];
    }
  }
  return () => {
    for (const [key, value] of Object.entries(stashed)) process.env[key] = value;
  };
}

async function testCodexSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-codex-'));
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      '# existing codex config',
      '',
      '[mcp_servers.other]',
      'command = "echo"',
      'args = [ "hello" ]',
      '',
    ].join('\n')
  );

  try {
    await captureStdout(() => cmd_codex_setup(configPath));
    const config = /** @type {any} */ (TOML.parse(fs.readFileSync(configPath, 'utf8')));
    assert.ok(config.mcp_servers.other, 'pre-existing mcp_servers.other entry survives setup');
    assert.strictEqual(
      config.mcp_servers.other.command,
      'echo',
      'pre-existing entry content is untouched'
    );
    const entry = config.mcp_servers.ssh4agent;
    assert.ok(entry, 'ssh4agent entry is written');
    assert.strictEqual(entry.command, 'node', 'entry command is node');
    assert.ok(Array.isArray(entry.args) && entry.args.length === 1, 'entry has one arg');
    assert.ok(fs.existsSync(entry.args[0]), `entry path exists on disk: ${entry.args[0]}`);
    assert.strictEqual(
      typeof entry.env.SSH_CONFIG_PATH,
      'string',
      'entry env carries SSH_CONFIG_PATH'
    );
    ok('codex setup merges the ssh4agent entry without clobbering existing config');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testCodexMigrateAndConvert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-codex-'));
  const envPath = path.join(dir, 'servers.env');
  const tomlPath = path.join(dir, 'ssh-config.toml');
  fs.writeFileSync(
    envPath,
    [
      'SSH_SERVER_CLITESTA_HOST=203.0.113.1',
      'SSH_SERVER_CLITESTA_USER=alice',
      'SSH_SERVER_CLITESTB_HOST=203.0.113.2',
      'SSH_SERVER_CLITESTB_USER=bob',
      '',
    ].join('\n')
  );
  const restore = stashAmbientServers();

  try {
    await captureStdout(() => cmd_codex_migrate(envPath, tomlPath));
    const migrated = /** @type {any} */ (TOML.parse(fs.readFileSync(tomlPath, 'utf8')));
    assert.deepStrictEqual(
      Object.keys(migrated.ssh_servers).sort(),
      ['clitesta', 'clitestb'],
      'migrate writes both servers into [ssh_servers.*]'
    );
    assert.strictEqual(migrated.ssh_servers.clitesta.host, '203.0.113.1');
    assert.strictEqual(migrated.ssh_servers.clitestb.user, 'bob');
    ok('codex migrate converts .env servers to TOML');

    // convert to-toml shares the migrate semantics (src → dst).
    const toml2 = path.join(dir, 'ssh-config-2.toml');
    await captureStdout(() => cmd_codex_convert('to-toml', envPath, toml2));
    const converted = /** @type {any} */ (TOML.parse(fs.readFileSync(toml2, 'utf8')));
    assert.strictEqual(Object.keys(converted.ssh_servers).length, 2, 'convert to-toml writes both');
    ok('codex convert to-toml matches migrate semantics');

    // convert to-env round-trips the TOML back into .env lines.
    const envOut = path.join(dir, 'roundtrip.env');
    await captureStdout(() => cmd_codex_convert('to-env', tomlPath, envOut));
    const envContent = fs.readFileSync(envOut, 'utf8');
    assert.ok(
      envContent.includes('SSH_SERVER_CLITESTA_HOST='),
      'to-env emits SSH_SERVER_CLITESTA_HOST='
    );
    assert.ok(
      envContent.includes('SSH_SERVER_CLITESTB_HOST='),
      'to-env emits SSH_SERVER_CLITESTB_HOST='
    );
    ok('codex convert to-env exports TOML servers back to .env');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Full chain against a temp Codex config: setup writes the entry, test boots
// the real MCP server through it and must report the 37-tool registry.
async function testCodexSetupTestE2E() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-codex-'));
  const configPath = path.join(dir, 'config.toml');

  try {
    process.exitCode = 0;
    await captureStdout(() => cmd_codex_setup(configPath));
    const output = await captureStdout(() => cmd_codex_test(configPath));
    assert.strictEqual(process.exitCode, 0, `codex test must succeed, output:\n${output}`);
    assert.ok(/Codex integration OK/.test(output), 'reports integration OK');
    assert.ok(/37 tools/.test(output), `handshake must expose 37 tools, got:\n${output}`);
    ok('codex setup → test e2e: handshake ok with 37 tools (temp config only)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
}

function testMonitorMapping() {
  assert.strictEqual(monitorCommandFor('overview'), 'uptime && free -h && df -h');
  assert.strictEqual(monitorCommandFor('cpu'), 'top -bn1 | head -20');
  assert.strictEqual(monitorCommandFor('memory'), 'free -h && ps aux --sort=-%mem | head -10');
  assert.strictEqual(
    monitorCommandFor('disk'),
    'df -h && du -sh /* 2>/dev/null | sort -h | tail -10'
  );
  assert.strictEqual(monitorCommandFor('network'), 'netstat -tulpn 2>/dev/null | grep LISTEN');
  assert.strictEqual(monitorCommandFor('bogus'), null, 'unknown type → null');
  assert.strictEqual(monitorCommandFor(), 'uptime && free -h && df -h', 'no type → overview');
  assert.strictEqual(MONITOR_TYPES.length, 5);
  ok('monitor type → command mapping matches the interactive menu verbatim');
}

async function testSessionValidation() {
  process.exitCode = 0;
  await captureStdout(() => cmd_session());
  assert.strictEqual(process.exitCode, 1, 'session without action exits 1');

  process.exitCode = 0;
  await captureStdout(() => cmd_session('close', 'abc'));
  assert.strictEqual(process.exitCode, 1, 'session close <non-numeric pid> exits 1');

  process.exitCode = 0;
  await captureStdout(() => cmd_session('bogus'));
  assert.strictEqual(process.exitCode, 1, 'unknown session action exits 1');

  process.exitCode = 0;
  await captureStdout(() => cmd_session('list'));
  assert.strictEqual(process.exitCode, 0, 'session list is read-only and succeeds');
  ok('session argument validation (no action / bad pid / unknown action → exit 1)');
}

async function testDispatcherUsage() {
  process.exitCode = 0;
  await captureStdout(() => cmd_codex());
  assert.strictEqual(process.exitCode, 1, 'codex without subcommand exits 1');
  process.exitCode = 0;
  await captureStdout(() => cmd_codex('bogus'));
  assert.strictEqual(process.exitCode, 1, 'unknown codex subcommand exits 1');
  ok('codex dispatcher usage errors (no subcommand / unknown subcommand → exit 1)');
}

async function main() {
  await testCodexSetup();
  await testCodexMigrateAndConvert();
  await testCodexSetupTestE2E();
  testMonitorMapping();
  await testSessionValidation();
  await testDispatcherUsage();
  process.stdout.write(`\n✅ CLI command tests passed (${passed} checks)\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
