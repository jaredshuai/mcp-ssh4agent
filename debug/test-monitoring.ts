// Cross-platform debug helper (replaces debug/test-monitoring.sh).
// Run via: `node debug/test-monitoring.ts`
//
// Writes a sample log file under the OS temp dir and prints example
// `ssh_tail` / `ssh_monitor` invocations. Uses os.tmpdir() instead of /tmp.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const GREEN = '\x1b[32m';
const NC = '\x1b[0m';
const ok = (m: string) => console.log(`${GREEN}✅${NC} ${m}`);

console.log('🧪 Test SSH Monitoring Tools');
console.log('============================');
console.log('');

// 1. Create a sample log file locally (cross-platform temp location).
const TEST_LOG = path.join(os.tmpdir(), 'test-app.log');
console.log(`Creating test log file at ${TEST_LOG}...`);

const sampleLog =
  [
    '2025-09-05 10:00:00 [INFO] Application started',
    '2025-09-05 10:00:01 [DEBUG] Loading configuration',
    '2025-09-05 10:00:02 [INFO] Database connection established',
    '2025-09-05 10:00:03 [ERROR] Failed to connect to cache server',
    '2025-09-05 10:00:04 [WARN] Retrying cache connection...',
    '2025-09-05 10:00:05 [INFO] Cache connected on retry',
    '2025-09-05 10:00:06 [INFO] Starting web server on port 3000',
    '2025-09-05 10:00:07 [DEBUG] Routes registered',
    '2025-09-05 10:00:08 [INFO] Server ready',
    '2025-09-05 10:00:09 [INFO] Received request: GET /api/status',
    '2025-09-05 10:00:10 [ERROR] Unhandled exception in /api/users',
    '2025-09-05 10:00:11 [WARN] High memory usage detected: 85%',
    '2025-09-05 10:00:12 [INFO] Request completed: 200 OK',
  ].join('\n') + '\n';
fs.writeFileSync(TEST_LOG, sampleLog, 'utf8');

ok('Test log created with sample data');
console.log('');
console.log('📋 Test Commands for ssh_tail:');
console.log('===============================');
console.log('');
console.log('# Tail last 5 lines (no follow)');
console.log(
  `ssh_tail server:"test-server" file:"${TEST_LOG.replace(/\\/g, '/')}" lines:5 follow:false`
);
console.log('');
console.log('# Tail and filter for ERROR messages only');
console.log(
  `ssh_tail server:"test-server" file:"${TEST_LOG.replace(/\\/g, '/')}" grep:"ERROR" follow:false`
);
console.log('');
console.log('# Follow log in real-time (will stream to stderr)');
console.log('ssh_tail server:"test-server" file:"/var/log/syslog" lines:10 follow:true');
console.log('');
console.log('📊 Test Commands for ssh_monitor:');
console.log('==================================');
console.log('');
console.log('# Get system overview');
console.log('ssh_monitor server:"test-server" type:"overview"');
console.log('');
console.log('# Monitor CPU usage');
console.log('ssh_monitor server:"test-server" type:"cpu"');
console.log('');
console.log('# Check memory usage');
console.log('ssh_monitor server:"test-server" type:"memory"');
console.log('');
console.log('# Check disk space');
console.log('ssh_monitor server:"test-server" type:"disk"');
console.log('');
console.log('# Monitor network');
console.log('ssh_monitor server:"test-server" type:"network"');
console.log('');
console.log('# Check running processes');
console.log('ssh_monitor server:"test-server" type:"process"');
console.log('');
console.log('# Continuous monitoring (not fully implemented)');
console.log('ssh_monitor server:"test-server" type:"overview" interval:5 duration:30');
console.log('');
console.log("⚠️  Note: Replace 'test-server' with an actual configured server name");
console.log("    Run 'ssh_list_servers' to see available servers");
console.log('');
console.log('💡 Tips:');
console.log('  - ssh_tail with follow:true will stream output continuously');
console.log('  - ssh_monitor provides different views of system state');
console.log('  - Use grep parameter in ssh_tail to filter log lines');
console.log('  - All monitoring operations are logged with the logger system');
