// Cross-platform debug helper (replaces debug/test-sync.sh).
// Run via: `node debug/test-sync.ts`
//
// Sets up a sample local directory tree under the OS temp dir and prints
// example `ssh_sync` invocations to try against a configured server.
// Pure Node.js — uses os.tmpdir() instead of /tmp.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const GREEN = '\x1b[32m';
const NC = '\x1b[0m';
const ok = (m: string) => console.log(`${GREEN}✅${NC} ${m}`);

console.log('🧪 Test SSH Sync Tool');
console.log('====================');
console.log('');

// 1. Create test directory structure (cross-platform temp location).
const TEST_DIR = path.join(os.tmpdir(), 'mcp-sync-test');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
const srcDir = path.join(TEST_DIR, 'source');
const destDir = path.join(TEST_DIR, 'dest');
const subDir = path.join(srcDir, 'subdir');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'File 1 content\n');
fs.writeFileSync(path.join(srcDir, 'file2.txt'), 'File 2 content\n');
fs.writeFileSync(path.join(srcDir, 'config.json'), 'Config file\n');
fs.writeFileSync(path.join(subDir, 'nested.txt'), 'Nested file\n');
fs.writeFileSync(path.join(srcDir, 'temp.log'), 'Should be excluded\n');
fs.writeFileSync(path.join(srcDir, 'cache.tmp'), 'Also excluded\n');

console.log('📁 Test directory created:');
// `tree` may not exist on Windows; fall back to a simple recursive listing.
const listTree = (dir: string, prefix = ''): void => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.forEach((e, i) => {
    const last = i === entries.length - 1;
    console.log(`${prefix}${last ? '└── ' : '├── '}${e.name}`);
    if (e.isDirectory()) {
      listTree(path.join(dir, e.name), prefix + (last ? '    ' : '│   '));
    }
  });
};
listTree(TEST_DIR);
ok('Test files written');
console.log('');

console.log('Test scenarios:');
console.log('1. Dry run to see what would be synced');
console.log('2. Actual sync with exclusions');
console.log('3. Pull from remote (if you have a test server configured)');
console.log('');

console.log('📋 Example commands to test ssh_sync:');
console.log('');
console.log('# Dry run - see what would be synced');
console.log('ssh_sync server:"test-server" source:"local:' +
  srcDir.replace(/\\/g, '/') + '/" destination:"remote:/tmp/sync-dest/" dryRun:true exclude:["*.log","*.tmp"]');
console.log('');
console.log('# Actual push to remote');
console.log('ssh_sync server:"test-server" source:"local:' +
  srcDir.replace(/\\/g, '/') + '/" destination:"remote:/tmp/sync-dest/" exclude:["*.log","*.tmp"] verbose:true');
console.log('');
console.log('# Pull from remote');
console.log('ssh_sync server:"test-server" source:"remote:/tmp/sync-dest/" destination:"local:' +
  path.join(TEST_DIR, 'pulled').replace(/\\/g, '/') + '/" verbose:true');
console.log('');
console.log('# Sync with delete option (careful!)');
console.log('ssh_sync server:"test-server" source:"local:' +
  srcDir.replace(/\\/g, '/') + '/" destination:"remote:/tmp/sync-dest/" delete:true dryRun:true');
console.log('');
console.log("⚠️  Note: Replace 'test-server' with an actual configured server name");
console.log("    Run 'ssh_list_servers' to see available servers");
