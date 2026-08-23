/**
 * State file placement — the ONE rule (issue #8).
 *
 * User-mutable state used to be split: half in the install directory
 * (`__dirname/..` — READ-ONLY under a global npm install, so writes failed at
 * runtime) and half in ~/.ssh4agent. Every module below now reads and writes
 * through this module, so all state lives under the config home
 * ($SSH4AGENT_HOME, default ~/.ssh4agent):
 *
 *   .server-aliases.json     (src/server-aliases.ts)
 *   .command-aliases.json    (src/command-aliases.ts)
 *   .server-groups.json      (src/server-groups.ts)
 *   .hooks-config.json       (src/hooks-system.ts)
 *   hooks/                   (src/hooks-system.ts scripts)
 *   .ssh-command-history.json(src/logger.ts)
 *   .ssh4agent.log           (src/logger.ts, unless SSH_LOG_FILE)
 *
 * Migration: on read, if the file is absent in the state dir but present in
 * the legacy install directory, its content is copied to the state dir
 * (best-effort) and returned — one-time move, no manual step.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The package/install root — where the pre-unification state files lived.
const LEGACY_ROOT = path.join(__dirname, '..');

export function stateDir(): string {
  return process.env.SSH4AGENT_HOME || path.join(os.homedir(), '.ssh4agent');
}

export function stateFilePath(name: string): string {
  return path.join(stateDir(), name);
}

// Test-only override: plant a fake "install directory" without touching the
// real package root (used by tests/test-state-files.js).
function legacyDir(): string {
  return process.env.SSH4AGENT_LEGACY_STATE_DIR || LEGACY_ROOT;
}

/**
 * Path of `name` in the legacy install-dir location. Exported for state
 * that does not round-trip through readStateFileText but still needs the
 * one-time migration (e.g. the append-only log in src/logger.ts).
 */
export function legacyStateFilePath(name: string): string {
  return path.join(legacyDir(), name);
}

/**
 * Read a state file as text. Falls back to the legacy install-dir location:
 * when found there, the content is migrated (copied) into the state dir
 * best-effort. Returns null when the file exists nowhere.
 */
export function readStateFileText(name: string): string | null {
  const target = stateFilePath(name);
  if (fs.existsSync(target)) {
    try {
      const content = fs.readFileSync(target, 'utf8');
      // A read-only touch must not leave a pre-existing 0644 file / 0755
      // dir loose either — upgraded installs hit the read path long
      // before any write (PR #9 review, round 3). Best-effort: a
      // chmod failure (read-only fs, foreign owner) never blocks reads.
      try {
        tightenPermissions(target);
      } catch {
        /* permissions stay as-is on this path */
      }
      return content;
    } catch (error) {
      console.error(`Warning: Could not read state file ${target}: ${error.message}`);
      return null;
    }
  }

  const legacy = path.join(legacyDir(), name);
  if (fs.existsSync(legacy)) {
    let content: string;
    try {
      content = fs.readFileSync(legacy, 'utf8');
    } catch (error) {
      console.error(`Warning: Could not read legacy state file ${legacy}: ${error.message}`);
      return null;
    }
    // Best-effort one-time migration; a read-only state dir still returns
    // the legacy content instead of failing.
    try {
      fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
      tightenPermissions(target);
    } catch {
      /* migration is best-effort */
    }
    return content;
  }

  return null;
}

/**
 * Write a state file (creating the state dir if needed). Returns success;
 * failures are logged but never thrown — state persistence must not break
 * tool execution (npm-global installs made the old install-dir writes fail
 * at runtime, which is exactly what this module fixes).
 */
export function writeStateFileText(name: string, content: string): boolean {
  try {
    // 0700/0600: state files (command history especially) can embed
    // credentials, so neither the dir nor the files may be readable by
    // other local users. `mode` only applies at CREATION time, so a
    // pre-existing permissive dir/file from an upgraded install must be
    // re-tightened with an explicit chmod.
    const dir = stateDir();
    const target = stateFilePath(name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    tightenPermissions(target, dir);
    return true;
  } catch (error) {
    console.error(`Error writing state file ${stateFilePath(name)}: ${error.message}`);
    return false;
  }
}

/**
 * chmod 0600 file / 0700 dir. Separate from the `mode` options above
 * because those only take effect when Node itself creates the path — an
 * existing file with 0644 keeps its permissions through writeFileSync,
 * leaving credential-bearing state readable by other local users
 * (PR #9 review: upgraded installs must not keep loose permissions).
 * Exported for sibling modules that manage their own state files
 * (e.g. the logger's migrated log).
 */
export function tightenPermissions(file: string, dir: string = stateDir()): void {
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(file, 0o600);
}
