// Database tools (ssh_db_*). Infrastructure arrives via ctx at registration time.

import { z } from 'zod';
import path from 'path';
import { logger } from '../logger.ts';
import {
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
} from '../dump-command-builder.ts';
import {
  DB_TYPES,
  buildMySQLImportCommand,
  buildPostgreSQLImportCommand,
  buildMongoDBRestoreCommand,
  buildMySQLListDatabasesCommand,
  buildMySQLListTablesCommand,
  buildPostgreSQLListDatabasesCommand,
  buildPostgreSQLListTablesCommand,
  buildMongoDBListDatabasesCommand,
  buildMongoDBListCollectionsCommand,
  buildMySQLQueryCommand,
  buildPostgreSQLQueryCommand,
  buildMongoDBQueryCommand,
  isSafeQuery,
  countQueryRows,
  parseDatabaseList,
  parseTableList,
  parseSize,
  formatBytes,
} from '../database-manager.ts';

export function registerDatabaseTools(ctx: import('../tool-registry.ts').ToolContext) {
  const { register: registerToolConditional, getConnection } = ctx;

  registerToolConditional(
    'ssh_db_dump',
    {
      description:
        'Dumps a database to a file on the remote server over SSH; it reads data only and does not modify the database. Supports mysql (using --single-transaction --routines --triggers), postgresql (custom format with --clean --if-exists, restorable via pg_restore), and mongodb. compress defaults to true and gzips the output. The optional tables list applies to MySQL and PostgreSQL only and is ignored for MongoDB.',
      inputSchema: {
        server: z.string().describe('Server name'),
        type: z.enum(['mysql', 'postgresql', 'mongodb']).describe('Database type'),
        database: z.string().describe('Database name'),
        outputFile: z.string().describe('Output file path (will be created on remote server)'),
        dbUser: z.string().optional().describe('Database user'),
        dbPassword: z.string().optional().describe('Database password'),
        dbHost: z.string().optional().describe('Database host (default: localhost)'),
        dbPort: z.number().optional().describe('Database port'),
        compress: z.boolean().optional().describe('Compress output with gzip (default: true)'),
        tables: z
          .array(z.string())
          .optional()
          .describe('Specific tables to dump (MySQL/PostgreSQL only)'),
      },
    },
    async ({
      server: serverName,
      type,
      database,
      outputFile,
      dbUser,
      dbPassword,
      dbHost,
      dbPort,
      compress = true,
      tables,
    }) => {
      try {
        const ssh = await getConnection(serverName);

        logger.info(`Dumping ${type} database: ${database}`, {
          server: serverName,
          compress,
        });

        // Build dump command based on type
        let dumpCommand;
        // any: the MongoDB branch adds outputDir below (expando in the .js original)
        const options: any = {
          database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
          outputFile,
          compress,
          tables,
        };

        switch (type) {
          case DB_TYPES.MYSQL:
            dumpCommand = buildMySQLDumpCommand(options);
            break;
          case DB_TYPES.POSTGRESQL:
            dumpCommand = buildPostgreSQLDumpCommand(options);
            break;
          case DB_TYPES.MONGODB:
            options.outputDir = outputFile.replace(/\.(tar\.gz|gz)$/, '');
            dumpCommand = buildMongoDBDumpCommand(options);
            break;
          default:
            throw new Error(`Unsupported database type: ${type}`);
        }

        // Execute dump
        const result = await ssh.execCommand(dumpCommand);

        if (result.code !== 0) {
          throw new Error(`Dump failed: ${result.stderr || result.stdout}`);
        }

        // Get file size
        const sizeCommand = `stat -f%z "${outputFile}" 2>/dev/null || stat -c%s "${outputFile}" 2>/dev/null`;
        const sizeResult = await ssh.execCommand(sizeCommand);
        const size = parseSize(sizeResult.stdout);

        logger.info(`Database dump completed: ${formatBytes(size)}`, {
          server: serverName,
          database,
          size,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  server: serverName,
                  type,
                  database,
                  output_file: outputFile,
                  size_bytes: size,
                  size_human: formatBytes(size),
                  compressed: compress,
                  timestamp: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Database dump failed', {
          server: serverName,
          type,
          database,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Database dump failed: ${error.message}`,
            },
          ],
        };
      }
    },
    // Policy: plain server gate (funnel). Mutating — blocked on readonly/restricted.
    {}
  );

  registerToolConditional(
    'ssh_db_import',
    {
      description:
        'Imports a dump file into a target database on the remote server and is destructive to existing data. PostgreSQL uses pg_restore --clean --if-exists which DROPs existing objects before loading; MongoDB uses mongorestore with --drop controlled by the drop flag (default true); MySQL pipes the file into the live database, replacing objects defined in it. Supports mysql, postgresql, mongodb. Compressed .gz inputs are decompressed automatically.',
      inputSchema: {
        server: z.string().describe('Server name'),
        type: z.enum(['mysql', 'postgresql', 'mongodb']).describe('Database type'),
        database: z.string().describe('Target database name'),
        inputFile: z.string().describe('Input file path (on remote server)'),
        dbUser: z.string().optional().describe('Database user'),
        dbPassword: z.string().optional().describe('Database password'),
        dbHost: z.string().optional().describe('Database host (default: localhost)'),
        dbPort: z.number().optional().describe('Database port'),
        drop: z
          .boolean()
          .optional()
          .describe('Drop existing collections/tables before import (MongoDB only, default: true)'),
      },
    },
    async ({
      server: serverName,
      type,
      database,
      inputFile,
      dbUser,
      dbPassword,
      dbHost,
      dbPort,
      drop = true,
    }) => {
      try {
        const ssh = await getConnection(serverName);

        logger.info(`Importing ${type} database: ${database}`, {
          server: serverName,
          inputFile,
        });

        // Build import command based on type
        let importCommand;
        // any: the MongoDB branch adds inputPath below (expando in the .js original)
        const options: any = {
          database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
          inputFile,
          drop,
        };

        switch (type) {
          case DB_TYPES.MYSQL:
            importCommand = buildMySQLImportCommand(options);
            break;
          case DB_TYPES.POSTGRESQL:
            importCommand = buildPostgreSQLImportCommand(options);
            break;
          case DB_TYPES.MONGODB:
            options.inputPath = inputFile;
            importCommand = buildMongoDBRestoreCommand(options);
            break;
          default:
            throw new Error(`Unsupported database type: ${type}`);
        }

        // Execute import
        const result = await ssh.execCommand(importCommand);

        if (result.code !== 0) {
          throw new Error(`Import failed: ${result.stderr || result.stdout}`);
        }

        logger.info('Database import completed', {
          server: serverName,
          database,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  server: serverName,
                  type,
                  database,
                  input_file: inputFile,
                  timestamp: new Date().toISOString(),
                  message: `Database ${database} imported successfully`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Database import failed', {
          server: serverName,
          type,
          database,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Database import failed: ${error.message}`,
            },
          ],
        };
      }
    },
    // Policy: plain server gate (funnel). Mutating — blocked on readonly/restricted.
    {}
  );

  registerToolConditional(
    'ssh_db_list',
    {
      description:
        'Lists database objects on the remote server for the given engine without modifying anything. When database is provided it lists the tables (SQL) or collections (MongoDB) of that database; when omitted it lists all databases with common system databases filtered out. Supports mysql, postgresql, and mongodb. Returns the items and a count. Read-only and safe to call repeatedly.',
      inputSchema: {
        server: z.string().describe('Server name'),
        type: z.enum(['mysql', 'postgresql', 'mongodb']).describe('Database type'),
        database: z
          .string()
          .optional()
          .describe(
            'Database name (if provided, lists tables/collections; if omitted, lists databases)'
          ),
        dbUser: z.string().optional().describe('Database user'),
        dbPassword: z.string().optional().describe('Database password'),
        dbHost: z.string().optional().describe('Database host (default: localhost)'),
        dbPort: z.number().optional().describe('Database port'),
      },
    },
    async ({ server: serverName, type, database, dbUser, dbPassword, dbHost, dbPort }) => {
      try {
        const ssh = await getConnection(serverName);

        const listType = database ? 'tables/collections' : 'databases';
        logger.info(`Listing ${listType} for ${type}`, {
          server: serverName,
          database,
        });

        let listCommand;
        const options = {
          database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
        };

        // Build command based on type and what to list
        if (database) {
          // List tables/collections
          switch (type) {
            case DB_TYPES.MYSQL:
              listCommand = buildMySQLListTablesCommand(options);
              break;
            case DB_TYPES.POSTGRESQL:
              listCommand = buildPostgreSQLListTablesCommand(options);
              break;
            case DB_TYPES.MONGODB:
              listCommand = buildMongoDBListCollectionsCommand(options);
              break;
          }
        } else {
          // List databases
          switch (type) {
            case DB_TYPES.MYSQL:
              listCommand = buildMySQLListDatabasesCommand(options);
              break;
            case DB_TYPES.POSTGRESQL:
              listCommand = buildPostgreSQLListDatabasesCommand(options);
              break;
            case DB_TYPES.MONGODB:
              listCommand = buildMongoDBListDatabasesCommand(options);
              break;
          }
        }

        // Execute list command
        const result = await ssh.execCommand(listCommand);

        if (result.code !== 0 && result.stderr) {
          throw new Error(`List failed: ${result.stderr}`);
        }

        // Parse results
        const items = database
          ? parseTableList(result.stdout)
          : parseDatabaseList(result.stdout, type);

        // any: the database/tables vs databases branches add different keys
        // (expando in the .js original).
        const response: any = {
          success: true,
          server: serverName,
          type,
          listing: database ? 'tables' : 'databases',
        };

        if (database) {
          response.database = database;
          response.tables = items;
          response.count = items.length;
        } else {
          response.databases = items;
          response.count = items.length;
        }

        logger.info(`Listed ${items.length} ${listType}`, {
          server: serverName,
          type,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Database list failed', {
          server: serverName,
          type,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Database list failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_db_query',
    {
      description:
        'Runs a read-only query against a remote database. For mysql and postgresql it is strictly limited to SELECT: the query must begin with SELECT and any insert, update, delete, drop, create, alter, truncate, grant, revoke, or exec keyword is rejected before execution. For mongodb it runs a find() and requires the collection parameter. Returns the raw command output as text.',
      inputSchema: {
        server: z.string().describe('Server name'),
        type: z.enum(['mysql', 'postgresql', 'mongodb']).describe('Database type'),
        database: z.string().describe('Database name'),
        query: z.string().describe('SQL query (SELECT only) or MongoDB find query'),
        collection: z.string().optional().describe('Collection name (MongoDB only)'),
        dbUser: z.string().optional().describe('Database user'),
        dbPassword: z.string().optional().describe('Database password'),
        dbHost: z.string().optional().describe('Database host (default: localhost)'),
        dbPort: z.number().optional().describe('Database port'),
      },
    },
    async ({
      server: serverName,
      type,
      database,
      query,
      collection,
      dbUser,
      dbPassword,
      dbHost,
      dbPort,
    }) => {
      try {
        const ssh = await getConnection(serverName);

        // Validate query safety for SQL databases
        if (type !== DB_TYPES.MONGODB && !isSafeQuery(query)) {
          throw new Error('Only SELECT queries are allowed for security reasons');
        }

        logger.info(`Executing ${type} query`, {
          server: serverName,
          database,
          query: query.substring(0, 100),
        });

        let queryCommand;
        // any: the MongoDB branch adds collection below (expando in the .js original)
        const options: any = {
          database,
          query,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
        };

        // Build query command based on type
        switch (type) {
          case DB_TYPES.MYSQL:
            queryCommand = buildMySQLQueryCommand(options);
            break;
          case DB_TYPES.POSTGRESQL:
            queryCommand = buildPostgreSQLQueryCommand(options);
            break;
          case DB_TYPES.MONGODB:
            if (!collection) {
              throw new Error('collection parameter required for MongoDB queries');
            }
            options.collection = collection;
            queryCommand = buildMongoDBQueryCommand(options);
            break;
          default:
            throw new Error(`Unsupported database type: ${type}`);
        }

        // Execute query
        const result = await ssh.execCommand(queryCommand);

        if (result.code !== 0) {
          throw new Error(`Query failed: ${result.stderr || result.stdout}`);
        }

        // Parse output (basic parsing, output depends on database type)
        const output = result.stdout.trim();
        // Derive the real row count from each engine's output structure rather than the
        // raw line count, which counts cosmetic wrapper/header lines (issue #45).
        const rowCount = countQueryRows(output, type);

        logger.info('Query executed successfully', {
          server: serverName,
          database,
          rows: rowCount,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  server: serverName,
                  type,
                  database,
                  collection: collection || null,
                  query,
                  row_count: rowCount,
                  output: output,
                  timestamp: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Database query failed', {
          server: serverName,
          type,
          database,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Database query failed: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Clean up connections on shutdown.
  //
  // A stdio MCP server is torn down by its host (e.g. Claude Code) closing our
  // stdin — not by SIGINT, which only arrives on an interactive Ctrl-C. Handling
  // SIGINT alone meant the process was never signalled on normal teardown and was
  // reparented to init as an orphan, leaking one node process per session. Listen
  // for SIGTERM and stdin EOF as well, and make shutdown idempotent so overlapping
}
