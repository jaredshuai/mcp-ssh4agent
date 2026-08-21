// Cross-platform installer for the ssh-manager CLI (replaces cli/install.sh).
// Run via: `npm run install-cli` → `tsx scripts/install.ts`
//
// Pure Node.js, no shell-isms. Works on Windows, macOS, Linux.
// - Checks required (ssh) and optional (rsync / jq / sshpass) binaries.
// - Installs the CLI globally via `npm link` (uses the `bin` field in
//   package.json — npm creates the right shim per platform: a .cmd on
//   Windows, a symlink on unix). No manual /usr/local/bin writes.
// - Verifies `ssh-manager --version` resolves on PATH after install.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

const ok = (m: string) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const warn = (m: string) => console.log(`  ${YELLOW}⚠${RESET} ${m}`);
const fail = (m: string) => {
  console.log(`  ${RED}✗${RESET} ${m}`);
};
const info = (m: string) => console.log(`  ${BLUE}ℹ${RESET} ${m}`);

// scripts/install.ts → scripts → <project root>
const _HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(_HERE);

console.log(`${BLUE}SSH Manager CLI Installation${RESET}`);
console.log('==============================');
console.log('');

// 1. Dependency checks.
console.log(`${YELLOW}Checking dependencies...${RESET}`);
const checkBin = (name: string, required: boolean): boolean => {
  // `name -V` / `name --version` varies; just probe with a no-op flag and
  // accept any exit (we only care that the binary exists on PATH). On Windows
  // `where` is the resolver; spawnSync falls back to PATHEXT automatically.
  const probe = name === 'ssh' ? ['-V'] : ['--version'];
  const r = spawnSync(name, probe, { stdio: 'ignore' });
  if (r.error || r.status === null) {
    // spawn failed entirely (ENOENT) → not on PATH
    if (required) fail(`${name} (required)`);
    else warn(`${name} (optional)`);
    return false;
  }
  ok(name);
  return true;
};

const sshOk = checkBin('ssh', true);
checkBin('rsync', false);
checkBin('jq', false);
checkBin('sshpass', false);

if (!sshOk) {
  console.log('');
  console.log(`${RED}Error: 'ssh' is required but not on PATH.${RESET}`);
  console.log('Install OpenSSH client and try again.');
  process.exit(1);
}
console.log('');

// 2. Ensure project deps are installed (tsx must be present to run the CLI).
if (!existsSync(`${PROJECT_ROOT}/node_modules/tsx`)) {
  console.log(`${YELLOW}Installing Node.js dependencies...${RESET}`);
  const npmInstall = spawnSync('npm install', {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    // shell: true so `npm` resolves to npm.cmd on Windows (spawnSync of a
    // .cmd without a shell returns status:null). Single-string command form
    // avoids Node's DEP0190 args+shell deprecation warning.
    shell: true,
  });
  if (npmInstall.status !== 0) {
    fail('npm install failed');
    process.exit(1);
  }
  ok('Node.js dependencies installed');
  console.log('');
}

// 3. Global install via `npm link` (uses package.json `bin` field — npm creates
//    the platform-appropriate shim: ssh-manager.cmd on Windows, symlink on
//    unix). `npm link` keeps the install pointing at this source tree, which
//    suits a project under active development. Use `npm install -g .` instead
//    for a frozen copy.
console.log(`${YELLOW}Installing ssh-manager globally (npm link)...${RESET}`);
const npmLink = spawnSync('npm link', {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  shell: true,
});
if (npmLink.status !== 0) {
  fail('npm link failed');
  console.log('');
  info('You may need elevated permissions, or run manually:');
  console.log('  npm install -g .');
  process.exit(1);
}

// 4. Verify the CLI is now on PATH. ssh-manager resolves to a .cmd shim on
//    Windows, so this also needs shell: true with a single-string command.
const verify = spawnSync('ssh-manager --version', {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
if (verify.status === 0) {
  const version = verify.stdout?.toString().trim().split(/\r?\n/)[0];
  console.log('');
  console.log(`${GREEN}✅ Installation successful!${RESET}`);
  if (version) info(version);
  console.log('');
  console.log('Quick start:');
  console.log('  ssh-manager --help           # Show help');
  console.log('  ssh-manager server add       # Add a new server');
  console.log('  ssh-manager server list      # List servers');
  console.log('  ssh-manager server test      # Test connection');
  console.log('');
  console.log('Configuration files:');
  console.log(`  ${os.homedir()}/.ssh-manager/      # Config directory`);
  console.log('  .env                         # Server definitions');
} else {
  console.log('');
  fail('ssh-manager not found on PATH after install');
  info('Restart your shell (PATH may need to refresh), or run ssh-manager');
  console.log(`  via:  node ${PROJECT_ROOT.replace(/\\/g, '/')}/cli/ssh-manager.js`);
  process.exit(1);
}
console.log('');
console.log(`${GREEN}Installation complete! 🎉${RESET}`);
