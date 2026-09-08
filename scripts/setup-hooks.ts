// Cross-platform git pre-commit hook setup (replaces scripts/setup-hooks.sh).
// Run via: `npm run setup-hooks` → `node scripts/setup-hooks.ts`
//
// Pure Node.js, no shell-isms, no Python. Installs a lightweight forwarder in
// `.git/hooks/pre-commit` (POSIX `sh`) that delegates to version-controlled
// `.githooks/pre-commit`. Keeps `core.hooksPath` unmodified to strictly respect
// the AGENTS.md rule: "agents must never modify git config".
//
// Gates executed via .githooks/pre-commit:
//   1. Format check: Biome check (read-only, no write)
//   2. Lint: Biome lint
//   3. Typecheck: tsc (no emit)
//   4. Tests: npm test (isolated SSH4AGENT_HOME & environment)
//   5. Validate: node scripts/validate.ts

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const ok = (m: string) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const fail = (m: string) => console.log(`  ${RED}✗${RESET} ${m}`);

console.log('🔧 Setting up Git hooks for code quality...');
console.log('==========================================');
console.log('');

// scripts/setup-hooks.ts → scripts → <project root>
const _HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(_HERE);
const GIT_DIR = join(PROJECT_ROOT, '.git');
const HOOKS_DIR = join(GIT_DIR, 'hooks');
const HOOK_FILE = join(HOOKS_DIR, 'pre-commit');
const MANAGED_HOOK_FILE = join(PROJECT_ROOT, '.githooks', 'pre-commit');

// 1. Sanity checks: node + git repo present.
if (!existsSync(GIT_DIR)) {
  fail('Not a git repository (no .git directory found)');
  console.log('  Run `git init` first, then re-run this script.');
  process.exit(1);
}

const nodeOk = spawnSync(process.execPath, ['--version'], { stdio: 'ignore' }).status === 0;
if (!nodeOk) {
  fail('Node.js is required but not available');
  process.exit(1);
}
ok('Node.js available');

// 2. Ensure dependencies are already installed (do not silently npm install).
const hasNodeModules = existsSync(join(PROJECT_ROOT, 'node_modules'));
const hasBiome =
  existsSync(
    join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome')
  ) || existsSync(join(PROJECT_ROOT, 'node_modules', '.bin', 'biome'));
const hasTsc =
  existsSync(
    join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  ) || existsSync(join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc'));

if (!hasNodeModules || !hasBiome || !hasTsc) {
  fail('Required dependencies (Biome, TypeScript) not found in node_modules.');
  console.log('  Please run `npm install` manually before setting up hooks.');
  process.exit(1);
}
ok('node_modules and local tool binaries (Biome, TypeScript) present');

// 3. Ensure version-controlled managed hook exists.
if (!existsSync(MANAGED_HOOK_FILE)) {
  fail(`Managed hook script not found at ${MANAGED_HOOK_FILE}. Run /lazypack-setup first.`);
  process.exit(1);
}
ok('Managed hook script present (.githooks/pre-commit)');

// 4. Exact content / hash protection for existing Hook.
if (!existsSync(HOOKS_DIR)) {
  mkdirSync(HOOKS_DIR, { recursive: true });
}

const FORWARDER_CONTENT = `#!/bin/sh
# Forward to version-controlled lazypack pre-commit hook
# Auto-installed by scripts/setup-hooks.ts — do not edit by hand.

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"
TARGET_HOOK="$ROOT_DIR/.githooks/pre-commit"

if [ ! -f "$TARGET_HOOK" ]; then
  echo "❌ [git-hook] Managed hook script not found: $TARGET_HOOK" >&2
  exit 1
fi

if [ ! -x "$TARGET_HOOK" ] && [ "$OSTYPE" != "msys" ] && [ "$OSTYPE" != "win32" ]; then
  echo "❌ [git-hook] Managed hook script is not executable: $TARGET_HOOK" >&2
  exit 1
fi

exec "$TARGET_HOOK" "$@"
`;

const KNOWN_OLD_GENERATOR_HASH = '0ce8e282c264676bfae4121ce57198d41714a58784449a755a83ca05780168a8';
const FORWARDER_HASH = createHash('sha256')
  .update(Buffer.from(FORWARDER_CONTENT, 'utf8'))
  .digest('hex');

if (existsSync(HOOK_FILE)) {
  const existingBuf = readFileSync(HOOK_FILE);
  const existingHash = createHash('sha256').update(existingBuf).digest('hex');

  if (existingHash === FORWARDER_HASH) {
    ok('Pre-commit forwarder hook is already up to date (NO-OP)');
  } else if (existingHash === KNOWN_OLD_GENERATOR_HASH) {
    // R2: Secure migration backup for known legacy hook before overwrite.
    // Create backup with exclusive flag 'wx' to prevent overwriting existing backups.
    const ts = Date.now();
    const backupFileName = `pre-commit.backup-legacy-${ts}`;
    const backupFilePath = join(HOOKS_DIR, backupFileName);

    try {
      // Exclusive creation ('wx' flag fails if file already exists)
      writeFileSync(backupFilePath, existingBuf, { flag: 'wx' });
      // Read back and verify byte length and hash
      const verifiedBuf = readFileSync(backupFilePath);
      const verifiedHash = createHash('sha256').update(verifiedBuf).digest('hex');
      if (verifiedHash !== KNOWN_OLD_GENERATOR_HASH || verifiedBuf.length !== existingBuf.length) {
        throw new Error(`Backup verification failed: hash mismatch (got ${verifiedHash})`);
      }
    } catch (backupErr: any) {
      fail(
        `Failed to securely back up legacy pre-commit hook before migration: ${backupErr.message}`
      );
      console.log('  Aborting installation to prevent unbacked overwrite.');
      process.exit(1);
    }

    ok(`Legacy hook backed up to ${backupFilePath} (SHA256: ${existingHash})`);
    writeFileSync(HOOK_FILE, FORWARDER_CONTENT, 'utf8');
    ok('Migrated known auto-generated hook to forwarder hook');
  } else {
    fail(`Unrecognized or custom pre-commit hook detected (SHA256: ${existingHash})`);
    console.log('  Aborting installation to protect existing hook.');
    console.log(
      '  Please inspect `.git/hooks/pre-commit` or manually delegate to `.githooks/pre-commit`.'
    );
    process.exit(1);
  }
} else {
  writeFileSync(HOOK_FILE, FORWARDER_CONTENT, 'utf8');
  ok(`Forwarder pre-commit hook installed at ${HOOK_FILE.replace(/\\/g, '/')}`);
}

// 5. Ensure execution permissions.
try {
  chmodSync(HOOK_FILE, 0o755);
} catch (err: any) {
  if (process.platform !== 'win32') {
    fail(`Failed to set executable permissions on ${HOOK_FILE}: ${err.message}`);
    process.exit(1);
  }
}

console.log('');
console.log(`${GREEN}✅ Git hooks setup complete!${RESET}`);
console.log('');
console.log('Installation facts:');
console.log('  - Local Hook: .git/hooks/pre-commit (forwarder entry)');
console.log('  - Managed Script: .githooks/pre-commit (version-controlled)');
console.log('  - Git config: core.hooksPath remains untouched (zero config changes)');
console.log('');
console.log('To verify hook natively via Git: git hook run pre-commit');
