/**
 * Canonical .env path resolution — the ONE fallback chain shared by the MCP
 * entry point (src/index.ts) and the CLI (cli/lib/config.ts). It used to exist
 * twice with drifted names and orders (SSH_ENV_PATH here, SSH4AGENT_ENV there;
 * different defaults), so the two processes could read different files
 * (issue #7).
 *
 * Priority:
 *   1. SSH_ENV_PATH    (explicit override, src-side name — canonical)
 *   2. SSH4AGENT_ENV   (CLI-side name, kept as a deprecated alias)
 *   3. $SSH4AGENT_HOME/.env   (default ~/.ssh4agent — where the CLI writes)
 *   4. ~/.ssh-manager/.env    (legacy dir, read-only fallback + warning)
 *   5. $PWD/.env
 *   6. ~/.env
 *   7. <package root>/.env    (backward compat for local checkouts)
 *   default: $SSH4AGENT_HOME/.env
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveEnvFilePath(): string {
  if (process.env.SSH_ENV_PATH) {
    return process.env.SSH_ENV_PATH;
  }
  // Compatibility alias from the CLI side. Deprecated in favor of SSH_ENV_PATH
  // but kept so existing shells/scripts keep working.
  if (process.env.SSH4AGENT_ENV) {
    return process.env.SSH4AGENT_ENV;
  }

  const home = process.env.SSH4AGENT_HOME || path.join(os.homedir(), '.ssh4agent');
  const legacyHome = path.join(os.homedir(), '.ssh-manager');
  const candidates = [
    path.join(home, '.env'),
    path.join(legacyHome, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (candidate === path.join(legacyHome, '.env')) {
        console.error(
          `ℹ️ Using legacy config ${candidate} — move it to ${path.join(home, '.env')} to migrate`
        );
      }
      return candidate;
    }
  }
  return path.join(home, '.env');
}
