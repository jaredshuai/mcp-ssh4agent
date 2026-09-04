/**
 * Dump command builder — the single implementation of database dump commands
 * (issue #5).
 *
 * Three copies used to coexist: database-manager.ts (quoted), backup-manager.ts
 * (unquoted — password injection), and an inline set in tools/backup.ts's
 * schedule script. All three callers now share these builders, which quote
 * every interpolated value through shSingleQuote (src/shell-quote.ts) so a
 * value containing quotes, $(...), backticks or spaces can never break out of
 * its shell word.
 */

import { shSingleQuote } from './shell-quote.ts';

/**
 * Temp file used by the two-step dump → compress pipeline (issue #10).
 *
 * A `mysqldump ... | gzip > out` pipeline reports the LAST command's exit
 * code, so a failed dump producer (wrong password, missing database, full
 * disk) left an empty or partial archive that the tools marked as a
 * successful backup. The builders now dump to a temp file first — its exit
 * code is checked by `&&` before gzip ever runs — then compress, and a final
 * `||` arm removes BOTH half-products so no residual archive remains. Pure
 * POSIX semantics: works under any remote login shell (bash, dash, ash),
 * unlike `bash -o pipefail` wrapping.
 */
export function dumpTempFile(outputFile) {
  return `${outputFile}.part`;
}

/**
 * Authoritative MongoDB archive path (issue #11).
 *
 * mongodump writes a DIRECTORY; with compression the archive is that directory
 * tarballed to `<outputDir>.tar.gz`. The dump command, the size check, the
 * reported location, and the restore flow must ALL derive the path through
 * this function — historically each consumer guessed its own suffix
 * (`<id>.gz` vs `<id>.tar.gz`), so backups "succeeded" but could not be
 * size-checked or restored.
 */
export function mongoArchivePath(outputDir) {
  return `${outputDir}.tar.gz`;
}

/**
 * Build MySQL dump command.
 *
 * `tables` (optional) restricts the dump to specific tables.
 */
export function buildMySQLDumpCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 3306,
    outputFile,
    compress = true,
    tables = null,
    singleTransaction = true,
  } = options;

  let command = 'mysqldump';

  if (user) command += ` -u${shSingleQuote(user)}`;
  if (password) command += ` -p${shSingleQuote(password)}`;
  if (host) command += ` -h ${shSingleQuote(host)}`;
  if (port) command += ` -P ${shSingleQuote(port)}`;

  if (singleTransaction) command += ' --single-transaction';
  command += ' --routines --triggers';
  command += ` ${shSingleQuote(database)}`;

  if (tables && Array.isArray(tables)) {
    command += ` ${tables.map(shSingleQuote).join(' ')}`;
  }

  if (compress) {
    // Two-step (issue #10): the producer's failure must fail the whole
    // command and leave no half-written archive behind (see dumpTempFile).
    const tempFile = dumpTempFile(outputFile);
    command += ` > ${shSingleQuote(tempFile)}`;
    command += ` && gzip -c ${shSingleQuote(tempFile)} > ${shSingleQuote(outputFile)}`;
    command += ` && rm -f ${shSingleQuote(tempFile)}`;
    command += ` || { rm -f ${shSingleQuote(tempFile)} ${shSingleQuote(outputFile)}; exit 1; }`;
  } else {
    command += ` > ${shSingleQuote(outputFile)}`;
  }

  return command;
}

/**
 * Build PostgreSQL dump command (password via PGPASSWORD env prefix).
 */
export function buildPostgreSQLDumpCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 5432,
    outputFile,
    compress = true,
    tables = null,
  } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shSingleQuote(password)} `;
  }

  command += 'pg_dump';
  if (user) command += ` -U ${shSingleQuote(user)}`;
  if (host) command += ` -h ${shSingleQuote(host)}`;
  if (port) command += ` -p ${shSingleQuote(port)}`;
  command += ' --format=custom --clean --if-exists';

  if (tables && Array.isArray(tables)) {
    for (const table of tables) {
      command += ` -t ${shSingleQuote(table)}`;
    }
  }

  command += ` ${shSingleQuote(database)}`;

  if (compress) {
    // Two-step (issue #10): see buildMySQLDumpCommand. The PGPASSWORD= prefix
    // above binds to pg_dump only, so gzip in the second step runs without it.
    const tempFile = dumpTempFile(outputFile);
    command += ` > ${shSingleQuote(tempFile)}`;
    command += ` && gzip -c ${shSingleQuote(tempFile)} > ${shSingleQuote(outputFile)}`;
    command += ` && rm -f ${shSingleQuote(tempFile)}`;
    command += ` || { rm -f ${shSingleQuote(tempFile)} ${shSingleQuote(outputFile)}; exit 1; }`;
  } else {
    command += ` > ${shSingleQuote(outputFile)}`;
  }

  return command;
}

/**
 * Build MongoDB dump command (dumps to a directory, optionally tars it up).
 */
export function buildMongoDBDumpCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 27017,
    outputDir,
    compress = true,
    collections = null,
  } = options;

  let command = 'mongodump';
  if (host) command += ` --host ${shSingleQuote(host)}`;
  if (port) command += ` --port ${shSingleQuote(port)}`;
  if (user) command += ` --username ${shSingleQuote(user)}`;
  if (password) command += ` --password ${shSingleQuote(password)}`;
  if (database) command += ` --db ${shSingleQuote(database)}`;

  if (collections && Array.isArray(collections)) {
    for (const collection of collections) {
      command += ` --collection ${shSingleQuote(collection)}`;
    }
  }

  command += ` --out ${shSingleQuote(outputDir)}`;

  if (compress) {
    // The tarball target is the authoritative archive path (issue #11):
    // mongoArchivePath(outputDir) — every consumer derives it from there.
    command += ` && tar -czf ${shSingleQuote(mongoArchivePath(outputDir))} -C "$(dirname ${shSingleQuote(outputDir)})" "$(basename ${shSingleQuote(outputDir)})"`;
    command += ` && rm -rf ${shSingleQuote(outputDir)}`;
  }

  return command;
}
