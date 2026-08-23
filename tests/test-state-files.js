/**
 * State file unification tests (issue #8).
 *
 * All user-mutable state must live under $SSH4AGENT_HOME (default
 * ~/.ssh4agent) — never in the install directory, which is read-only under a
 * global npm install. Reads fall back to the legacy install-dir location and
 * migrate the file into the state dir.
 *
 * Env vars are set BEFORE the dynamic imports because some modules resolve
 * their state paths at import time.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-home-'));
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-legacy-'));
  process.env.SSH4AGENT_HOME = home;
  process.env.SSH4AGENT_LEGACY_STATE_DIR = legacy;

  const stateFiles = await import('../src/state-files.ts');

  // ── write + read roundtrip in the state dir ────────────────────────────
  assert.strictEqual(stateFiles.writeStateFileText('.probe.json', '{"a":1}'), true);
  assert.strictEqual(fs.existsSync(path.join(home, '.probe.json')), true, 'file in state dir');
  assert.strictEqual(stateFiles.readStateFileText('.probe.json'), '{"a":1}');
  ok('state files are written to and read from $SSH4AGENT_HOME');

  // ── absent file → null, nothing invented ───────────────────────────────
  assert.strictEqual(stateFiles.readStateFileText('.missing.json'), null);
  ok('absent state file reads as null');

  // ── legacy install-dir file migrates on first read ─────────────────────
  fs.writeFileSync(path.join(legacy, '.server-aliases.json'), JSON.stringify({ prod: 'web-1' }));
  const migrated = stateFiles.readStateFileText('.server-aliases.json');
  assert.strictEqual(migrated, JSON.stringify({ prod: 'web-1' }), 'legacy content returned');
  assert.strictEqual(
    fs.existsSync(path.join(home, '.server-aliases.json')),
    true,
    'content copied into the state dir (one-time migration)'
  );
  ok('legacy install-dir state migrates into the state dir on first read');

  // ── real modules route through the state dir ───────────────────────────
  const aliases = await import('../src/server-aliases.ts');
  aliases.addAlias('stg', 'staging-web');
  const stored = JSON.parse(fs.readFileSync(path.join(home, '.server-aliases.json'), 'utf8'));
  assert.strictEqual(stored.stg, 'staging-web', 'server alias persisted in state dir');
  assert.strictEqual(aliases.listAliases().length, 2, 'aliases (incl. migrated) visible');

  const groups = await import('../src/server-groups.ts');
  // Default constructor path → state dir file with migration support.
  fs.writeFileSync(
    path.join(legacy, '.server-groups.json'),
    JSON.stringify({ legacy_grp: { description: 'from install dir', servers: ['a'] } })
  );
  const manager = new groups.ServerGroups();
  const legacyGroup = manager.getGroup('legacy_grp');
  assert.ok(legacyGroup, 'legacy group visible after migration read');
  assert.strictEqual(
    fs.existsSync(path.join(home, '.server-groups.json')),
    true,
    'groups migrated into the state dir'
  );
  ok('server-aliases and server-groups modules use the unified state dir');

  // Command history: logger persists into the state dir, not the repo root.
  const { logger } = await import('../src/logger.ts');
  logger.saveCommandToHistory('uptime', 'srv', { success: true, duration: '5ms' });
  const history = JSON.parse(fs.readFileSync(path.join(home, '.ssh-command-history.json'), 'utf8'));
  assert.strictEqual(history[history.length - 1].command, 'uptime');
  ok('command history persists into the state dir');

  // Hooks config: initialize writes into the state dir.
  const hooks = await import('../src/hooks-system.ts');
  await hooks.initializeHooks();
  assert.strictEqual(
    fs.existsSync(path.join(home, '.hooks-config.json')),
    true,
    'hooks config created in state dir'
  );
  assert.strictEqual(fs.existsSync(path.join(home, 'hooks')), true, 'hooks dir in state dir');
  ok('hooks config + hooks dir live in the state dir');

  // Nothing ever lands in the legacy (install) directory except our fixtures.
  const legacyEntries = fs
    .readdirSync(legacy)
    .filter((f) => f !== '.server-aliases.json' && f !== '.server-groups.json');
  assert.deepStrictEqual(legacyEntries, [], 'no module writes to the legacy dir');

  delete process.env.SSH4AGENT_HOME;
  delete process.env.SSH4AGENT_LEGACY_STATE_DIR;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(legacy, { recursive: true, force: true });
  console.log(`\n✅ state file tests passed (${passed} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
