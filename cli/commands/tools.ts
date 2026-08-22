// Tool management commands for ssh-manager CLI.
//
// Cross-platform TypeScript port of cli/commands/tools.sh. Replaces all `jq`
// invocations with native JSON.parse / JSON.stringify — no external JSON tool
// is needed.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  BOLD,
  CYAN,
  GRAY,
  GREEN,
  YELLOW,
  NC,
  ARROW,
  CHECK,
  LIGHTBULB,
  print_header,
  print_subheader,
  print_info,
  print_warning,
  print_error,
  print_success,
  prompt_yes_no,
  question,
} from '../lib/colors.ts';

// Tool configuration file location — matches bash ($HOME/.ssh-manager/...).
const TOOLS_CONFIG = path.join(os.homedir(), '.ssh-manager', 'tools-config.json');

const GROUPS = ['core', 'sessions', 'monitoring', 'backup', 'database', 'advanced'] as const;
type Group = (typeof GROUPS)[number];

function get_tool_count(group: string): number {
  switch (group) {
    case 'core':
      return 5;
    case 'sessions':
      return 4;
    case 'monitoring':
      return 6;
    case 'backup':
      return 4;
    case 'database':
      return 4;
    case 'advanced':
      return 14;
    default:
      return 0;
  }
}

function get_tool_description(group: string): string {
  switch (group) {
    case 'core':
      return 'Essential SSH operations (list, execute, upload, download, sync)';
    case 'sessions':
      return 'Persistent SSH sessions with state management';
    case 'monitoring':
      return 'System health checks, service monitoring, process management, and alerts';
    case 'backup':
      return 'Automated backup and restore for databases and files';
    case 'database':
      return 'Database operations (MySQL, PostgreSQL, MongoDB)';
    case 'advanced':
      return 'Advanced features (deployment, sudo, tunnels, groups, aliases, hooks, profiles)';
    default:
      return '';
  }
}

// Read the tools config JSON; returns null if missing or unparseable.
function readToolsConfig(): any | null {
  if (!fs.existsSync(TOOLS_CONFIG)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOOLS_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function writeToolsConfig(obj: any): void {
  fs.mkdirSync(path.dirname(TOOLS_CONFIG), { recursive: true });
  fs.writeFileSync(TOOLS_CONFIG, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function groupEnabled(config: any, group: string): boolean {
  const g = config?.groups?.[group];
  return g?.enabled !== false; // default true when missing
}

// ── cmd_tools dispatcher ─────────────────────────────────────────────────────
export async function cmd_tools(action?: string, ...rest: string[]): Promise<void> {
  switch (action) {
    case 'list':
    case 'ls':
      cmd_tools_list();
      break;
    case 'enable':
    case 'on':
      cmd_tools_enable(rest[0]);
      break;
    case 'disable':
    case 'off':
      cmd_tools_disable(rest[0]);
      break;
    case 'reset':
      await cmd_tools_reset();
      break;
    case 'configure':
    case 'config':
    case 'setup':
      await cmd_tools_configure();
      break;
    case 'show':
    case 'status':
      cmd_tools_show();
      break;
    case 'export-claude':
    case 'export':
      cmd_tools_export_claude();
      break;
    case undefined:
    case '':
      print_error('Missing action');
      process.stdout.write('\n');
      process.stdout.write('Usage: ssh-manager tools <action>\n');
      process.stdout.write('\n');
      process.stdout.write('Actions:\n');
      process.stdout.write('  list              Show all tools and their status\n');
      process.stdout.write('  configure         Interactive configuration wizard\n');
      process.stdout.write('  enable <group>    Enable a tool group\n');
      process.stdout.write('  disable <group>   Disable a tool group\n');
      process.stdout.write('  reset             Reset to default (all tools enabled)\n');
      process.stdout.write('  export-claude     Export Claude Code auto-approval config\n');
      process.exitCode = 1;
      break;
    default:
      print_error(`Unknown tools command: ${action}`);
      process.stdout.write('\n');
      process.stdout.write(
        'Available commands: list, configure, enable, disable, reset, export-claude\n'
      );
      process.exitCode = 1;
  }
}

// ── cmd_tools_list ───────────────────────────────────────────────────────────
export function cmd_tools_list(): void {
  print_header('MCP Tools Configuration');

  if (!fs.existsSync(TOOLS_CONFIG)) {
    print_info('No tool configuration found');
    process.stdout.write('\n');
    process.stdout.write(`${GRAY}Default: All 37 tools enabled${NC}\n`);
    process.stdout.write('\n');
    print_info(`Run ${CYAN}ssh-manager tools configure${NC} to customize and reduce context usage`);
    return;
  }

  const config = readToolsConfig();
  const mode = config?.mode ?? 'all';
  const totalCount = 37;
  let enabledCount = 0;

  switch (mode) {
    case 'all':
      enabledCount = 37;
      break;
    case 'minimal':
      enabledCount = 5;
      break;
    case 'custom':
      for (const g of GROUPS) {
        if (groupEnabled(config, g)) {
          enabledCount += get_tool_count(g);
        }
      }
      break;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${BOLD}Mode:${NC} ${CYAN}${mode}${NC}\n`);
  process.stdout.write(`  ${BOLD}Enabled:${NC} ${enabledCount}/${totalCount} tools\n`);
  process.stdout.write(`  ${BOLD}Config:${NC} ${GRAY}${TOOLS_CONFIG}${NC}\n`);
  process.stdout.write('\n');

  print_subheader('Tool Groups');
  process.stdout.write('\n');

  // Header row (matches bash column widths).
  process.stdout.write(
    `${BOLD}${'GROUP'.padEnd(12)} ${'STATUS'.padEnd(10)} ${'TOOLS'.padEnd(8)} DESCRIPTION${NC}\n`
  );
  process.stdout.write(
    `${GRAY}${'────────────'.padEnd(12)} ${'──────────'.padEnd(10)} ${'────────'.padEnd(8)} ${'─'.repeat(41)}${NC}\n`
  );

  for (const group of GROUPS) {
    let enabled = true;
    let statusIcon = `${GREEN}●${NC}`;
    let statusText = `${GREEN}enabled${NC}`;

    if (config) {
      switch (mode) {
        case 'all':
          enabled = true;
          break;
        case 'minimal':
          if (group !== 'core') {
            enabled = false;
            statusIcon = `${GRAY}○${NC}`;
            statusText = `${GRAY}disabled${NC}`;
          }
          break;
        case 'custom':
          if (!groupEnabled(config, group)) {
            enabled = false;
            statusIcon = `${GRAY}○${NC}`;
            statusText = `${GRAY}disabled${NC}`;
          }
          break;
      }
    }

    const count = get_tool_count(group);
    const desc = get_tool_description(group);
    // bash: printf "%-12s %s %-8s %-8s %s\n"  (status icon+text inline)
    process.stdout.write(
      `${group.padEnd(12)} ${statusIcon} ${statusText} ${String(count).padEnd(8)} ${desc}\n`
    );
  }

  process.stdout.write('\n');

  if (mode === 'all') {
    print_info(
      `${LIGHTBULB} Tip: Switch to ${CYAN}minimal${NC} mode to reduce context usage by 92%`
    );
    process.stdout.write(`        Run: ${CYAN}ssh-manager tools configure${NC}\n`);
  } else if (mode === 'minimal') {
    print_success(`${CHECK} Optimized! Using only 5 core tools (saves ~40k tokens in Claude Code)`);
    process.stdout.write('\n');
    process.stdout.write(
      `        To enable more tools: ${CYAN}ssh-manager tools enable <group>${NC}\n`
    );
  }

  process.stdout.write('\n');
}

// ── cmd_tools_show ────────────────────────────────────────────────────────────
export function cmd_tools_show(): void {
  if (!fs.existsSync(TOOLS_CONFIG)) {
    print_error('No configuration file found');
    process.stdout.write('\n');
    process.stdout.write(`Run ${CYAN}ssh-manager tools configure${NC} to create one\n`);
    process.exitCode = 1;
    return;
  }
  print_header('Tool Configuration Details');
  process.stdout.write('\n');
  try {
    const config = JSON.parse(fs.readFileSync(TOOLS_CONFIG, 'utf8'));
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  } catch {
    print_error('Failed to parse configuration file');
    process.exitCode = 1;
  }
  process.stdout.write('\n');
}

// ── cmd_tools_enable ──────────────────────────────────────────────────────────
export function cmd_tools_enable(group?: string): void {
  if (!group) {
    print_error('Usage: ssh-manager tools enable <group>');
    process.stdout.write('\n');
    process.stdout.write(
      'Available groups: core, sessions, monitoring, backup, database, advanced\n'
    );
    process.exitCode = 1;
    return;
  }
  if (!GROUPS.includes(group as Group)) {
    print_error(`Unknown group: ${group}`);
    process.stdout.write('\n');
    process.stdout.write(
      'Available groups: core, sessions, monitoring, backup, database, advanced\n'
    );
    process.exitCode = 1;
    return;
  }

  let config: any;
  if (!fs.existsSync(TOOLS_CONFIG)) {
    config = {
      version: '1.0',
      mode: 'custom',
      groups: {
        core: { enabled: true },
        sessions: { enabled: false },
        monitoring: { enabled: false },
        backup: { enabled: false },
        database: { enabled: false },
        advanced: { enabled: false },
      },
      tools: {},
      _comment: 'Tool configuration created by ssh-manager tools enable',
    };
  } else {
    config = readToolsConfig() ?? { mode: 'all', groups: {} };
    const currentMode = config.mode ?? 'all';
    if (currentMode === 'all') {
      config.mode = 'custom';
      for (const g of GROUPS) config.groups[g] = { enabled: true };
    } else if (currentMode === 'minimal') {
      config.mode = 'custom';
      config.groups.core = { enabled: true };
      for (const g of GROUPS) if (g !== 'core') config.groups[g] = { enabled: false };
    }
  }

  if (!config.groups) config.groups = {};
  config.groups[group] = { enabled: true };
  writeToolsConfig(config);

  const count = get_tool_count(group);
  print_success(`Enabled ${CYAN}${group}${NC} group (${count} tools)`);
  process.stdout.write('\n');
  print_warning('Restart MCP server for changes to take effect:');
  process.stdout.write('  - Restart Claude Code, or\n');
  process.stdout.write(`  - Run: ${CYAN}claude mcp restart${NC}\n`);
}

// ── cmd_tools_disable ─────────────────────────────────────────────────────────
export function cmd_tools_disable(group?: string): void {
  if (!group) {
    print_error('Usage: ssh-manager tools disable <group>');
    process.stdout.write('\n');
    process.stdout.write('Available groups: sessions, monitoring, backup, database, advanced\n');
    process.stdout.write(`${GRAY}Note: 'core' group cannot be disabled${NC}\n`);
    process.exitCode = 1;
    return;
  }
  if (group === 'core') {
    print_error("Cannot disable 'core' group (required for basic functionality)");
    process.exitCode = 1;
    return;
  }
  if (!GROUPS.includes(group as Group)) {
    print_error(`Unknown group: ${group}`);
    process.stdout.write('\n');
    process.stdout.write('Available groups: sessions, monitoring, backup, database, advanced\n');
    process.exitCode = 1;
    return;
  }

  let config: any;
  if (!fs.existsSync(TOOLS_CONFIG)) {
    config = {
      version: '1.0',
      mode: 'custom',
      groups: {
        core: { enabled: true },
        sessions: { enabled: true },
        monitoring: { enabled: true },
        backup: { enabled: true },
        database: { enabled: true },
        advanced: { enabled: true },
      },
      tools: {},
      _comment: 'Tool configuration created by ssh-manager tools disable',
    };
  } else {
    config = readToolsConfig() ?? { mode: 'all', groups: {} };
    const currentMode = config.mode ?? 'all';
    if (currentMode === 'all') {
      config.mode = 'custom';
      for (const g of GROUPS) config.groups[g] = { enabled: true };
    }
  }

  if (!config.groups) config.groups = {};
  config.groups[group] = { enabled: false };
  writeToolsConfig(config);

  const count = get_tool_count(group);
  print_success(`Disabled ${CYAN}${group}${NC} group (${count} tools)`);
  process.stdout.write('\n');
  print_warning('Restart MCP server for changes to take effect:');
  process.stdout.write('  - Restart Claude Code, or\n');
  process.stdout.write(`  - Run: ${CYAN}claude mcp restart${NC}\n`);
}

// ── cmd_tools_reset ───────────────────────────────────────────────────────────
export async function cmd_tools_reset(): Promise<void> {
  if (fs.existsSync(TOOLS_CONFIG)) {
    print_warning('This will delete your tool configuration and enable all 37 tools');
    process.stdout.write('\n');
    if (await prompt_yes_no('Continue?', 'n')) {
      fs.unlinkSync(TOOLS_CONFIG);
      print_success('Tool configuration reset to defaults (all tools enabled)');
      process.stdout.write('\n');
      print_info('Restart Claude Code for changes to take effect');
    } else {
      print_info('Cancelled');
    }
  } else {
    print_info('No configuration file found (already using defaults)');
  }
}

// ── cmd_tools_configure ──────────────────────────────────────────────────────
export async function cmd_tools_configure(): Promise<void> {
  print_header('Tool Configuration Wizard');

  process.stdout.write('\n');
  process.stdout.write(
    `MCP SSH Manager has ${BOLD}37 tools${NC} organized into ${BOLD}6 groups${NC}:\n`
  );
  process.stdout.write('\n');

  for (const group of GROUPS) {
    const count = get_tool_count(group);
    const desc = get_tool_description(group);
    process.stdout.write(
      `  ${CYAN}${group.padEnd(12)}${NC} (${String(count).padStart(2)} tools) - ${desc}\n`
    );
  }

  process.stdout.write('\n');
  process.stdout.write('Choose configuration mode:\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${GREEN}1) All tools${NC} (recommended for most users)\n`);
  process.stdout.write('     ├─ All 37 tools enabled\n');
  process.stdout.write('     ├─ Full feature set available\n');
  process.stdout.write('     └─ Uses ~43k tokens in Claude Code\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${YELLOW}2) Minimal${NC} (lightweight, core functionality only)\n`);
  process.stdout.write('     ├─ Only 5 core tools enabled\n');
  process.stdout.write('     ├─ Reduces context usage by 92%\n');
  process.stdout.write('     └─ Uses ~3.5k tokens in Claude Code\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${CYAN}3) Custom${NC} (choose which groups to enable)\n`);
  process.stdout.write('     ├─ Interactive group selection\n');
  process.stdout.write('     ├─ Fine-tune for your workflow\n');
  process.stdout.write('     └─ Balances features and context usage\n');
  process.stdout.write('\n');

  const modeChoice = await question('Choose [1-3]: ');

  fs.mkdirSync(path.dirname(TOOLS_CONFIG), { recursive: true });

  if (modeChoice === '2') {
    const config = {
      version: '1.0',
      mode: 'minimal',
      groups: {
        core: { enabled: true },
        sessions: { enabled: false },
        monitoring: { enabled: false },
        backup: { enabled: false },
        database: { enabled: false },
        advanced: { enabled: false },
      },
      tools: {},
      _comment: 'Minimal mode - only 5 core tools enabled',
    };
    writeToolsConfig(config);
    process.stdout.write('\n');
    print_success(`Configuration saved: ${YELLOW}Minimal mode${NC} (5 tools)`);
    process.stdout.write('\n');
    process.stdout.write(`  ${GREEN}Context savings:${NC} ~40k tokens (92% reduction)\n`);
    process.stdout.write(
      `  ${GREEN}Enabled tools:${NC} ssh_list_servers, ssh_execute, ssh_upload, ssh_download, ssh_sync\n`
    );
  } else if (modeChoice === '3') {
    process.stdout.write('\n');
    print_subheader('Group Selection');
    process.stdout.write('\n');
    process.stdout.write(`${BOLD}Core${NC} group is always enabled. Choose additional groups:\n`);
    process.stdout.write('\n');

    let sessions = false,
      monitoring = false,
      backup = false,
      database = false,
      advanced = false;
    if (await prompt_yes_no(`${CYAN}sessions${NC} group? (4 tools - persistent SSH sessions)`, 'n'))
      sessions = true;
    if (
      await prompt_yes_no(
        `${CYAN}monitoring${NC} group? (6 tools - health checks, service monitoring)`,
        'n'
      )
    )
      monitoring = true;
    if (await prompt_yes_no(`${CYAN}backup${NC} group? (4 tools - database and file backups)`, 'n'))
      backup = true;
    if (
      await prompt_yes_no(`${CYAN}database${NC} group? (4 tools - MySQL, PostgreSQL, MongoDB)`, 'n')
    )
      database = true;
    if (
      await prompt_yes_no(
        `${CYAN}advanced${NC} group? (14 tools - deployment, sudo, tunnels, etc)`,
        'n'
      )
    )
      advanced = true;

    const config = {
      version: '1.0',
      mode: 'custom',
      groups: {
        core: { enabled: true },
        sessions: { enabled: sessions },
        monitoring: { enabled: monitoring },
        backup: { enabled: backup },
        database: { enabled: database },
        advanced: { enabled: advanced },
      },
      tools: {},
      _comment: 'Custom configuration created by wizard',
    };
    writeToolsConfig(config);

    let enabledCount = 5;
    if (sessions) enabledCount += 4;
    if (monitoring) enabledCount += 6;
    if (backup) enabledCount += 4;
    if (database) enabledCount += 4;
    if (advanced) enabledCount += 14;

    process.stdout.write('\n');
    print_success(`Configuration saved: ${CYAN}Custom mode${NC} (${enabledCount} tools enabled)`);
  } else {
    const config = {
      version: '1.0',
      mode: 'all',
      groups: {
        core: { enabled: true },
        sessions: { enabled: true },
        monitoring: { enabled: true },
        backup: { enabled: true },
        database: { enabled: true },
        advanced: { enabled: true },
      },
      tools: {},
      _comment: 'All tools enabled (default configuration)',
    };
    writeToolsConfig(config);
    process.stdout.write('\n');
    print_success(`Configuration saved: ${GREEN}All tools mode${NC} (37 tools)`);
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${BOLD}Config file:${NC} ${GRAY}${TOOLS_CONFIG}${NC}\n`);
  process.stdout.write('\n');
  print_warning('Restart MCP server for changes to take effect:');
  process.stdout.write(`  ${ARROW} Option 1: Restart Claude Code application\n`);
  process.stdout.write(`  ${ARROW} Option 2: Run ${CYAN}claude mcp restart${NC}\n`);
  process.stdout.write('\n');

  if (await prompt_yes_no('Generate Claude Code auto-approval configuration?', 'y')) {
    cmd_tools_export_claude();
  }
}

// ── cmd_tools_export_claude ───────────────────────────────────────────────────
export function cmd_tools_export_claude(): void {
  if (!fs.existsSync(TOOLS_CONFIG)) {
    print_error('No tool configuration found');
    process.stdout.write('\n');
    process.stdout.write(`Run ${CYAN}ssh-manager tools configure${NC} first\n`);
    process.exitCode = 1;
    return;
  }

  print_header('Claude Code Auto-Approval Configuration');
  process.stdout.write('\n');

  const config = readToolsConfig();
  const mode = config?.mode ?? 'all';

  let tools: string[] = [];
  if (mode === 'all') {
    tools = [
      'ssh_list_servers',
      'ssh_execute',
      'ssh_upload',
      'ssh_download',
      'ssh_sync',
      'ssh_session_start',
      'ssh_session_send',
      'ssh_session_list',
      'ssh_session_close',
      'ssh_health_check',
      'ssh_service_status',
      'ssh_process_manager',
      'ssh_monitor',
      'ssh_tail',
      'ssh_alert_setup',
      'ssh_backup_create',
      'ssh_backup_list',
      'ssh_backup_restore',
      'ssh_backup_schedule',
      'ssh_db_dump',
      'ssh_db_import',
      'ssh_db_list',
      'ssh_db_query',
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
    ];
  } else if (mode === 'minimal') {
    tools = ['ssh_list_servers', 'ssh_execute', 'ssh_upload', 'ssh_download', 'ssh_sync'];
  } else {
    // custom — core always on
    tools = ['ssh_list_servers', 'ssh_execute', 'ssh_upload', 'ssh_download', 'ssh_sync'];
    if (groupEnabled(config, 'sessions')) {
      tools.push('ssh_session_start', 'ssh_session_send', 'ssh_session_list', 'ssh_session_close');
    }
    if (groupEnabled(config, 'monitoring')) {
      tools.push(
        'ssh_health_check',
        'ssh_service_status',
        'ssh_process_manager',
        'ssh_monitor',
        'ssh_tail',
        'ssh_alert_setup'
      );
    }
    if (groupEnabled(config, 'backup')) {
      tools.push(
        'ssh_backup_create',
        'ssh_backup_list',
        'ssh_backup_restore',
        'ssh_backup_schedule'
      );
    }
    if (groupEnabled(config, 'database')) {
      tools.push('ssh_db_dump', 'ssh_db_import', 'ssh_db_list', 'ssh_db_query');
    }
    if (groupEnabled(config, 'advanced')) {
      tools.push(
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
        'ssh_history'
      );
    }
  }

  process.stdout.write(
    `Add this to your ${CYAN}~/.config/claude-code/claude_code_config.json${NC}:\n`
  );
  process.stdout.write('\n');
  process.stdout.write(`${GRAY}${'─'.repeat(60)}${NC}\n`);
  process.stdout.write('{\n');
  process.stdout.write('  "autoApprove": {\n');
  process.stdout.write('    "tools": [\n');
  for (let i = 0; i < tools.length; i++) {
    if (i > 0) process.stdout.write(',\n');
    process.stdout.write(`      "mcp__ssh-manager__${tools[i]}"`);
  }
  process.stdout.write('\n');
  process.stdout.write('    ]\n');
  process.stdout.write('  }\n');
  process.stdout.write('}\n');
  process.stdout.write(`${GRAY}${'─'.repeat(60)}${NC}\n`);
  process.stdout.write('\n');
  print_info(`Copy the ${CYAN}autoApprove${NC} section above into your Claude Code config\n`);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${BOLD}Config location:${NC} ~/.config/claude-code/claude_code_config.json\n`
  );
  process.stdout.write(
    `  ${BOLD}Enabled tools:${NC} ${tools.length} tools will be auto-approved\n`
  );
  process.stdout.write('\n');
}
