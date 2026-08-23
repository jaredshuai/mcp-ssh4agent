// Configuration constants for MCP SSH4Agent

// Output limits to prevent Claude Code crashes
const OUTPUT_LIMITS = {
  // Maximum length of stdout/stderr in responses (characters)
  MAX_OUTPUT_LENGTH: process.env.MCP_SSH_MAX_OUTPUT_LENGTH
    ? parseInt(process.env.MCP_SSH_MAX_OUTPUT_LENGTH)
    : 10000,

  // Maximum length for log file tailing
  MAX_TAIL_LINES: process.env.MCP_SSH_MAX_TAIL_LINES
    ? parseInt(process.env.MCP_SSH_MAX_TAIL_LINES)
    : 100,

  // Maximum length for rsync verbose output
  MAX_RSYNC_OUTPUT: process.env.MCP_SSH_MAX_RSYNC_OUTPUT
    ? parseInt(process.env.MCP_SSH_MAX_RSYNC_OUTPUT)
    : 5000,
};

// Timeout configuration — command execution only. Connection lifetime and
// keepalive cadence live in src/connection-pool.ts (single source of truth;
// the duplicated CONNECTION_TIMEOUT/KEEPALIVE_INTERVAL entries here were
// dead and drifted: 30min/1min vs the pool's 30min/5min).
export const TIMEOUTS = {
  // Default command execution timeout (milliseconds)
  DEFAULT_COMMAND_TIMEOUT: process.env.MCP_SSH_DEFAULT_TIMEOUT
    ? parseInt(process.env.MCP_SSH_DEFAULT_TIMEOUT)
    : 120000, // 2 minutes

  // Maximum allowed command timeout (milliseconds)
  MAX_COMMAND_TIMEOUT: process.env.MCP_SSH_MAX_TIMEOUT
    ? parseInt(process.env.MCP_SSH_MAX_TIMEOUT)
    : 300000, // 5 minutes
};

// Response formatting
const RESPONSE_FORMAT = {
  // Whether to use compact JSON (no formatting)
  COMPACT_JSON: process.env.MCP_SSH_COMPACT_JSON === 'true',

  // Whether to include debug information in responses
  INCLUDE_DEBUG_INFO: process.env.MCP_SSH_DEBUG === 'true',
};

// Helper function to truncate output
export function truncateOutput(text: string, maxLength = OUTPUT_LIMITS.MAX_OUTPUT_LENGTH): string {
  if (!text) return '';

  if (text.length <= maxLength) return text;

  const truncated = text.length - maxLength;
  return text.substring(0, maxLength) + `\n\n... [${truncated} characters truncated]`;
}

// Helper function to format JSON response — accepts any serializable payload.
export function formatJSONResponse(data: unknown): string {
  return JSON.stringify(data, null, RESPONSE_FORMAT.COMPACT_JSON ? 0 : 2);
}

// Helper function to format a duration in seconds as a human-readable string.
// Shared by the session and group tools (moved out of src/index.js when the
// tool registrations were split into src/tools/).
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  } else {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
}
