/**
 * Dump command builder tests (issue #5).
 *
 * The three dump implementations merged into src/dump-command-builder.ts;
 * database quoting goes through shSingleQuote (src/shell-quote.ts). These
 * unit checks pin the exact wire format for passwords/databases containing
 * shell-hostile characters (', ", spaces, $, backticks) — the real-shell
 * injection battery lives in tests/test-database-injection.js.
 *
 * Also covers the consolidated escaping sites: backup metadata JSON, alert
 * config JSON, and backup-manager's restore delegation to the quoted
 * database-manager builders.
 */

import assert from 'assert';
import {
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
} from '../src/dump-command-builder.ts';
import { shSingleQuote } from '../src/shell-quote.ts';
import {
  buildSaveMetadataCommand,
  buildRestoreCommand,
  BACKUP_TYPES,
} from '../src/backup-manager.ts';
import { buildSaveAlertConfigCommand } from '../src/health-monitor.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

const HOSTILE = `p'ass"word $(rm -rf /) \`id\``;

function assertSafelyQuoted(command, payload, label) {
  // The payload must never appear raw (unquoted) in the command.
  assert.ok(!command.includes(payload), `${label}: raw payload leaked into command: ${command}`);
  // And its quoted form (as produced by the single quoting source) must.
  assert.ok(
    command.includes(shSingleQuote(payload)),
    `${label}: quoted payload missing from command: ${command}`
  );
}

// ── dump builders quote hostile passwords ────────────────────────────────────

{
  const cmd = buildMySQLDumpCommand({
    database: 'shop',
    user: 'root',
    password: HOSTILE,
    outputFile: '/tmp/shop.sql.gz',
  });
  assertSafelyQuoted(cmd, HOSTILE, 'mysql dump password');
  assert.ok(cmd.startsWith('mysqldump'), 'mysql dump starts with mysqldump');
  ok('MySQL dump quotes hostile password via shSingleQuote');
}

{
  const cmd = buildPostgreSQLDumpCommand({
    database: 'shop',
    user: 'postgres',
    password: HOSTILE,
    outputFile: '/tmp/shop.dump',
  });
  assertSafelyQuoted(cmd, HOSTILE, 'pg dump password');
  assert.ok(cmd.startsWith(`PGPASSWORD=${shSingleQuote(HOSTILE)}`), 'PGPASSWORD prefix quoted');
  ok('PostgreSQL dump quotes hostile password (PGPASSWORD prefix)');
}

{
  const cmd = buildMongoDBDumpCommand({
    database: 'shop',
    user: 'mongo',
    password: HOSTILE,
    outputDir: '/tmp/shopdump',
  });
  assertSafelyQuoted(cmd, HOSTILE, 'mongo dump password');
  ok('MongoDB dump quotes hostile password');
}

// ── hostile database names survive too ───────────────────────────────────────

{
  const hostileDb = `db'; DROP TABLE users; --`;
  for (const [label, cmd] of [
    ['mysql', buildMySQLDumpCommand({ database: hostileDb, outputFile: '/tmp/x' })],
    ['pg', buildPostgreSQLDumpCommand({ database: hostileDb, outputFile: '/tmp/x' })],
    ['mongo', buildMongoDBDumpCommand({ database: hostileDb, outputDir: '/tmp/x' })],
  ]) {
    assert.ok(!cmd.includes(hostileDb), `${label}: hostile database name leaked raw: ${cmd}`);
  }
  ok('hostile database names are quoted in all three builders');
}

// ── consolidated JSON-escaping sites ─────────────────────────────────────────

{
  const metadata = { id: 'x', note: `it's "quoted" $(pwd) \`ls\`` };
  const cmd = buildSaveMetadataCommand(metadata, '/tmp/meta.json');
  assertSafelyQuoted(cmd, JSON.stringify(metadata, null, 2), 'backup metadata');
  ok('backup metadata JSON goes through shSingleQuote');
}

{
  const config = { cpu: 90, note: `don't $(boom)` };
  const cmd = buildSaveAlertConfigCommand(config, '/tmp/alerts.json');
  assertSafelyQuoted(cmd, JSON.stringify(config, null, 2), 'alert config');
  ok('alert config JSON goes through shSingleQuote');
}

// ── restore delegation is quoted (was raw password interpolation) ───────────

{
  const cmd = buildRestoreCommand(BACKUP_TYPES.MYSQL, '/tmp/shop.sql.gz', {
    database: 'shop',
    user: 'root',
    password: HOSTILE,
  });
  assertSafelyQuoted(cmd, HOSTILE, 'mysql restore password');
  assert.ok(cmd.includes('gunzip'), 'gz backup restore decompresses');
  ok('MySQL restore (delegated) quotes hostile password');
}

{
  const cmd = buildRestoreCommand(BACKUP_TYPES.POSTGRESQL, '/tmp/shop.dump', {
    database: 'shop',
    password: HOSTILE,
  });
  assertSafelyQuoted(cmd, HOSTILE, 'pg restore password');
  ok('PostgreSQL restore (delegated) quotes hostile password');
}

{
  const cmd = buildRestoreCommand(BACKUP_TYPES.MONGODB, '/tmp/shop.tar.gz', {
    password: HOSTILE,
  });
  assertSafelyQuoted(cmd, HOSTILE, 'mongo restore password');
  ok('MongoDB restore (delegated) quotes hostile password');
}

{
  const cmd = buildRestoreCommand(BACKUP_TYPES.FILES, '/tmp/files.tar.gz', {
    targetPath: '/srv/app',
  });
  assert.ok(cmd.startsWith('tar -xzf'), 'files restore stays a tar extract');
  ok('files restore keeps its tar semantics');
}

console.log(`\n✅ dump command builder tests passed (${passed} checks)`);
