// Cross-platform validation script (replaces scripts/validate.sh).
// Run via: `npm run validate` → `node scripts/validate.ts`
//
// Pure Node.js, no shell-isms. Works on Windows, macOS, Linux.
// Uses only node: built-ins, so it has zero external dependencies.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let errors = 0;
const ok = (msg: string) => console.log(`  ${GREEN}✅${RESET} ${msg}`);
const fail = (msg: string) => {
  console.log(`  ${RED}❌${RESET} ${msg}`);
  errors++;
};
const warn = (msg: string) => console.log(`  ${YELLOW}⚠️${RESET}  ${msg}`);

console.log('🔍 MCP SSH Manager - Code Validation');
console.log('=====================================');
console.log('');

// 1. Syntax checks via `node --check` (native type stripping handles .ts).
console.log('📋 Checking source syntax...');
const syntaxTargets = ['src/index.ts', 'src/ssh-manager.ts'];
for (const target of syntaxTargets) {
  const result = spawnSync(process.execPath, ['--check', target], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    ok(`${target} syntax is valid`);
  } else {
    fail(`${target} syntax error!`);
    const stderr = result.stderr?.toString().trim();
    if (stderr) console.log(`      ${stderr}`);
  }
}

// 2. Sensitive-file check: ensure `.env` is not tracked in git.
console.log('📋 Checking for sensitive files...');
const gitLs = spawnSync('git', ['ls-files'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (gitLs.status === 0) {
  const tracked = gitLs.stdout.toString().split(/\r?\n/);
  if (tracked.includes('.env')) {
    fail('.env file is tracked in git!');
  } else {
    ok('No .env file in git');
  }
} else {
  warn('git not available or not a git repo — skipping sensitive-file check');
}

// 3. Dependencies installed?
console.log('📋 Checking dependencies...');
if (existsSync('node_modules')) {
  ok('Node modules installed');
} else {
  warn('Node modules not installed (run: npm install)');
}

// 4. MCP server startup test: feed empty stdin, give it 2s, then kill.
console.log('📋 Testing MCP server startup...');
const serverOk = await testServerStartup();
if (serverOk) {
  ok('MCP server starts correctly');
} else {
  fail('MCP server failed to start');
}

console.log('');
console.log('=====================================');
if (errors === 0) {
  console.log(`${GREEN}✅ All checks passed!${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}❌ Found ${errors} error(s)${RESET}`);
  process.exit(1);
}

/**
 * Spawn `node src/index.ts`, close stdin (EOF), wait up to 2s.
 * - Still running after 2s → syntax OK, kill it → return true.
 * - Exited with code 0 or 143 (SIGTERM) → syntax OK → return true.
 * - Exited with any other code → failure → return false.
 */
async function testServerStartup(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      // Ensure the process is reaped / killed before resolving.
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    try {
      child = spawn(process.execPath, ['src/index.ts'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      settle(false);
      return;
    }

    child.on('exit', (code, signal) => {
      // 0 = clean exit on EOF; 143 = SIGTERM (we killed it); null = still running.
      if (code === 0 || code === 143 || signal === 'SIGTERM') {
        settle(true);
      } else {
        settle(false);
      }
    });
    child.on('error', () => settle(false));

    // Send EOF on stdin (mirrors `echo "" | node ...`).
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }

    // Give it 2 seconds, then assume it started fine and is waiting for input.
    void delay(2000).then(() => {
      if (!settled) settle(true);
    });
  });
}
