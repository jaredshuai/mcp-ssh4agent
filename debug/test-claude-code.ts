// Cross-platform debug helper (replaces debug/test-claude-code.sh).
// Run via: `node debug/test-claude-code.ts`
//
// Sanity-checks the local setup for driving this MCP server from Claude Code:
// package.json, node_modules, .env (counts configured servers), and the
// Claude Code MCP config. Pure Node.js — no shell-isms, works on Windows.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const NC = '\x1b[0m';
const ok = (m: string) => console.log(`${GREEN}✅${NC} ${m}`);
const fail = (m: string) => console.log(`${RED}❌${NC} ${m}`);

// debug/test-claude-code.ts → debug → <project root>
const _HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(_HERE);

console.log('🔧 Testing MCP SSH Manager for Claude Code');
console.log('===========================================');
console.log('');

// 1. Dependencies.
console.log('📦 Checking dependencies...');
if (fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))) {
  ok('package.json found');
} else {
  fail('package.json not found');
  process.exit(1);
}
if (fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))) {
  ok('node_modules found');
} else {
  fail('node_modules not found. Run: npm install');
  process.exit(1);
}

// 2. Server configuration (.env).
console.log('');
console.log('🔐 Checking server configuration...');
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  ok('.env file found');
  const envText = fs.readFileSync(envPath, 'utf8');
  const serverCount = envText.split(/\r?\n/).filter((l) => /^SSH_SERVER_.*_HOST=/.test(l)).length;
  ok(`${serverCount} servers configured`);
} else {
  fail('.env file not found');
  process.exit(1);
}

// 3. Claude Code config.
console.log('');
console.log('⚙️  Checking Claude Code configuration...');
const claudeConfig = path.join(os.homedir(), '.config', 'claude-code', 'claude_code_config.json');
if (fs.existsSync(claudeConfig)) {
  ok('Claude Code config found');
  const cfgText = fs.readFileSync(claudeConfig, 'utf8');
  if (cfgText.includes('ssh-manager')) {
    ok('SSH Manager is configured in Claude Code');
  } else {
    fail('SSH Manager not found in Claude Code config');
    console.log('   Register it with:');
    console.log(
      '   claude mcp add ssh-manager node ' +
        path.join(PROJECT_ROOT, 'src', 'index.ts').replace(/\\/g, '/')
    );
  }
} else {
  fail(`Claude Code config not found at ${claudeConfig}`);
}

// 4. Summary.
console.log('');
console.log('🎯 Configuration Summary:');
console.log('========================');
console.log(`MCP Server Path: ${path.join(PROJECT_ROOT, 'src', 'index.ts').replace(/\\/g, '/')}`);
const envText2 = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const count = envText2.split(/\r?\n/).filter((l) => /^SSH_SERVER_.*_HOST=/.test(l)).length;
console.log(`Servers configured: ${count}`);
console.log('');
console.log('✅ Ready to use in Claude Code!');
console.log('');
console.log('Try these commands in Claude Code:');
console.log("  - 'Use the ssh_list_servers tool'");
console.log("  - 'Use ssh_execute on production to run ls'");
console.log("  - 'Use ssh_execute on staging to run hostname'");
