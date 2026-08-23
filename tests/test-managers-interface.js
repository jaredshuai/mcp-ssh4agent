/**
 * Manager interface tests (issue #8): session-manager, backup-manager and
 * health-monitor each driven through their public interfaces with fakes —
 * no network, no SSH server.
 *
 * The pure-function corners (isPingAlive, parseRsyncStats, ...) were already
 * covered; these tests exercise the CALLING conventions around them — the
 * place the remote-tunnel and alias-policy bugs used to hide.
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { createSession, getSession, listSessions, closeSession } from '../src/session-manager.ts';
import {
  createBackupMetadata,
  getBackupMetadataPath,
  getBackupFilePath,
  buildListBackupsCommand,
  parseBackupsList,
  buildCleanupCommand,
  buildCronScheduleCommand,
  buildFilesBackupCommand,
  BACKUP_TYPES,
} from '../src/backup-manager.ts';
import {
  parseServiceStatus,
  parseProcessList,
  checkAlertThresholds,
  parseComprehensiveHealthCheck,
  createAlertConfig,
} from '../src/health-monitor.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

// ── session-manager via a fake interactive shell ─────────────────────────────

/**
 * Deterministic fake ssh2 shell. The session protocol sends:
 *   init:      printf '\n<readyMarker>\n'
 *   execute:   set +e / <command> / __mcp_status=$? /
 *              printf '\n<endMarker>:%s\n' "$__mcp_status"
 * The fake answers each written line asynchronously, mirroring a remote
 * shell's echo + command output.
 */
class FakeShell extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.written = [];
  }

  write(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    this.written.push(text);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // init ready marker: printf '\nMARKER\n' (with literal \n backslashes)
      let m = line.match(/^printf '\\n(.+?)\\n'$/);
      if (m) {
        this.#emit(`\n${m[1]}\n`);
        continue;
      }
      // execute end marker: printf '\nMARKER:%s\n' "$__mcp_status"
      m = line.match(/^printf '\\n(.+?):%s\\n' "\$__mcp_status"$/);
      if (m) {
        this.#emit(`\n${m[1]}:0\n`);
        continue;
      }
      if (line === 'pwd') {
        this.#emit('/home/fake\n');
        continue;
      }
      if (line.startsWith('echo $PATH')) {
        this.#emit('/usr/local/bin:fakeuser:fakehome\n');
        continue;
      }
      if (line.startsWith('echo ')) {
        this.#emit(`${line.slice(5)}\n`);
        continue;
      }
      // set +e / __mcp_status=$? / cd ... produce no output
    }
  }

  #emit(text) {
    setImmediate(() => this.emit('data', Buffer.from(text)));
  }

  end() {
    setImmediate(() => this.emit('close'));
  }
}

async function testSessions() {
  const shell = new FakeShell();
  const fakeSsh = {
    requestShell: async () => shell,
  };

  const session = await createSession('fake-server', fakeSsh);
  assert.strictEqual(session.state, 'ready');
  assert.strictEqual(session.context.cwd, '/home/fake', 'init captured cwd via pwd');
  assert.strictEqual(session.context.env.USER, 'fakeuser', 'init captured env');

  const result = await session.execute('echo hello-from-session');
  assert.strictEqual(result.success, true, 'command exit 0 → success');
  assert.strictEqual(result.output, 'hello-from-session', 'output captured before marker');
  assert.ok(
    shell.written.join('').includes('echo hello-from-session'),
    'command actually sent to the shell'
  );

  const byId = getSession(session.id);
  assert.strictEqual(byId.id, session.id, 'session registry round-trip');
  assert.ok(
    listSessions().some((s) => s.id === session.id),
    'session listed'
  );

  closeSession(session.id);
  assert.strictEqual(
    listSessions().some((s) => s.id === session.id),
    false,
    'closed → gone'
  );
  ok('session-manager: create → execute → registry → close on a fake shell');
}

// ── backup-manager interface round-trips ────────────────────────────────────

function testBackupManager() {
  const meta = createBackupMetadata('mysql_shop_x', 'mysql', {
    server: 'srv',
    database: 'shop',
  });
  assert.strictEqual(meta.status, 'pending');
  assert.strictEqual(meta.compressed, true, 'compress default');
  assert.strictEqual(meta.retention, 7, 'retention default');

  assert.strictEqual(
    getBackupMetadataPath('id1'),
    path.join('/var/backups/ssh4agent', 'id1.meta.json')
  );
  assert.strictEqual(getBackupFilePath('id1'), path.join('/var/backups/ssh4agent', 'id1.gz'));

  // buildListBackupsCommand output → parseBackupsList input (the wire format
  // the remote `find ... | cat` produces).
  // Backdate the first so the created_at ordering is deterministic even when
  // both metadatas land in the same millisecond.
  meta.created_at = new Date(Date.now() - 60_000).toISOString();
  const meta2 = createBackupMetadata('pg_shop_y', 'postgresql', { server: 'srv2' });
  const wire = [JSON.stringify(meta), '---', JSON.stringify(meta2), '---', 'not json', '---'].join(
    '\n'
  );
  const parsed = parseBackupsList(wire);
  assert.strictEqual(parsed.length, 2, 'bad blocks dropped, good ones kept');
  // Newest first (created_at descending) — the listing contract.
  assert.strictEqual(parsed[0].id, 'pg_shop_y');
  assert.strictEqual(parsed[1].id, 'mysql_shop_x');
  assert.deepStrictEqual(parseBackupsList(''), []);
  assert.deepStrictEqual(parseBackupsList(undefined), []);

  assert.ok(
    buildListBackupsCommand('/backups', 'mysql').includes('grep "mysql_"'),
    'type filter included'
  );
  assert.ok(buildCleanupCommand('/backups', 14).includes('-mtime +14'));
  const cron = buildCronScheduleCommand('0 2 * * *', '/usr/local/bin/bk.sh', 'cmt');
  assert.ok(cron.includes('0 2 * * *') && cron.includes('cmt'));
  assert.ok(
    buildFilesBackupCommand({ paths: ['/a', '/b'], outputFile: '/o.tgz' }).startsWith('tar -czf')
  );
  assert.throws(() => buildFilesBackupCommand({ paths: [], outputFile: '/o' }), /non-empty/);
  assert.strictEqual(BACKUP_TYPES.MYSQL, 'mysql');
  ok('backup-manager: metadata paths, list/parse round-trip, cleanup/cron/files builders');
}

// ── health-monitor parsing + threshold checks ───────────────────────────────

function testHealthMonitor() {
  const svc = parseServiceStatus(
    ['ACTIVE', 'ENABLED', '1234', 'nginx; running'].join('\n'),
    'nginx'
  );
  assert.strictEqual(svc.name, 'nginx');
  assert.strictEqual(svc.status, 'running');
  assert.strictEqual(svc.enabled, 'yes');
  assert.strictEqual(svc.pid, 1234);
  assert.strictEqual(svc.health, 'healthy');

  const dead = parseServiceStatus(['INACTIVE', 'DISABLED', '', ''].join('\n'), 'mysql');
  assert.strictEqual(dead.status, 'stopped');
  assert.strictEqual(dead.pid, null);
  assert.strictEqual(dead.health, 'critical');

  // buildProcessListCommand emits one JSON object per line; a malformed line
  // is dropped with a warning instead of failing the batch.
  const processes = parseProcessList(
    [
      JSON.stringify({ pid: 123, user: 'root', cpu: 1.5, mem: 2.0, command: '/usr/sbin/sshd' }),
      JSON.stringify({ pid: 456, user: 'www', cpu: 0.5, mem: 1.0, command: 'nginx: worker' }),
      'not-json-noise',
    ].join('\n')
  );
  assert.strictEqual(processes.length, 2, 'noise line dropped');
  assert.strictEqual(processes[0].pid, 123);
  assert.strictEqual(processes[1].command, 'nginx: worker');

  const alerts = checkAlertThresholds(
    { cpu: { percent: 95 }, memory: { percent: 50 }, disks: [{ mount: '/', percent: 60 }] },
    { cpu: 90, memory: 80, disk: 80 }
  );
  assert.strictEqual(alerts.length, 1, 'only cpu exceeds');
  assert.strictEqual(alerts[0].type, 'cpu');
  assert.strictEqual(alerts[0].value, 95);

  // buildComprehensiveHealthCheckCommand output format: `=== section ===`
  // blocks; memory/disks are JSON, cpu is a bare percentage.
  const health = parseComprehensiveHealthCheck(
    [
      '=== CPU ===',
      '10',
      '=== MEMORY ===',
      JSON.stringify({ total: 4000, used: 1000, free: 3000, percent: '25.0' }),
      '=== DISK ===',
      JSON.stringify({ mount: '/', percent: 42 }),
      '=== LOAD ===',
      '0.5 0.3 0.2',
    ].join('\n')
  );
  assert.strictEqual(health.overall_status, 'healthy', 'low usage → healthy');
  assert.strictEqual(health.cpu.usage, '10.00');
  assert.strictEqual(health.memory.percent, 25);
  assert.strictEqual(health.disks[0].mount, '/');
  assert.strictEqual(health.load_average, '0.5 0.3 0.2');

  const cfg = createAlertConfig({ cpu: 75 });
  assert.strictEqual(cfg.cpu, 75, 'user override wins');
  assert.strictEqual(cfg.memory, 90, 'unspecified → default');
  ok('health-monitor: service/process parsing, thresholds, comprehensive check, alert config');
}

async function main() {
  // Keep every state write away from the real home during this test.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-mgr-'));
  process.env.SSH4AGENT_HOME = home;

  await testSessions();
  testBackupManager();
  testHealthMonitor();

  delete process.env.SSH4AGENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n✅ manager interface tests passed (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
