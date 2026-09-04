/**
 * Tool-config unification tests (candidate-3).
 *
 * src/tool-config-manager.ts is now the ONE module behind tool enablement:
 * paths, legacy fallback, mode-transition semantics, validation, and the
 * enabled-tool derivation. The CLI (cli/commands/tools.ts) consumes it and
 * keeps only rendering + prompts. These tests pin the behaviors the
 * unification fixed:
 *
 *  - the manager imports with NO side effects (no logger → no state dir or
 *    log file created at import time — the CLI may import it freely)
 *  - enable from minimal mode materializes the CURRENT state first
 *    (previously: enabling one group from minimal silently enabled all 37)
 *  - reset WRITES the default instead of deleting (deleting would let a
 *    legacy ~/.ssh-manager config resurrect on the next load)
 *  - export-claude derives the tool list (respects per-tool overrides) —
 *    previously the CLI hardcoded all 37 names in a third copy
 *
 * The manager keys on os.homedir(); these tests redirect HOME into a temp
 * sandbox so they never touch the real ~/.ssh4agent.
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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcfg-'));
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows: os.homedir() prefers this

  // Import AFTER redirecting HOME so the module-level paths land in sandbox.
  const { loadFreshToolConfig, TOOLS_CONFIG_FILE } = await import('../src/tool-config-manager.ts');
  const { TOOL_GROUPS, getAllTools } = await import('../src/tool-registry.ts');

  const total = getAllTools().length;

  // ── import has no side effects ────────────────────────────────────────────
  const stateDir = path.join(home, '.ssh4agent');
  assert.strictEqual(
    fs.existsSync(stateDir),
    false,
    'importing tool-config-manager must not create the state dir'
  );
  ok('manager import is side-effect free (no state dir created)');

  // ── enable from minimal materializes current state ────────────────────────
  {
    // Start in minimal mode.
    let manager = await loadFreshToolConfig();
    await manager.replaceConfig({
      version: '1.0',
      mode: 'minimal',
      groups: Object.fromEntries(
        Object.keys(TOOL_GROUPS).map((g) => [g, { enabled: g === 'core' }])
      ),
      tools: {},
    });

    // Enable ONE non-core group.
    await manager.enableGroup('backup');

    const onDisk = JSON.parse(fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8'));
    assert.strictEqual(onDisk.mode, 'custom', 'enable flips mode to custom');
    assert.strictEqual(onDisk.groups.backup.enabled, true, 'backup enabled');
    // The bug this guards against: unmentioned groups defaulted ON.
    for (const group of Object.keys(TOOL_GROUPS)) {
      if (group === 'backup' || group === 'core') continue;
      assert.strictEqual(
        onDisk.groups[group].enabled,
        false,
        `${group} must stay disabled when enabling from minimal mode`
      );
    }
    const enabledCount = Object.keys(onDisk.groups).filter((g) => onDisk.groups[g].enabled).length;
    assert.strictEqual(enabledCount, 2, 'exactly core+backup enabled (not all 6)');
    ok('enable from minimal materializes current state (no silent full enable)');
  }

  // ── disable from all-mode keeps everything else on ─────────────────────────
  {
    fs.rmSync(TOOLS_CONFIG_FILE);
    const manager = await loadFreshToolConfig();
    assert.strictEqual(manager.getSummary().mode, 'all', 'fresh start defaults to all');

    await manager.disableGroup('advanced');
    const onDisk = JSON.parse(fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8'));
    assert.strictEqual(onDisk.mode, 'custom');
    assert.strictEqual(onDisk.groups.advanced.enabled, false, 'advanced disabled');
    assert.strictEqual(onDisk.groups.core.enabled, true, 'core stays on');
    assert.strictEqual(
      onDisk.groups.monitoring.enabled,
      true,
      'unmentioned groups keep their all-mode state'
    );
    ok('disable from all-mode keeps the other groups enabled');
  }

  // ── core cannot be disabled ────────────────────────────────────────────────
  {
    const manager = await loadFreshToolConfig();
    assert.strictEqual(await manager.disableGroup('core'), false, 'core is protected');
    ok('disableGroup(core) refuses');
  }

  // ── reset WRITES the default, never deletes ───────────────────────────────
  {
    fs.rmSync(TOOLS_CONFIG_FILE);
    let manager = await loadFreshToolConfig();
    await manager.disableGroup('database');
    assert.strictEqual(fs.existsSync(TOOLS_CONFIG_FILE), true, 'config written');

    await manager.reset();
    const onDisk = JSON.parse(fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8'));
    assert.strictEqual(onDisk.mode, 'all', 'reset writes mode:all');
    assert.strictEqual(
      fs.existsSync(TOOLS_CONFIG_FILE),
      true,
      'reset must NOT delete the file (deleting resurrects legacy configs)'
    );
    manager = await loadFreshToolConfig();
    assert.strictEqual(manager.getEnabledTools().length, total, 'all tools enabled after reset');
    ok('reset writes the default config instead of deleting');
  }

  // ── legacy fallback + write-to-new-path ────────────────────────────────────
  {
    fs.rmSync(TOOLS_CONFIG_FILE);
    const legacyDir = path.join(home, '.ssh-manager');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'tools-config.json');
    const legacyConfig = {
      version: '1.0',
      mode: 'minimal',
      groups: Object.fromEntries(
        Object.keys(TOOL_GROUPS).map((g) => [g, { enabled: g === 'core' }])
      ),
      tools: {},
    };
    fs.writeFileSync(legacyFile, JSON.stringify(legacyConfig));

    const manager = await loadFreshToolConfig();
    assert.strictEqual(manager.getSummary().mode, 'minimal', 'legacy config is read');

    // Any write must land on the NEW path, never mutate the legacy file.
    await manager.enableGroup('monitoring');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(legacyFile, 'utf8')).mode,
      'minimal',
      'legacy file untouched'
    );
    assert.strictEqual(fs.existsSync(TOOLS_CONFIG_FILE), true, 'writes always go to the new path');
    const onDisk = JSON.parse(fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8'));
    assert.strictEqual(onDisk.groups.monitoring.enabled, true, 'change landed on new file');
    ok('legacy fallback reads old config; writes always target the new path');
  }

  // ── export respects per-tool overrides ─────────────────────────────────────
  {
    fs.rmSync(TOOLS_CONFIG_FILE);
    fs.rmSync(path.join(home, '.ssh-manager'), { recursive: true, force: true });
    const manager = await loadFreshToolConfig();
    // all-mode minus one tool override
    const config = {
      version: '1.0',
      mode: 'all',
      groups: Object.fromEntries(Object.keys(TOOL_GROUPS).map((g) => [g, { enabled: true }])),
      tools: { ssh_history: false },
    };
    await manager.replaceConfig(config);

    const enabled = manager.getEnabledTools();
    assert.ok(!enabled.includes('ssh_history'), 'per-tool override respected');
    assert.strictEqual(enabled.length, total - 1, 'exactly one tool excluded');
    const exported = manager.exportClaudeCodeConfig();
    assert.ok(
      !exported.patterns.includes('mcp__ssh4agent__ssh_history'),
      'export list derives from enabled tools'
    );
    assert.strictEqual(exported.patterns.length, total - 1, 'export list length follows overrides');
    ok('enabled/export derivation respects per-tool overrides');
  }

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n✅ tool-config unification tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
