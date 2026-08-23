/**
 * Logger module for MCP SSH4Agent
 * Provides structured logging with levels and optional verbose mode
 */

import fs from 'fs';
import { stateFilePath, readStateFileText, writeStateFileText } from './state-files.ts';

// Command history lives in the state dir (~/.ssh4agent) — the install
// directory is read-only under a global npm install (issue #8).
const HISTORY_FILE_NAME = '.ssh-command-history.json';

// Log levels (module-internal since debug/test-logger.js was removed).
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Colors for terminal output — keyed by level name looked up at runtime.
const COLORS: Record<string, string> = {
  DEBUG: '\x1b[36m', // Cyan
  INFO: '\x1b[32m', // Green
  WARN: '\x1b[33m', // Yellow
  ERROR: '\x1b[31m', // Red
  RESET: '\x1b[0m',
};

// Icons for each level — keyed by level name looked up at runtime.
const ICONS: Record<string, string> = {
  DEBUG: '🔍',
  INFO: '✅',
  WARN: '⚠️',
  ERROR: '❌',
};

// One recorded command execution; fields mirror what saveCommandToHistory writes.
interface HistoryEntry {
  timestamp: string;
  server: string;
  command: string;
  success: boolean;
  duration: string;
  error?: string;
}

class Logger {
  currentLevel: number;
  verbose: boolean;
  logFile: string;
  historyFile: string;
  commandHistory: HistoryEntry[];

  constructor() {
    // Set log level from environment variable
    const envLevel = process.env.SSH_LOG_LEVEL?.toUpperCase() || 'INFO';
    // Arbitrary env string index: unknown levels fall back to INFO via ??.
    this.currentLevel = (LOG_LEVELS as Record<string, number>)[envLevel] ?? LOG_LEVELS.INFO;

    // Enable verbose mode from environment
    this.verbose = process.env.SSH_VERBOSE === 'true';

    // Log file path (state dir unless overridden — see src/state-files.ts)
    this.logFile = process.env.SSH_LOG_FILE || stateFilePath('.ssh4agent.log');

    // Command history file
    this.historyFile = HISTORY_FILE_NAME;

    // Initialize command history
    this.commandHistory = this.loadCommandHistory();
  }

  /**
   * Load command history from the state file (~/.ssh4agent, with one-time
   * migration from the legacy install directory — src/state-files.ts)
   */
  loadCommandHistory(): HistoryEntry[] {
    try {
      const data = readStateFileText(this.historyFile);
      if (data) {
        // External JSON written by saveCommandToHistory; trust its shape.
        return JSON.parse(data) as HistoryEntry[];
      }
    } catch (error) {
      // Ignore errors, start with empty history
    }
    return [];
  }

  /**
   * Save command to history
   */
  saveCommandToHistory(
    command: string,
    server: string,
    result: { success: boolean; duration: string; error?: string }
  ) {
    const entry = {
      timestamp: new Date().toISOString(),
      server,
      command,
      success: result.success,
      duration: result.duration,
      error: result.error,
    };

    this.commandHistory.push(entry);

    // Keep only last 1000 commands
    if (this.commandHistory.length > 1000) {
      this.commandHistory = this.commandHistory.slice(-1000);
    }

    writeStateFileText(this.historyFile, JSON.stringify(this.commandHistory, null, 2));
  }

  /**
   * Format log message with timestamp and level
   */
  formatMessage(level: number, message: string, data: Record<string, unknown> = {}) {
    const timestamp = new Date().toISOString();
    const levelName =
      Object.keys(LOG_LEVELS).find(
        (key) => (LOG_LEVELS as Record<string, number>)[key] === level
      ) || 'INFO';

    // Console format with colors
    const consoleFormat = `${COLORS[levelName]}${ICONS[levelName]} [${timestamp}] [${levelName}]${COLORS.RESET} ${message}`;

    // File format without colors
    const fileFormat = `[${timestamp}] [${levelName}] ${message}`;

    // Add data if present
    let dataStr = '';
    if (Object.keys(data).length > 0) {
      dataStr = '\n  ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ');
    }

    return {
      console: consoleFormat + (this.verbose && dataStr ? dataStr : ''),
      file: fileFormat + dataStr,
    };
  }

  /**
   * Main log function
   */
  log(level: number, message: string, data: Record<string, unknown> = {}) {
    // Check if we should log this level
    if (level < this.currentLevel) {
      return;
    }

    const formatted = this.formatMessage(level, message, data);

    // Output to stderr for proper MCP logging
    console.error(formatted.console);

    // Also write to file
    try {
      fs.appendFileSync(this.logFile, formatted.file + '\n');
    } catch (error) {
      // Ignore file write errors
    }
  }

  // Convenience methods
  debug(message: string, data?: Record<string, unknown>) {
    this.log(LOG_LEVELS.DEBUG, message, data);
  }

  info(message: string, data?: Record<string, unknown>) {
    this.log(LOG_LEVELS.INFO, message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.log(LOG_LEVELS.WARN, message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    this.log(LOG_LEVELS.ERROR, message, data);
  }

  /**
   * Log SSH command execution
   */
  logCommand(server: string, command: string, cwd: string | null = null) {
    const logData = {
      server,
      command: this.verbose
        ? command
        : command.substring(0, 100) + (command.length > 100 ? '...' : ''),
      cwd,
    };

    if (this.verbose) {
      this.debug('Executing SSH command', logData);
    } else {
      this.info(`SSH execute on ${server}`, { command: logData.command });
    }

    return Date.now(); // Return start time for duration calculation
  }

  /**
   * Log SSH command result
   */
  logCommandResult(
    server: string,
    command: string,
    startTime: number,
    result: { code: number; stderr?: string }
  ) {
    const duration = Date.now() - startTime;

    const resultData = {
      success: !result.code,
      duration: `${duration}ms`,
      error: result.code ? result.stderr : undefined,
    };

    // Save to history
    this.saveCommandToHistory(command, server, resultData);

    if (result.code) {
      this.error(`Command failed on ${server}`, resultData);
    } else if (this.verbose) {
      this.debug(`Command completed on ${server}`, resultData);
    }
  }

  /**
   * Log SSH connection events
   */
  logConnection(server: string, event: string, data: Record<string, unknown> = {}) {
    const message = `SSH connection ${event}: ${server}`;

    switch (event) {
      case 'established':
        this.info(message, data);
        break;
      case 'reused':
        this.debug(message, data);
        break;
      case 'closed':
        this.info(message, data);
        break;
      case 'failed':
        this.error(message, data);
        break;
      default:
        this.debug(message, data);
    }
  }

  /**
   * Log file transfer operations
   */
  logTransfer(
    operation: string,
    server: string,
    source: string,
    destination: string,
    result: { success: boolean; size?: unknown; duration?: string; error?: unknown } | null = null
  ) {
    // Loose bag: success/size/duration are only added when result exists.
    const data: Record<string, unknown> = { server, source, destination };

    if (result) {
      data.success = result.success;
      data.size = result.size;
      data.duration = result.duration;
    }

    const message = `File ${operation} ${result ? (result.success ? 'completed' : 'failed') : 'started'}`;

    if (result && !result.success) {
      this.error(message, data);
    } else {
      this.info(message, data);
    }
  }

  /**
   * Get command history
   */
  getHistory(limit = 100) {
    return this.commandHistory.slice(-limit);
  }

  /**
   * Clear logs and history
   */
  clear() {
    this.commandHistory = [];
    try {
      writeStateFileText(this.historyFile, '[]');
      fs.writeFileSync(this.logFile, '');
      this.info('Logs and history cleared');
    } catch (error) {
      this.error('Failed to clear logs', { error: error.message });
    }
  }
}

// Export singleton instance
export const logger = new Logger();
