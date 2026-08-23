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
    command += ` | gzip > ${shSingleQuote(outputFile)}`;
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
    command += ` | gzip > ${shSingleQuote(outputFile)}`;
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
    command += ` && tar -czf ${shSingleQuote(outputDir + '.tar.gz')} -C "$(dirname ${shSingleQuote(outputDir)})" "$(basename ${shSingleQuote(outputDir)})"`;
    command += ` && rm -rf ${shSingleQuote(outputDir)}`;
  }

  return command;
}
