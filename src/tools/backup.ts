// Backup & restore tools (ssh_backup_*). Infrastructure arrives via ctx at
// registration time.

import { z } from 'zod';
import path from 'path';
import { executeHook } from '../hooks-system.ts';
import { logger } from '../logger.ts';
import { shSingleQuote } from '../shell-quote.ts';
import {
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
} from '../dump-command-builder.ts';
import {
  BACKUP_TYPES,
  DEFAULT_BACKUP_DIR,
  generateBackupId,
  getBackupMetadataPath,
  getBackupFilePath,
  buildFilesBackupCommand,
  buildRestoreCommand,
  createBackupMetadata,
  buildSaveMetadataCommand,
  buildListBackupsCommand,
  parseBackupsList,
  buildCleanupCommand,
  buildCronScheduleCommand,
} from '../backup-manager.ts';

export function registerBackupTools(ctx: import('../tool-registry.ts').ToolContext) {
  const { register: registerToolConditional, getConnection } = ctx;

  registerToolConditional(
    'ssh_backup_create',
    {
      description:
        'Creates a database or file backup on the remote server over SSH, writing a compressed archive plus a JSON metadata file into backupDir. Supports mysql, postgresql, mongodb, and files (full is not yet implemented and errors). Database types require database; files requires paths. After writing it prunes backups older than retention days (default 7); compress defaults to true. Runs pre-backup and post-backup hooks.',
      inputSchema: {
        server: z.string().describe('Server name'),
        type: z
          .enum(['mysql', 'postgresql', 'mongodb', 'files', 'full'])
          .describe('Backup type: mysql, postgresql, mongodb, files, or full'),
        name: z.string().describe('Backup name (e.g., production, app-data)'),
        database: z.string().optional().describe('Database name (required for db types)'),
        dbUser: z.string().optional().describe('Database user'),
        dbPassword: z.string().optional().describe('Database password'),
        dbHost: z.string().optional().describe('Database host (default: localhost)'),
        dbPort: z.number().optional().describe('Database port'),
        paths: z.array(z.string()).optional().describe('Paths to backup (for files type)'),
        exclude: z.array(z.string()).optional().describe('Patterns to exclude from backup'),
        backupDir: z
          .string()
          .optional()
          .describe(`Backup directory (default: ${DEFAULT_BACKUP_DIR})`),
        retention: z.number().optional().describe('Retention period in days (default: 7)'),
        compress: z.boolean().optional().describe('Compress backup (default: true)'),
      },
    },
    async ({
      server: serverName,
      type,
      name,
      database,
      dbUser,
      dbPassword,
      dbHost,
      dbPort,
      paths,
      exclude,
      backupDir,
      retention = 7,
      compress = true,
    }) => {
      try {
        const ssh = await getConnection(serverName);

        // Execute pre-backup hook
        await executeHook('pre-backup', {
          server: serverName,
          type,
          database,
          paths,
        });

        const backupDirectory = backupDir || DEFAULT_BACKUP_DIR;
        const backupId = generateBackupId(type, name);
        const backupFile = getBackupFilePath(backupId, backupDirectory);
        const metadataPath = getBackupMetadataPath(backupId, backupDirectory);

        // Ensure backup directory exists with proper error handling
        const mkdirResult = await ssh.execCommand(`mkdir -p "${backupDirectory}"`);
        if (mkdirResult.code !== 0) {
          throw new Error(
            `Failed to create backup directory: ${mkdirResult.stderr || mkdirResult.stdout}`
          );
        }

        logger.info(`Creating backup: ${backupId}`, {
          server: serverName,
          type,
          name,
          database,
        });

        // Build backup command based on type
        let backupCommand;

        switch (type) {
          case BACKUP_TYPES.MYSQL:
            if (!database) {
              throw new Error('database parameter required for MySQL backup');
            }
            backupCommand = buildMySQLDumpCommand({
              database,
              user: dbUser,
              password: dbPassword,
              host: dbHost,
              port: dbPort,
              outputFile: backupFile,
              compress,
            });
            break;

          case BACKUP_TYPES.POSTGRESQL:
            if (!database) {
              throw new Error('database parameter required for PostgreSQL backup');
            }
            backupCommand = buildPostgreSQLDumpCommand({
              database,
              user: dbUser,
              password: dbPassword,
              host: dbHost,
              port: dbPort,
              outputFile: backupFile,
              compress,
            });
            break;

          case BACKUP_TYPES.MONGODB: {
            if (!database) {
              throw new Error('database parameter required for MongoDB backup');
            }
            const mongoOutputDir = backupFile.replace('.gz', '');
            backupCommand = buildMongoDBDumpCommand({
              database,
              user: dbUser,
              password: dbPassword,
              host: dbHost,
              port: dbPort,
              outputDir: mongoOutputDir,
              compress,
            });
            break;
          }

          case BACKUP_TYPES.FILES:
            if (!paths || paths.length === 0) {
              throw new Error('paths parameter required for files backup');
            }
            backupCommand = buildFilesBackupCommand({
              paths,
              outputFile: backupFile,
              exclude: exclude || [],
              compress,
            });
            break;

          case BACKUP_TYPES.FULL:
            // Full backup combines database and files
            throw new Error(
              'Full backup not yet implemented. Use separate mysql/postgresql/files backups.'
            );

          default:
            throw new Error(`Unknown backup type: ${type}`);
        }

        // Execute backup command
        const result = await ssh.execCommand(backupCommand);

        if (result.code !== 0) {
          throw new Error(`Backup failed: ${result.stderr || result.stdout}`);
        }

        // Get backup file size
        const sizeResult = await ssh.execCommand(
          `stat -f%z "${backupFile}" 2>/dev/null || stat -c%s "${backupFile}" 2>/dev/null`
        );
        const size = parseInt(sizeResult.stdout.trim()) || 0;

        // Create and save metadata
        const metadata = createBackupMetadata(backupId, type, {
          server: serverName,
          database,
          paths,
          compress,
          retention,
        });
        metadata.size = size;
        metadata.status = 'completed';

        const saveMetadataCmd = buildSaveMetadataCommand(metadata, metadataPath);
        await ssh.execCommand(saveMetadataCmd);

        // Cleanup old backups based on retention
        const cleanupCmd = buildCleanupCommand(backupDirectory, retention);
        await ssh.execCommand(cleanupCmd);

        // Execute post-backup hook
        await executeHook('post-backup', {
          server: serverName,
          backupId,
          type,
          size,
          success: true,
        });

        logger.info(`Backup created successfully: ${backupId}`, {
          size,
          location: backupFile,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  backup_id: backupId,
                  type,
                  size,
                  size_human: `${(size / 1024 / 1024).toFixed(2)} MB`,
                  location: backupFile,
                  metadata_path: metadataPath,
                  created_at: metadata.created_at,
                  retention_days: retention,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Backup creation failed', {
          server: serverName,
          type,
          error: error.message,
        });

        await executeHook('post-backup', {
          server: serverName,
          type,
          success: false,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Backup failed: ${error.message}`,
            },
          ],
        };
      }
    },
    // Policy: plain server gate (funnel). Mutating — blocked on readonly/restricted.
    {}
  );

  registerToolConditional(
    'ssh_backup_list',
    {
      description:
        'Lists existing backups found in backupDir on the remote server, returning each backup id, type, database or paths, size, compression, retention, status, and creation time parsed from stored metadata. Read-only: it inspects the filesystem and mutates nothing. Optional type filters results to mysql, postgresql, mongodb, files, or full. backupDir defaults to the configured backup directory.',
      inputSchema: {
        server: z.string().describe('Server name'),
        type: z
          .enum(['mysql', 'postgresql', 'mongodb', 'files', 'full'])
          .optional()
          .describe('Filter by backup type'),
        backupDir: z
          .string()
          .optional()
          .describe(`Backup directory (default: ${DEFAULT_BACKUP_DIR})`),
      },
    },
    async ({ server: serverName, type, backupDir }) => {
      try {
        const ssh = await getConnection(serverName);
        const backupDirectory = backupDir || DEFAULT_BACKUP_DIR;

        logger.info(`Listing backups on ${serverName}`, { type, backupDir: backupDirectory });

        // Build and execute list command
        const listCommand = buildListBackupsCommand(backupDirectory, type);
        const result = await ssh.execCommand(listCommand);

        if (result.code !== 0 && result.stderr) {
          throw new Error(`Failed to list backups: ${result.stderr}`);
        }

        // Parse backups list
        const backups = parseBackupsList(result.stdout);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  count: backups.length,
                  backups: backups.map((b) => ({
                    id: b.id,
                    type: b.type,
                    created_at: b.created_at,
                    database: b.database,
                    paths: b.paths,
                    size: b.size,
                    size_human: b.size ? `${(b.size / 1024 / 1024).toFixed(2)} MB` : 'unknown',
                    compressed: b.compressed,
                    retention_days: b.retention,
                    status: b.status,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to list backups', {
          server: serverName,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to list backups: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_backup_restore',
    {
      description:
        'Restores a previously created backup identified by backupId, reading its metadata to pick the engine. This is destructive and overwrites the target: PostgreSQL runs pg_restore with --clean --if-exists which DROPs existing objects, MongoDB runs mongorestore --drop, and MySQL pipes the dump into the live database replacing matching objects. Supports mysql, postgresql, mongodb, and files. Runs pre-restore and post-restore hooks.',
      inputSchema: {
        server: z.string().describe('Server name'),
        backupId: z.string().describe('Backup ID to restore'),
        database: z.string().optional().describe('Target database name (for db restores)'),
        dbUser: z.string().optional().describe('Database user'),
        dbPassword: z.string().optional().describe('Database password'),
        dbHost: z.string().optional().describe('Database host (default: localhost)'),
        dbPort: z.number().optional().describe('Database port'),
        targetPath: z.string().optional().describe('Target path for files restore (default: /)'),
        backupDir: z
          .string()
          .optional()
          .describe(`Backup directory (default: ${DEFAULT_BACKUP_DIR})`),
      },
    },
    async ({
      server: serverName,
      backupId,
      database,
      dbUser,
      dbPassword,
      dbHost,
      dbPort,
      targetPath,
      backupDir,
    }) => {
      try {
        const ssh = await getConnection(serverName);
        const backupDirectory = backupDir || DEFAULT_BACKUP_DIR;
        const metadataPath = getBackupMetadataPath(backupId, backupDirectory);

        // Read backup metadata
        const metadataResult = await ssh.execCommand(`cat "${metadataPath}"`);
        if (metadataResult.code !== 0) {
          throw new Error(`Backup not found: ${backupId}`);
        }

        const metadata = JSON.parse(metadataResult.stdout);
        const backupFile = getBackupFilePath(backupId, backupDirectory);

        // Execute pre-restore hook
        await executeHook('pre-restore', {
          server: serverName,
          backupId,
          type: metadata.type,
          database,
        });

        logger.info(`Restoring backup: ${backupId}`, {
          server: serverName,
          type: metadata.type,
        });

        // Build restore command
        const restoreCommand = buildRestoreCommand(metadata.type, backupFile, {
          database: database || metadata.database,
          user: dbUser,
          password: dbPassword,
          host: dbHost,
          port: dbPort,
          targetPath,
        });

        // Execute restore
        const result = await ssh.execCommand(restoreCommand);

        if (result.code !== 0) {
          throw new Error(`Restore failed: ${result.stderr || result.stdout}`);
        }

        // Execute post-restore hook
        await executeHook('post-restore', {
          server: serverName,
          backupId,
          type: metadata.type,
          success: true,
        });

        logger.info(`Backup restored successfully: ${backupId}`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  backup_id: backupId,
                  type: metadata.type,
                  restored_at: new Date().toISOString(),
                  original_created: metadata.created_at,
                  database: database || metadata.database,
                  paths: metadata.paths,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Restore failed', {
          server: serverName,
          backupId,
          error: error.message,
        });

        await executeHook('post-restore', {
          server: serverName,
          backupId,
          success: false,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Restore failed: ${error.message}`,
            },
          ],
        };
      }
    },
    // Policy: plain server gate (funnel). Mutating — blocked on readonly/restricted.
    {}
  );

  registerToolConditional(
    'ssh_backup_schedule',
    {
      description:
        'Schedules a recurring backup on the remote server by writing an executable bash script to /usr/local/bin/ssh4agent-backup-NAME.sh and installing a crontab entry for the given cron expression. Mutates the remote filesystem and crontab, and typically needs root to write that path. Supports mysql, postgresql, mongodb, and files; the generated script also deletes backups older than retention days (default 7).',
      inputSchema: {
        server: z.string().describe('Server name'),
        schedule: z.string().describe('Cron schedule (e.g., "0 2 * * *" for daily at 2 AM)'),
        type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).describe('Backup type'),
        name: z.string().describe('Backup name'),
        database: z.string().optional().describe('Database name (for db types)'),
        paths: z.array(z.string()).optional().describe('Paths to backup (for files type)'),
        retention: z.number().optional().describe('Retention period in days (default: 7)'),
      },
    },
    async ({ server: serverName, schedule, type, name, database, paths, retention = 7 }) => {
      try {
        const ssh = await getConnection(serverName);

        // Build backup script path.
        // BREAKING (unreleased): pre-rebrand /usr/local/bin/ssh-manager-backup-*
        // scripts are no longer managed; re-schedule on existing hosts.
        const scriptPath = `/usr/local/bin/ssh4agent-backup-${name}.sh`;
        const backupDirectory = DEFAULT_BACKUP_DIR;

        // Create backup script
        let scriptContent = '#!/bin/bash\n\n';
        scriptContent += `# ssh4agent automated backup: ${name}\n`;
        scriptContent += `# Type: ${type}\n`;
        scriptContent += `# Created: ${new Date().toISOString()}\n\n`;

        const backupId = `\${BACKUP_TYPE}_${name}_$(date +%Y%m%d_%H%M%S)_\${RANDOM}`;
        const backupFile = `${backupDirectory}/${backupId}.gz`;

        scriptContent += `BACKUP_DIR="${backupDirectory}"\n`;
        scriptContent += `BACKUP_TYPE="${type}"\n`;
        scriptContent += `BACKUP_ID="${backupId}"\n`;
        scriptContent += `BACKUP_FILE="${backupFile}"\n\n`;
        scriptContent += 'mkdir -p "$BACKUP_DIR"\n\n';

        // Add backup command based on type. Database dumps reuse the single
        // dump-command-builder implementation (quoted); the placeholder is
        // swapped afterwards for the runtime-expanded $BACKUP_FILE variable,
        // which must stay unquoted inside the generated script.
        const RUNTIME_OUTPUT = '\x00BACKUP_FILE';
        switch (type) {
          case BACKUP_TYPES.MYSQL:
            scriptContent +=
              buildMySQLDumpCommand({
                database,
                outputFile: RUNTIME_OUTPUT,
                compress: true,
              }).replace(shSingleQuote(RUNTIME_OUTPUT), '"$BACKUP_FILE"') + '\n';
            break;
          case BACKUP_TYPES.POSTGRESQL:
            scriptContent +=
              buildPostgreSQLDumpCommand({
                database,
                outputFile: RUNTIME_OUTPUT,
                compress: true,
              }).replace(shSingleQuote(RUNTIME_OUTPUT), '"$BACKUP_FILE"') + '\n';
            break;
          case BACKUP_TYPES.MONGODB: {
            // mongodump --out is a DIRECTORY: dump to a runtime tmp dir via
            // the shared builder, then tar it into $BACKUP_FILE.
            const RUNTIME_TMP = '\x00MONGO_TMP';
            scriptContent += 'MONGO_TMP="/tmp/mongo_$(date +%s)_$$"\n';
            scriptContent +=
              buildMongoDBDumpCommand({
                database,
                outputDir: RUNTIME_TMP,
                compress: false,
              }).replace(shSingleQuote(RUNTIME_TMP), '"$MONGO_TMP"') +
              ' && tar -czf "$BACKUP_FILE" -C "$(dirname "$MONGO_TMP")" "$(basename "$MONGO_TMP")" && rm -rf "$MONGO_TMP"\n';
            break;
          }
          case BACKUP_TYPES.FILES:
            scriptContent += `tar -czf "$BACKUP_FILE" ${paths.map(shSingleQuote).join(' ')}\n`;
            break;
        }

        // Add cleanup command
        scriptContent += '\n# Cleanup old backups\n';
        scriptContent += `find "$BACKUP_DIR" -name "*_${name}_*" -type f -mtime +${retention} -delete\n`;

        // Save script to remote server
        await ssh.execCommand(
          `echo ${shSingleQuote(scriptContent)} > "${scriptPath}" && chmod +x "${scriptPath}"`
        );

        // Add to crontab
        const cronComment = `ssh4agent-backup-${name}`;
        const cronCommand = buildCronScheduleCommand(schedule, scriptPath, cronComment);
        const cronResult = await ssh.execCommand(cronCommand);

        if (cronResult.code !== 0) {
          throw new Error(`Failed to schedule backup: ${cronResult.stderr}`);
        }

        logger.info(`Backup scheduled: ${name}`, {
          server: serverName,
          schedule,
          type,
          retention,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  name,
                  schedule,
                  type,
                  database,
                  paths,
                  retention_days: retention,
                  script_path: scriptPath,
                  next_run: 'Use crontab -l to see next run time',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to schedule backup', {
          server: serverName,
          name,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to schedule backup: ${error.message}`,
            },
          ],
        };
      }
    },
    // Policy: plain server gate (funnel). Mutating — blocked on readonly/restricted.
    {}
  );

  // ============================================================================
  // HEALTH CHECKS & MONITORING TOOLS
  // ============================================================================
}
