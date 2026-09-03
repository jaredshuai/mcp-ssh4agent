/**
 * Tool Registry
 *
 * Centralized registry of all MCP tools organized into functional groups.
 * Used for conditional tool registration based on user configuration.
 */

/**
 * Runtime context handed to each src/tools/<group>.ts registration function.
 * Built once by the entry point (src/index.ts) and passed as the single
 * argument, so tool modules never import the entry point (no import cycles) —
 * the same provider-injection pattern src/server-groups.ts uses for config.
 *
 * `register` is typed so inline tool handlers keep contextually-typed `any`
 * args (mirrors the original registerToolConditional JSDoc that lived in
 * src/index.js before the split). The infrastructure members are loosely
 * typed; their definition sites in src/index.ts carry the real types.
 *
 * Pooling state is reachable ONLY through the ConnectionPool instance
 * (issue #3) — no raw Maps leak through this interface anymore. Tools take
 * just the members they use; nobody destructures a 15-line checklist.
 */
export interface ToolContext {
  /** Register a tool unless disabled in tool config. */
  register: (
    toolName: string,
    schema: any,
    handler: (args: any, extra?: any) => any,
    policy?: ToolPolicy
  ) => void;
  /** The connection pool: get/close/invalidate/status/sweep/... (src/connection-pool.ts). */
  pool: any;
  getConnection: any;
  closeConnection: any;
  execCommandWithTimeout: any;
  loadServerConfig: any;
  /** Single resolution path: name-or-alias → { name, config } (alias expanded). */
  resolveServer: any;
  getServerConfig: any;
  /** Kept for tools that own their policy evaluation (gate: 'manual'). */
  applyServerPolicy: any;
  /**
   * Success-path audit writer, for manual-gate tools that audit themselves
   * (e.g. ssh_execute_group, per member). Funnel-gated tools never call it.
   */
  auditOk: any;
  cleanupOldConnections: any;
}

/**
 * Policy declaration for a tool registration (issue #6).
 *
 * The registration funnel enforces the per-server security policy and writes
 * the audit trail from ONE place, based on this declaration — a mutating tool
 * can no longer ship without a gate, and "intentionally exempt" is visibly
 * different from "forgot".
 *
 *  - gate 'server' (default): evaluate the policy for `args.server` (or the
 *    value returned by `serverFrom`) before the handler runs, then audit the
 *    outcome on both the success and failure paths.
 *  - gate 'exempt': explicitly no policy, no funnel audit (e.g. ssh_download,
 *    which must stay usable on readonly servers).
 *  - gate 'manual': the handler owns policy/audit itself (e.g. ssh_execute_group
 *    evaluates each group member independently, best-effort).
 *
 *  - commandArg: name of the argument carrying the command to match against
 *    readonly/restricted patterns (command-bearing tools).
 *  - expandAlias: run the command through expandCommandAlias before matching,
 *    so a destructive command cannot hide behind an alias (ssh_execute).
 *  - when: restrict the gate to matching invocations (e.g. only the `kill`
 *    action of ssh_process_manager); non-matching calls skip the policy
 *    evaluation but are still audited.
 */
export interface ToolPolicy {
  gate?: 'server' | 'exempt' | 'manual';
  commandArg?: string;
  expandAlias?: boolean;
  when?: (args: any) => boolean;
  /** Derive the policy subject when it is not `args.server` (e.g. a session's server). */
  serverFrom?: (args: any) => any;
}

/** Dependencies the policy funnel needs, injected by the entry point.
 * Not exported: funnel-internal contract (knip). */
interface PolicyFunnelDeps {
  applyServerPolicy: (server: string, tool: string, args: any, command?: string) => Promise<any>;
  auditOk: (server: string, tool: string, args: any, result: any) => Promise<void>;
  expandCommandAlias?: (command: string) => string;
}

/**
 * The handler contract the funnel enforces (candidate-1 deepening):
 *
 *   - return a string            → text envelope
 *   - return { text, exitCode? } → text envelope, exitCode preserved for audit
 *   - return { content: [...] }  → passed through (structured responses)
 *   - throw                      → audited as failure, returned as an
 *                                  isError envelope (never propagated)
 *
 * Before this, every one of the 37 handlers built its own envelope and catch
 * block; 29 of 38 catch blocks omitted `isError`, so the audit derivation
 * below recorded their failures as SUCCESSES. Envelope building now lives
 * here, once.
 */

/** Coerce a handler's return value into an MCP envelope. */
function normalizeResponse(result: any): any {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) return result;
    if (typeof result.text === 'string') {
      const envelope: any = { content: [{ type: 'text', text: result.text }] };
      // exitCode feeds the audit derivation below; MCP clients ignore it.
      if (typeof result.exitCode === 'number') envelope.exitCode = result.exitCode;
      return envelope;
    }
  }
  return { content: [{ type: 'text', text: String(result ?? '') }] };
}

/** Build the isError envelope for a handler rejection. */
function errorEnvelope(error: unknown): any {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `❌ Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a tool handler with the declared policy gate, audit trail and response
 * envelope.
 *
 * Pure orchestration — no imports from the entry point, fully unit-testable
 * via injected deps. Exempt/manual gates skip policy and funnel audit (the
 * tool owns those) but still get envelope normalization, so a throwing
 * handler can never reach the MCP transport raw under ANY gate.
 */
export function wrapWithPolicy(
  toolName: string,
  handler: (args: any, extra?: any) => any,
  policyDecl: ToolPolicy | undefined,
  deps: PolicyFunnelDeps
): (args: any, extra?: any) => any {
  const gate = policyDecl?.gate ?? 'server';

  if (gate === 'exempt' || gate === 'manual') {
    return async (args, extra) => {
      try {
        return normalizeResponse(await handler(args, extra));
      } catch (error) {
        return errorEnvelope(error);
      }
    };
  }

  return async (args, extra) => {
    const server = policyDecl?.serverFrom ? await policyDecl.serverFrom(args) : args?.server;
    const gateApplies = !policyDecl?.when || policyDecl.when(args);

    if (server && gateApplies) {
      let command: string | undefined;
      if (policyDecl?.commandArg && typeof args?.[policyDecl.commandArg] === 'string') {
        command = args[policyDecl.commandArg];
        if (policyDecl.expandAlias && typeof deps.expandCommandAlias === 'function') {
          command = deps.expandCommandAlias(command);
        }
      }
      const denied = await deps.applyServerPolicy(server, toolName, args, command);
      if (denied) return denied;
    }

    let response: any;
    try {
      response = normalizeResponse(await handler(args, extra));
    } catch (error) {
      if (server) {
        // Same normalization as safeAudit: handlers are seams that may
        // reject with non-Error values — reading .message on one would
        // throw HERE, mask the handler's original error and skip the
        // failure audit entry entirely.
        const message = error instanceof Error ? error.message : String(error);
        await safeAudit(deps, server, toolName, args, { success: false, error: message });
      }
      // Return (not rethrow): the envelope carries isError, so the audit
      // derivation and the MCP client see the failure by construction.
      return errorEnvelope(error);
    }

    if (server) {
      // Failure is derived from BOTH signals: the handler's isError flag
      // (error responses) and a nonzero exitCode (command-bearing tools
      // report the command's exit status) — either means the audit entry
      // must not claim success.
      const failed =
        response?.isError === true ||
        (typeof response?.exitCode === 'number' && response.exitCode !== 0);
      await safeAudit(deps, server, toolName, args, {
        success: !failed,
        code: response?.exitCode,
      });
    }
    return response;
  };
}

/**
 * Auditing must never alter the tool's outcome: if the audit sink itself
 * throws (unwritable path, full disk), log it and swallow it — otherwise it
 * would mask the handler's real result or replace its original error.
 */
async function safeAudit(
  deps: PolicyFunnelDeps,
  server: string,
  toolName: string,
  args: any,
  result: { success: boolean; code?: number; error?: string }
): Promise<void> {
  try {
    await deps.auditOk(server, toolName, args, result);
  } catch (error) {
    // Normalize the rejection: auditOk is a seam (tests/plugins may reject
    // with non-Error values), and reading .message on one would throw HERE
    // and defeat the swallow this wrapper exists for.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`audit write failed for ${toolName} on ${server}: ${message}`);
  }
}

/**
 * Tool groups with their associated tools
 * Total: 37 tools across 6 groups
 */
export const TOOL_GROUPS = {
  // Core group (5 tools) - Essential SSH operations
  core: ['ssh_list_servers', 'ssh_execute', 'ssh_upload', 'ssh_download', 'ssh_sync'],

  // Sessions group (4 tools) - Persistent SSH session management
  sessions: ['ssh_session_start', 'ssh_session_send', 'ssh_session_list', 'ssh_session_close'],

  // Monitoring group (6 tools) - System health and monitoring
  monitoring: [
    'ssh_health_check',
    'ssh_service_status',
    'ssh_process_manager',
    'ssh_monitor',
    'ssh_tail',
    'ssh_alert_setup',
  ],

  // Backup group (4 tools) - Backup and restore operations
  backup: ['ssh_backup_create', 'ssh_backup_list', 'ssh_backup_restore', 'ssh_backup_schedule'],

  // Database group (4 tools) - Database operations
  database: ['ssh_db_dump', 'ssh_db_import', 'ssh_db_list', 'ssh_db_query'],

  // Advanced group (14 tools) - Advanced features
  advanced: [
    'ssh_deploy',
    'ssh_execute_sudo',
    'ssh_alias',
    'ssh_command_alias',
    'ssh_hooks',
    'ssh_profile',
    'ssh_connection_status',
    'ssh_tunnel_create',
    'ssh_tunnel_list',
    'ssh_tunnel_close',
    'ssh_key_manage',
    'ssh_execute_group',
    'ssh_group_manage',
    'ssh_history',
  ],
};

/**
 * Human-readable descriptions for each tool group
 */
export const TOOL_GROUP_DESCRIPTIONS = {
  core: 'Essential SSH operations (list servers, execute commands, upload/download files, sync)',
  sessions: 'Persistent SSH sessions with state management',
  monitoring: 'System health checks, service monitoring, process management, and alerts',
  backup: 'Automated backup and restore for databases and files',
  database: 'Database operations (MySQL, PostgreSQL, MongoDB)',
  advanced: 'Advanced features (deployment, sudo, tunnels, groups, aliases, hooks, profiles)',
};

/**
 * Tool count per group
 */
export const TOOL_GROUP_COUNTS = {
  core: 5,
  sessions: 4,
  monitoring: 6,
  backup: 4,
  database: 4,
  advanced: 14,
};

/**
 * Get all tool names across all groups
 * @returns {string[]} Array of all 37 tool names
 */
export function getAllTools() {
  return Object.values(TOOL_GROUPS).flat();
}

/**
 * Find which group a tool belongs to
 * @param {string} toolName - Name of the tool
 * @returns {string|null} Group name or null if not found
 */
export function findToolGroup(toolName) {
  for (const [groupName, tools] of Object.entries(TOOL_GROUPS)) {
    if (tools.includes(toolName)) {
      return groupName;
    }
  }
  return null;
}

/**
 * Get all tools in a specific group
 * @param {string} groupName - Name of the group
 * @returns {string[]} Array of tool names in the group
 */
export function getGroupTools(groupName) {
  return TOOL_GROUPS[groupName] || [];
}

/**
 * Validate that all expected tools are registered
 * @param {string[]} registeredTools - Array of registered tool names
 * @returns {Object} Validation result with missing and unexpected tools
 */
export function validateToolRegistry(registeredTools) {
  const allExpectedTools = getAllTools();
  const registeredSet = new Set(registeredTools);
  const expectedSet = new Set(allExpectedTools);

  const missing = allExpectedTools.filter((tool) => !registeredSet.has(tool));
  const unexpected = registeredTools.filter((tool) => !expectedSet.has(tool));

  return {
    valid: missing.length === 0 && unexpected.length === 0,
    total: allExpectedTools.length,
    registered: registeredTools.length,
    missing,
    unexpected,
  };
}

/**
 * Get statistics about tool groups
 * @returns {Object} Statistics object
 */
export function getToolStats() {
  const groups = Object.keys(TOOL_GROUPS);
  const totalTools = getAllTools().length;

  return {
    totalGroups: groups.length,
    totalTools,
    groups: groups.map((groupName) => ({
      name: groupName,
      count: TOOL_GROUP_COUNTS[groupName],
      description: TOOL_GROUP_DESCRIPTIONS[groupName],
      tools: TOOL_GROUPS[groupName],
    })),
  };
}

/**
 * Verify tool registry integrity (no duplicates, all accounted for)
 * @returns {Object} Integrity check result
 */
export function verifyIntegrity() {
  const allTools = getAllTools();
  const uniqueTools = new Set(allTools);

  const duplicates = allTools.filter((tool, index) => allTools.indexOf(tool) !== index);

  const expectedTotal = Object.values(TOOL_GROUP_COUNTS).reduce((a, b) => a + b, 0);

  return {
    valid: duplicates.length === 0 && allTools.length === expectedTotal,
    totalTools: allTools.length,
    uniqueTools: uniqueTools.size,
    expectedTotal,
    duplicates,
    issues: []
      .concat(duplicates.length > 0 ? [`Found ${duplicates.length} duplicate tools`] : [])
      .concat(
        allTools.length !== expectedTotal
          ? [`Expected ${expectedTotal} tools but found ${allTools.length}`]
          : []
      ),
  };
}
