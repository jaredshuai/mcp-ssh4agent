// Tool management commands for ssh4agent CLI.
//
// Storage, paths, legacy fallback, counts and descriptions all live in ONE
// place — src/tool-config-manager.ts + src/tool-registry.ts (issue: the CLI
// used to re-implement them and had already drifted: different core-group
// description, a hardcoded 37-tool list in export-claude, and a reset that
// deleted the file and could resurrect a legacy config). This file is
// presentation + prompts only.

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

import { TOOL_GROUPS, TOOL_GROUP_DESCRIPTIONS, getAllTools } from '../../src/tool-registry.ts';
import { loadFreshToolConfig, TOOLS_CONFIG_FILE } from '../../src/tool-config-manager.ts';

const GROUPS = Object.keys(TOOL_GROUPS);

// ── cmd_tools dispatcher ─────────────────────────────────────────────────────
export async function cmd_tools(action?: string, ...rest: string[]): Promise<void> {
  switch (action) {
    case 'list':
    case 'ls':
      await cmd_tools_list();
      break;
    case 'enable':
    case 'on':
      await cmd_tools_enable(rest[0]);
      break;
    case 'disable':
    case 'off':
      await cmd_tools_disable(rest[0]);
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
      await cmd_tools_export_claude();
      break;
    case undefined:
    case '':
      print_error('Missing action');
      process.stdout.write('\n');
      process.stdout.write('Usage: ssh4agent tools <action>\n');
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
export async function cmd_tools_list(): Promise<void> {
  print_header('MCP Tools Configuration');

  if (!fs.existsSync(TOOLS_CONFIG_FILE)) {
    print_info('No tool configuration found');
    process.stdout.write('\n');
    process.stdout.write(`${GRAY}Default: All ${getAllTools().length} tools enabled${NC}\n`);
    process.stdout.write('\n');
    print_info(`Run ${CYAN}ssh4agent tools configure${NC} to customize and reduce context usage`);
    return;
  }

  const manager = await loadFreshToolConfig();
  const summary = manager.getSummary();

  process.stdout.write('\n');
  process.stdout.write(`  ${BOLD}Mode:${NC} ${CYAN}${summary.mode}${NC}\n`);
  process.stdout.write(
    `  ${BOLD}Enabled:${NC} ${summary.enabledCount}/${summary.totalTools} tools\n`
  );
  process.stdout.write(`  ${BOLD}Config:${NC} ${GRAY}${TOOLS_CONFIG_FILE}${NC}\n`);
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

  for (const group of summary.groups) {
    const statusIcon = group.enabled ? `${GREEN}●${NC}` : `${GRAY}○${NC}`;
    const statusText = group.enabled ? `${GREEN}enabled${NC}` : `${GRAY}disabled${NC}`;
    const desc = TOOL_GROUP_DESCRIPTIONS[group.name];
    // bash: printf "%-12s %s %-8s %-8s %s\n"  (status icon+text inline)
    process.stdout.write(
      `${group.name.padEnd(12)} ${statusIcon} ${statusText} ${String(group.toolCount).padEnd(8)} ${desc}\n`
    );
  }

  process.stdout.write('\n');

  if (summary.mode === 'all') {
    print_info(
      `${LIGHTBULB} Tip: Switch to ${CYAN}minimal${NC} mode to reduce context usage by 92%`
    );
    process.stdout.write(`        Run: ${CYAN}ssh4agent tools configure${NC}\n`);
  } else if (summary.mode === 'minimal') {
    print_success(`${CHECK} Optimized! Using only 5 core tools (saves ~40k tokens in Claude Code)`);
    process.stdout.write('\n');
    process.stdout.write(
      `        To enable more tools: ${CYAN}ssh4agent tools enable <group>${NC}\n`
    );
  }

  process.stdout.write('\n');
}

// ── cmd_tools_show ────────────────────────────────────────────────────────────
export function cmd_tools_show(): void {
  if (!fs.existsSync(TOOLS_CONFIG_FILE)) {
    print_error('No configuration file found');
    process.stdout.write('\n');
    process.stdout.write(`Run ${CYAN}ssh4agent tools configure${NC} to create one\n`);
    process.exitCode = 1;
    return;
  }
  print_header('Tool Configuration Details');
  process.stdout.write('\n');
  try {
    const config = JSON.parse(fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8'));
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  } catch {
    print_error('Failed to parse configuration file');
    process.exitCode = 1;
  }
  process.stdout.write('\n');
}

// ── cmd_tools_enable ──────────────────────────────────────────────────────────
export async function cmd_tools_enable(group?: string): Promise<void> {
  if (!group) {
    print_error('Usage: ssh4agent tools enable <group>');
    process.stdout.write('\n');
    process.stdout.write(`Available groups: ${GROUPS.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  if (!(group in TOOL_GROUPS)) {
    print_error(`Unknown group: ${group}`);
    process.stdout.write('\n');
    process.stdout.write(`Available groups: ${GROUPS.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  // The manager owns the mode-transition semantics (materializing the
  // current state before flipping one group), the paths and the write.
  const manager = await loadFreshToolConfig();
  if (!(await manager.enableGroup(group))) {
    print_error(`Failed to enable group: ${group}`);
    process.exitCode = 1;
    return;
  }

  const count = TOOL_GROUPS[group].length;
  print_success(`Enabled ${CYAN}${group}${NC} group (${count} tools)`);
  process.stdout.write('\n');
  print_warning('Restart MCP server for changes to take effect:');
  process.stdout.write('  - Restart Claude Code, or\n');
  process.stdout.write(`  - Run: ${CYAN}claude mcp restart${NC}\n`);
}

// ── cmd_tools_disable ─────────────────────────────────────────────────────────
export async function cmd_tools_disable(group?: string): Promise<void> {
  if (!group) {
    print_error('Usage: ssh4agent tools disable <group>');
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
  if (!(group in TOOL_GROUPS)) {
    print_error(`Unknown group: ${group}`);
    process.stdout.write('\n');
    process.stdout.write('Available groups: sessions, monitoring, backup, database, advanced\n');
    process.exitCode = 1;
    return;
  }

  const manager = await loadFreshToolConfig();
  if (!(await manager.disableGroup(group))) {
    print_error(`Failed to disable group: ${group}`);
    process.exitCode = 1;
    return;
  }

  const count = TOOL_GROUPS[group].length;
  print_success(`Disabled ${CYAN}${group}${NC} group (${count} tools)`);
  process.stdout.write('\n');
  print_warning('Restart MCP server for changes to take effect:');
  process.stdout.write('  - Restart Claude Code, or\n');
  process.stdout.write(`  - Run: ${CYAN}claude mcp restart${NC}\n`);
}

// ── cmd_tools_reset ───────────────────────────────────────────────────────────
export async function cmd_tools_reset(): Promise<void> {
  if (fs.existsSync(TOOLS_CONFIG_FILE)) {
    print_warning(
      `This will reset your tool configuration and enable all ${getAllTools().length} tools`
    );
    process.stdout.write('\n');
    if (await prompt_yes_no('Continue?', 'n')) {
      // Writes the default (mode: all), never deletes the file: deleting it
      // would let a legacy ~/.ssh-manager/tools-config.json resurrect on the
      // next load.
      const manager = await loadFreshToolConfig();
      if (!(await manager.reset())) {
        print_error('Failed to write default configuration');
        process.exitCode = 1;
        return;
      }
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

  const total = getAllTools().length;
  process.stdout.write('\n');
  process.stdout.write(
    `MCP SSH4Agent has ${BOLD}${total} tools${NC} organized into ${BOLD}6 groups${NC}:\n`
  );
  process.stdout.write('\n');

  for (const group of GROUPS) {
    const count = TOOL_GROUPS[group].length;
    const desc = TOOL_GROUP_DESCRIPTIONS[group];
    process.stdout.write(
      `  ${CYAN}${group.padEnd(12)}${NC} (${String(count).padStart(2)} tools) - ${desc}\n`
    );
  }

  process.stdout.write('\n');
  process.stdout.write('Choose configuration mode:\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${GREEN}1) All tools${NC} (recommended for most users)\n`);
  process.stdout.write(`     ├─ All ${total} tools enabled\n`);
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

  const groupsAll = (enabled: boolean) => Object.fromEntries(GROUPS.map((g) => [g, { enabled }]));
  const coreOnly = Object.fromEntries(GROUPS.map((g) => [g, { enabled: g === 'core' }]));

  const manager = await loadFreshToolConfig();

  if (modeChoice === '2') {
    const config = {
      version: '1.0',
      mode: 'minimal',
      groups: coreOnly,
      tools: {},
      _comment: 'Minimal mode - only 5 core tools enabled',
    };
    if (!(await manager.replaceConfig(config))) {
      print_error('Failed to save configuration');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('\n');
    print_success(`Configuration saved: ${YELLOW}Minimal mode${NC} (5 tools)`);
    process.stdout.write('\n');
    process.stdout.write(`  ${GREEN}Context savings:${NC} ~40k tokens (92% reduction)\n`);
    process.stdout.write(`  ${GREEN}Enabled tools:${NC} ${TOOL_GROUPS.core.join(', ')}\n`);
  } else if (modeChoice === '3') {
    process.stdout.write('\n');
    print_subheader('Group Selection');
    process.stdout.write('\n');
    process.stdout.write(`${BOLD}Core${NC} group is always enabled. Choose additional groups:\n`);
    process.stdout.write('\n');

    const chosen: Record<string, boolean> = { core: true };
    for (const group of GROUPS) {
      if (group === 'core') continue;
      const count = TOOL_GROUPS[group].length;
      const desc = TOOL_GROUP_DESCRIPTIONS[group];
      chosen[group] = await prompt_yes_no(
        `${CYAN}${group}${NC} group? (${count} tools - ${desc})`,
        'n'
      );
    }

    const config = {
      version: '1.0',
      mode: 'custom',
      groups: Object.fromEntries(GROUPS.map((g) => [g, { enabled: chosen[g] }])),
      tools: {},
      _comment: 'Custom configuration created by wizard',
    };
    if (!(await manager.replaceConfig(config))) {
      print_error('Failed to save configuration');
      process.exitCode = 1;
      return;
    }

    const enabledCount = GROUPS.reduce(
      (sum, g) => sum + (chosen[g] ? TOOL_GROUPS[g].length : 0),
      0
    );

    process.stdout.write('\n');
    print_success(`Configuration saved: ${CYAN}Custom mode${NC} (${enabledCount} tools enabled)`);
  } else {
    const config = {
      version: '1.0',
      mode: 'all',
      groups: groupsAll(true),
      tools: {},
      _comment: 'All tools enabled (default configuration)',
    };
    if (!(await manager.replaceConfig(config))) {
      print_error('Failed to save configuration');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('\n');
    print_success(`Configuration saved: ${GREEN}All tools mode${NC} (${total} tools)`);
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${BOLD}Config file:${NC} ${GRAY}${TOOLS_CONFIG_FILE}${NC}\n`);
  process.stdout.write('\n');
  print_warning('Restart MCP server for changes to take effect:');
  process.stdout.write(`  ${ARROW} Option 1: Restart Claude Code application\n`);
  process.stdout.write(`  ${ARROW} Option 2: Run ${CYAN}claude mcp restart${NC}\n`);
  process.stdout.write('\n');

  if (await prompt_yes_no('Generate Claude Code auto-approval configuration?', 'y')) {
    await cmd_tools_export_claude();
  }
}

// ── cmd_tools_export_claude ───────────────────────────────────────────────────
export async function cmd_tools_export_claude(): Promise<void> {
  if (!fs.existsSync(TOOLS_CONFIG_FILE)) {
    print_error('No tool configuration found');
    process.stdout.write('\n');
    process.stdout.write(`Run ${CYAN}ssh4agent tools configure${NC} first\n`);
    process.exitCode = 1;
    return;
  }

  print_header('Claude Code Auto-Approval Configuration');
  process.stdout.write('\n');

  // The enabled-tool list is derived from the manager (which respects
  // per-tool overrides too) — previously this command hardcoded all 37 tool
  // names, a third copy of the registry that drifted on every tool change.
  const manager = await loadFreshToolConfig();
  const tools = manager.getEnabledTools();

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
    process.stdout.write(`      "mcp__ssh4agent__${tools[i]}"`);
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
