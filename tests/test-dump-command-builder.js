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
 *
 * Issues #10 / #11: the compressed dumps must be two-step (dump to temp,
 * checked by &&, then gzip) so a failed producer cannot leave a "successful"
 * empty/partial archive, and the MongoDB archive path must come from the ONE
 * source (mongoArchivePath / getBackupArchivePath) shared by dump, size
 * check, and restore. On POSIX the failure semantics are additionally proven
 * under a real /bin/sh with failing fake dump binaries.
 */

import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
  dumpTempFile,
  mongoArchivePath,
} from '../src/dump-command-builder.ts';
import { shSingleQuote } from '../src/shell-quote.ts';
import {
  buildMySQLImportCommand,
  buildPostgreSQLImportCommand,
  buildMongoDBRestoreCommand,
} from '../src/database-manager.ts';
import {
  buildSaveMetadataCommand,
  buildRestoreCommand,
  getBackupArchivePath,
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

// ── issue #10: compressed dumps are two-step, never a pipe ───────────────────
// A `mysqldump ... | gzip > out` pipeline returns gzip's exit code, so a
// failed producer (wrong password, missing db, full disk) produced an empty
// or partial archive that the tools reported as a successful backup.

{
  const out = '/backups/shop.sql.gz';
  const tmp = dumpTempFile(out);
  for (const [label, cmd] of [
    ['mysql', buildMySQLDumpCommand({ database: 'shop', outputFile: out })],
    ['postgresql', buildPostgreSQLDumpCommand({ database: 'shop', outputFile: out })],
  ]) {
    assert.ok(
      cmd.includes(`> ${shSingleQuote(tmp)}`),
      `${label}: dumps to the temp file first (exit code checked by &&)`
    );
    assert.ok(
      cmd.includes(`gzip -c ${shSingleQuote(tmp)} > ${shSingleQuote(out)}`),
      `${label}: compresses the temp file into the archive`
    );
    assert.ok(
      cmd.includes(`&& rm -f ${shSingleQuote(tmp)}`),
      `${label}: temp file removed on success`
    );
    assert.ok(
      cmd.includes(`|| { rm -f ${shSingleQuote(tmp)} ${shSingleQuote(out)}; exit 1; }`),
      `${label}: failure removes BOTH half-products and exits non-zero`
    );
    assert.ok(!cmd.includes(' | '), `${label}: no exit-code-swallowing pipe: ${cmd}`);
  }
  ok('compressed dumps are two-step (dump → gzip) with failure cleanup (#10)');
}

{
  // compress=false writes the plain dump directly — no gzip, no temp file.
  const cmd = buildMySQLDumpCommand({
    database: 'shop',
    outputFile: '/backups/shop.sql',
    compress: false,
  });
  assert.ok(cmd.includes(`> ${shSingleQuote('/backups/shop.sql')}`), 'direct redirect');
  assert.ok(!cmd.includes('gzip'), 'no gzip step');
  assert.ok(!cmd.includes('.part'), 'no temp file');
  ok('uncompressed dumps keep the direct-redirect shape');
}

// ── issue #11: ONE authoritative MongoDB archive path ────────────────────────

{
  const dumpDir = '/backups/mongodb_shop_1234_abcd';
  assert.strictEqual(mongoArchivePath(dumpDir), `${dumpDir}.tar.gz`, 'suffix contract');

  // The builder tars to exactly mongoArchivePath(outputDir)…
  const cmd = buildMongoDBDumpCommand({ database: 'shop', outputDir: dumpDir });
  assert.ok(
    cmd.includes(`tar -czf ${shSingleQuote(mongoArchivePath(dumpDir))}`),
    `builder tar target must be mongoArchivePath(outputDir): ${cmd}`
  );

  // …and the backup layer derives the same path for create AND restore, so
  // the three consumers (dump command target, size check / reported location,
  // restore input) can never disagree.
  const id = 'mongodb_shop_2026-09-04T00-00-00-000Z_abcd1234';
  const dir = '/var/backups/ssh4agent';
  assert.strictEqual(
    getBackupArchivePath(id, dir, BACKUP_TYPES.MONGODB, true),
    mongoArchivePath(path.join(dir, id)),
    'compressed mongo archive = dumpDir.tar.gz'
  );
  assert.strictEqual(
    getBackupArchivePath(id, dir, BACKUP_TYPES.MONGODB, false),
    path.join(dir, id),
    'uncompressed mongo archive = the dump directory itself'
  );
  assert.strictEqual(
    getBackupArchivePath('mysql_shop_x', dir, BACKUP_TYPES.MYSQL, true),
    path.join(dir, 'mysql_shop_x.gz'),
    'non-mongo types keep the .gz convention'
  );

  // The restore flow consumes exactly that archive shape: a .tar.gz input
  // takes the tar-extract branch of the mongorestore command.
  const restoreCmd = buildRestoreCommand(
    BACKUP_TYPES.MONGODB,
    mongoArchivePath(path.join(dir, id)),
    {}
  );
  assert.ok(restoreCmd.startsWith('tar -xzf'), 'restore extracts the .tar.gz first');
  assert.ok(restoreCmd.includes('mongorestore'), 'restore then runs mongorestore');
  ok('MongoDB dump/size/restore share mongoArchivePath via getBackupArchivePath (#11)');
}

// ── issue #10 semantics under a real /bin/sh ─────────────────────────────────
// Fake dump binaries that fail the way real ones do (error on stderr, partial
// output, non-zero exit) prove the generated command's exit code and cleanup
// behavior — no pipe means no swallowed status, under any POSIX shell.
// Skipped on Windows (no /bin/sh); the Linux CI runs it.

if (process.platform === 'win32') {
  console.log('⏭ skip: dump exit-code semantics need a real /bin/sh (Linux CI runs it)');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-exit-'));
  const fakebin = path.join(tmp, 'bin');
  fs.mkdirSync(fakebin);
  const writeFake = (name, body) => {
    const p = path.join(fakebin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };
  const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };

  try {
    // Failing producer: partial stdout, error on stderr, exit 2 — the exact
    // shape of a wrong-password / missing-db / disk-full mysqldump failure.
    writeFake('mysqldump', 'echo partial; echo "mysqldump: Got error: 1045" >&2; exit 2');

    const out = path.join(tmp, 'shop.sql.gz');
    const cmd = buildMySQLDumpCommand({ database: 'shop', outputFile: out });

    let status = 0;
    try {
      execSync(cmd, { shell: '/bin/sh', env, cwd: tmp, stdio: 'ignore' });
    } catch (error) {
      status = error.status ?? 1;
    }
    assert.ok(status !== 0, 'failing mysqldump must fail the whole command');
    assert.strictEqual(status, 1, 'the cleanup arm exits 1 (producer failure is not swallowed)');
    assert.ok(!fs.existsSync(out), 'no empty/partial archive is left behind');
    assert.ok(!fs.existsSync(dumpTempFile(out)), 'temp file is cleaned up');

    // Succeeding producer: archive exists, holds the dump, temp is gone.
    writeFake('mysqldump', 'echo "-- dump data"');
    execSync(cmd, { shell: '/bin/sh', env, cwd: tmp, stdio: 'ignore' });
    assert.ok(fs.existsSync(out), 'successful dump produces the archive');
    const roundtrip = execSync(`gunzip -c ${shSingleQuote(out)}`, {
      shell: '/bin/sh',
      env,
    }).toString();
    assert.strictEqual(roundtrip.trim(), '-- dump data', 'archive gunzips to the dump');
    assert.ok(!fs.existsSync(dumpTempFile(out)), 'temp removed after success');

    // Same failure contract for PostgreSQL.
    writeFake('pg_dump', 'echo partial; echo "pg_dump: error: connection refused" >&2; exit 3');
    const pgOut = path.join(tmp, 'shop.dump.gz');
    const pgCmd = buildPostgreSQLDumpCommand({ database: 'shop', outputFile: pgOut });
    let pgStatus = 0;
    try {
      execSync(pgCmd, { shell: '/bin/sh', env, cwd: tmp, stdio: 'ignore' });
    } catch (error) {
      pgStatus = error.status ?? 1;
    }
    assert.ok(pgStatus !== 0, 'failing pg_dump must fail the whole command');
    assert.ok(!fs.existsSync(pgOut), 'no partial pg archive left behind');
    assert.ok(!fs.existsSync(dumpTempFile(pgOut)), 'pg temp file is cleaned up');

    ok(
      'real /bin/sh: failed dump → non-zero exit, no residual archive; success → valid gzip (#10)'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── issue #12: compressed imports decompress first, never a pipe ─────────────
// The mirror of #10 on the import side: `gunzip -c X | mysql` reported the
// LAST command's exit code, so a corrupt/truncated archive exited 0 after the
// client consumed the partial stream — a mangled import reported as success.

{
  const input = '/backups/shop.sql.gz';
  const tmp = dumpTempFile(input);
  const cmd = buildMySQLImportCommand({
    database: 'shop',
    user: 'root',
    password: 'p',
    inputFile: input,
  });
  assert.ok(
    cmd.startsWith(`gunzip -c ${shSingleQuote(input)} > ${shSingleQuote(tmp)}`),
    'decompress to the temp file first (exit code checked by &&)'
  );
  assert.ok(cmd.includes('&& mysql'), 'import gated behind gunzip by &&');
  assert.ok(cmd.includes(`< ${shSingleQuote(tmp)}`), 'mysql reads the temp file via redirection');
  assert.ok(cmd.includes(`&& rm -f ${shSingleQuote(tmp)}`), 'temp removed on success');
  assert.ok(
    cmd.includes(`|| { rm -f ${shSingleQuote(tmp)}; exit 1; }`),
    'failure cleans the temp file and exits non-zero'
  );
  assert.ok(!cmd.includes(' | '), `no exit-code-swallowing pipe: ${cmd}`);
  ok('compressed MySQL import is two-step (gunzip → mysql) with failure cleanup (#12)');
}

{
  // Non-gz input: direct < redirection. The old `cat X | mysql` reported 0
  // for a MISSING file (cat errors, mysql succeeds on empty stdin).
  const cmd = buildMySQLImportCommand({ database: 'shop', inputFile: '/backups/shop.sql' });
  assert.ok(!cmd.includes('gunzip'), 'no gunzip stage');
  assert.ok(!cmd.includes('cat '), 'no cat stage');
  assert.ok(!cmd.includes(' | '), 'no pipe');
  assert.ok(cmd.endsWith(`< ${shSingleQuote('/backups/shop.sql')}`), `direct redirection: ${cmd}`);
  ok('plain MySQL import uses direct < redirection (missing file fails the shell)');
}

{
  const input = '/backups/shop.dump.gz';
  const tmp = dumpTempFile(input);
  const cmd = buildPostgreSQLImportCommand({
    database: 'shop',
    password: 'pw',
    inputFile: input,
  });
  assert.ok(
    cmd.startsWith(`gunzip -c ${shSingleQuote(input)} > ${shSingleQuote(tmp)}`),
    'decompress to the temp file first'
  );
  assert.ok(
    cmd.includes(`&& PGPASSWORD=${shSingleQuote('pw')} pg_restore`),
    'PGPASSWORD prefix binds to pg_restore only (gunzip runs without it)'
  );
  assert.ok(
    cmd.includes(`-d ${shSingleQuote('shop')} ${shSingleQuote(tmp)} `),
    'temp file is the pg_restore positional argument'
  );
  assert.ok(cmd.includes(`&& rm -f ${shSingleQuote(tmp)}`), 'temp removed on success');
  assert.ok(
    cmd.includes(`|| { rm -f ${shSingleQuote(tmp)}; exit 1; }`),
    'failure cleans the temp file and exits non-zero'
  );
  assert.ok(!cmd.includes(' | '), `no exit-code-swallowing pipe: ${cmd}`);
  ok('compressed PostgreSQL import is two-step (gunzip → pg_restore) with cleanup (#12)');
}

{
  // Non-gz pg input keeps its shape: PGPASSWORD prefix + direct file argument.
  const cmd = buildPostgreSQLImportCommand({
    database: 'shop',
    password: 'pw',
    inputFile: '/backups/shop.dump',
  });
  assert.ok(cmd.startsWith(`PGPASSWORD=${shSingleQuote('pw')} pg_restore`), 'env prefix kept');
  assert.ok(cmd.endsWith(shSingleQuote('/backups/shop.dump')), 'direct file argument');
  assert.ok(!cmd.includes(' | '), 'no pipe');
  ok('plain PostgreSQL import keeps the direct file argument');
}

// ── issue #12 semantics under a real /bin/sh ─────────────────────────────────
// Corrupt/truncated archives must fail the import BEFORE the database client
// consumes the partial stream, and leave no .part residue. gunzip and tar are
// the REAL ones; mysql / pg_restore / mongorestore are fakes that record they
// ran — proving the real clients never see corrupt input. The mongo check also
// verifies the tar branch's && chain propagates a corrupt-archive failure.
// Skipped on Windows (no /bin/sh); the Linux CI runs it.

if (process.platform === 'win32') {
  console.log('⏭ skip: import exit-code semantics need a real /bin/sh (Linux CI runs it)');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-exit-'));
  const fakebin = path.join(tmp, 'bin');
  const marker = path.join(tmp, 'CLIENT-RAN');
  fs.mkdirSync(fakebin);
  const writeFake = (name) => {
    const p = path.join(fakebin, name);
    fs.writeFileSync(p, `#!/bin/sh\necho ran > ${shSingleQuote(marker)}\nexit 0\n`);
    fs.chmodSync(p, 0o755);
  };
  for (const bin of ['mysql', 'pg_restore', 'mongorestore']) writeFake(bin);
  const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };

  const run = (cmd) => {
    try {
      execSync(cmd, { shell: '/bin/sh', env, cwd: tmp, stdio: 'ignore' });
      return 0;
    } catch (error) {
      return error.status ?? 1;
    }
  };

  // A real gzip archive plus two corruption modes: mid-stream truncation and
  // plain garbage (not a gzip stream at all).
  const validGz = path.join(tmp, 'valid.sql.gz');
  execSync(`printf 'INSERT 1;' | gzip > ${shSingleQuote(validGz)}`, { shell: '/bin/sh' });
  const bytes = fs.readFileSync(validGz);
  const truncated = path.join(tmp, 'trunc.sql.gz');
  fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const garbage = path.join(tmp, 'garbage.sql.gz');
  fs.writeFileSync(garbage, 'definitely not a gzip stream');

  try {
    // MySQL: corrupt/truncated archives fail without invoking the client.
    for (const [label, file] of [
      ['garbage', garbage],
      ['truncated', truncated],
    ]) {
      fs.rmSync(marker, { force: true });
      const status = run(
        buildMySQLImportCommand({ database: 'shop', user: 'root', password: 'p', inputFile: file })
      );
      assert.ok(status !== 0, `mysql import of ${label} archive must fail`);
      assert.ok(!fs.existsSync(marker), `mysql must not consume the ${label} stream`);
      assert.ok(!fs.existsSync(dumpTempFile(file)), `${label}: no .part residue`);
    }

    // MySQL: a valid archive imports, and the temp file is cleaned up.
    fs.rmSync(marker, { force: true });
    assert.strictEqual(
      run(buildMySQLImportCommand({ database: 'shop', inputFile: validGz })),
      0,
      'valid gz import succeeds'
    );
    assert.ok(fs.existsSync(marker), 'mysql consumed the decompressed stream');
    assert.ok(!fs.existsSync(dumpTempFile(validGz)), 'no .part residue after success');

    // MySQL: a missing plain input fails the shell redirection itself.
    fs.rmSync(marker, { force: true });
    const missing = path.join(tmp, 'missing.sql');
    assert.notStrictEqual(
      run(buildMySQLImportCommand({ database: 'shop', inputFile: missing })),
      0,
      'missing non-gz input must fail'
    );
    assert.ok(!fs.existsSync(marker), 'mysql must not run for a missing input');

    // PostgreSQL: a truncated archive fails before pg_restore runs.
    fs.rmSync(marker, { force: true });
    const pgStatus = run(
      buildPostgreSQLImportCommand({ database: 'shop', password: 'pw', inputFile: truncated })
    );
    assert.ok(pgStatus !== 0, 'pg import of truncated archive must fail');
    assert.ok(!fs.existsSync(marker), 'pg_restore must not consume the partial stream');
    assert.ok(!fs.existsSync(dumpTempFile(truncated)), 'no .part residue');

    // PostgreSQL: a valid archive restores and cleans up.
    fs.rmSync(marker, { force: true });
    assert.strictEqual(
      run(buildPostgreSQLImportCommand({ database: 'shop', password: 'pw', inputFile: validGz })),
      0,
      'valid gz pg import succeeds'
    );
    assert.ok(fs.existsSync(marker), 'pg_restore consumed the decompressed stream');
    assert.ok(!fs.existsSync(dumpTempFile(validGz)), 'no .part residue after success');

    // MongoDB: the tar branch is an && chain (not a pipe) — a corrupt .tar.gz
    // fails tar and mongorestore never runs; a valid one restores and the
    // extracted dir is removed.
    fs.rmSync(marker, { force: true });
    const extractDir = path.join(tmp, 'mongo');
    const tarGz = path.join(tmp, 'mongo.tar.gz');
    fs.mkdirSync(extractDir);
    fs.writeFileSync(path.join(extractDir, 'f.bson'), 'data');
    execSync(`tar -czf ${shSingleQuote(tarGz)} -C ${shSingleQuote(tmp)} mongo`, {
      shell: '/bin/sh',
    });
    const tarBytes = fs.readFileSync(tarGz);
    const corruptTar = path.join(tmp, 'corrupt.tar.gz');
    fs.writeFileSync(corruptTar, tarBytes.subarray(0, Math.floor(tarBytes.length / 2)));

    assert.notStrictEqual(
      run(buildMongoDBRestoreCommand({ inputPath: corruptTar })),
      0,
      'mongo restore of a corrupt tar must fail'
    );
    assert.ok(!fs.existsSync(marker), 'mongorestore must not run for a corrupt tar');

    fs.rmSync(marker, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    assert.strictEqual(run(buildMongoDBRestoreCommand({ inputPath: tarGz })), 0);
    assert.ok(fs.existsSync(marker), 'mongorestore ran for the valid tar');
    assert.ok(!fs.existsSync(extractDir), 'extract dir removed after restore');

    ok('real /bin/sh: corrupt archives fail the import chain before any client runs (#12)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n✅ dump command builder tests passed (${passed} checks)`);
