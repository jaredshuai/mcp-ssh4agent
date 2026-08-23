/**
 * Backup Manager for MCP SSH4Agent
 * Handles creation, listing, restoration, and scheduling of backups
 * Supports databases (MySQL, PostgreSQL, MongoDB) and file backups
 */

import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.ts';
import { shSingleQuote } from './shell-quote.ts';
import {
  buildMySQLImportCommand,
  buildPostgreSQLImportCommand,
  buildMongoDBRestoreCommand,
} from './database-manager.ts';

// Backup types
export const BACKUP_TYPES = {
  MYSQL: 'mysql',
  POSTGRESQL: 'postgresql',
  MONGODB: 'mongodb',
  FILES: 'files',
  FULL: 'full',
};

// Default backup directory.
// BREAKING (unreleased): backups under the pre-rebrand /var/backups/ssh-manager
// are no longer discovered; re-create backup jobs on existing hosts.
export const DEFAULT_BACKUP_DIR = '/var/backups/ssh4agent';

/**
 * Generate unique backup ID
 */
export function generateBackupId(type, name) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomBytes(4).toString('hex');
  return `${type}_${name}_${timestamp}_${random}`;
}

/**
 * Get backup metadata file path
 */
export function getBackupMetadataPath(backupId, backupDir = DEFAULT_BACKUP_DIR) {
  return path.join(backupDir, `${backupId}.meta.json`);
}

/**
 * Get backup file path
 */
export function getBackupFilePath(backupId, backupDir = DEFAULT_BACKUP_DIR, extension = '.gz') {
  return path.join(backupDir, `${backupId}${extension}`);
}

// Dump commands (MySQL / PostgreSQL / MongoDB) live in
// src/dump-command-builder.ts — single quoted implementation shared with the
// database tools. The unquoted copies that used to live here interpolated
// passwords and paths raw into the command string.

/**
 * Build files backup command (tar + gzip)
 */
export function buildFilesBackupCommand(options) {
  const { paths, outputFile, exclude = [], compress = true } = options;

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array');
  }

  let command = 'tar';

  // Compression flag
  if (compress) {
    command += ' -czf';
  } else {
    command += ' -cf';
  }

  // Output file
  command += ` "${outputFile}"`;

  // Exclude patterns
  for (const pattern of exclude) {
    command += ` --exclude="${pattern}"`;
  }

  // Paths to backup
  command += ` ${paths.map((p) => `"${p}"`).join(' ')}`;

  return command;
}

/**
 * Build backup restore command based on type.
 *
 * Database restores delegate to the quoted import/restore builders in
 * database-manager.ts — the local unquoted copies this replaces interpolated
 * passwords and paths raw into the command string (same injection class the
 * shell-quote module exists to prevent).
 */
export function buildRestoreCommand(backupType, backupFile, options = {}) {
  switch (backupType) {
    case BACKUP_TYPES.MYSQL:
      return buildMySQLImportCommand({ ...options, inputFile: backupFile });
    case BACKUP_TYPES.POSTGRESQL:
      return buildPostgreSQLImportCommand({ ...options, inputFile: backupFile });
    case BACKUP_TYPES.MONGODB:
      return buildMongoDBRestoreCommand({ ...options, inputPath: backupFile });
    case BACKUP_TYPES.FILES:
      return buildFilesRestoreCommand(backupFile, options);
    default:
      throw new Error(`Unknown backup type: ${backupType}`);
  }
}

/**
 * Build files restore command
 */
function buildFilesRestoreCommand(backupFile, options) {
  const { targetPath = '/' } = options;

  let command = 'tar';

  // Auto-detect compression
  if (backupFile.endsWith('.gz') || backupFile.endsWith('.tgz')) {
    command += ' -xzf';
  } else {
    command += ' -xf';
  }

  command += ` "${backupFile}"`;
  command += ` -C "${targetPath}"`;

  return command;
}

/**
 * Create backup metadata object
 */
export function createBackupMetadata(
  backupId,
  type,
  options: {
    server?: string;
    database?: string | null;
    paths?: string[];
    compress?: boolean;
    retention?: number;
  } = {}
) {
  return {
    id: backupId,
    type,
    created_at: new Date().toISOString(),
    server: options.server || 'unknown',
    database: options.database || null,
    paths: options.paths || [],
    size: null, // Will be filled after backup
    compressed: options.compress !== false,
    retention: options.retention || 7, // days
    status: 'pending',
    error: null,
  };
}

/**
 * Build command to save metadata to remote server
 */
export function buildSaveMetadataCommand(metadata, metadataPath) {
  const jsonData = JSON.stringify(metadata, null, 2);
  // Shell-quote the whole JSON payload (single source: shell-quote.ts)
  return `echo ${shSingleQuote(jsonData)} > "${metadataPath}"`;
}

/**
 * Build command to list backups from remote server
 */
export function buildListBackupsCommand(backupDir = DEFAULT_BACKUP_DIR, type = null) {
  let command = `find "${backupDir}" -name "*.meta.json" -type f`;

  if (type) {
    command += ` | grep "${type}_"`;
  }

  // Read and parse each metadata file
  command += ' | while read -r file; do cat "$file"; echo "---"; done';

  return command;
}

/**
 * Parse list backups output
 */
export function parseBackupsList(output) {
  if (!output || !output.trim()) {
    return [];
  }

  const backups = [];
  const metadataBlocks = output.split('---').filter((b) => b.trim());

  for (const block of metadataBlocks) {
    try {
      const metadata = JSON.parse(block.trim());
      backups.push(metadata);
    } catch (error) {
      logger.warn('Failed to parse backup metadata', { error: error.message, block });
    }
  }

  // Sort by created_at descending
  return backups.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

/**
 * Build cleanup old backups command (based on retention)
 */
export function buildCleanupCommand(backupDir = DEFAULT_BACKUP_DIR, retentionDays = 7) {
  // Find backup files older than retention period and delete them
  return `find "${backupDir}" -name "*_*_*" -type f -mtime +${retentionDays} -delete`;
}

/**
 * Build cron schedule command
 */
export function buildCronScheduleCommand(schedule, backupCommand, cronComment) {
  // Add cron job with comment
  const cronLine = `${schedule} ${backupCommand} # ${cronComment}`;
  return `(crontab -l 2>/dev/null; echo '${cronLine}') | crontab -`;
}
