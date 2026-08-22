// Server management commands for ssh4agent CLI.
//
// Cross-platform TypeScript port of cli/commands/server.sh. The interactive
// add/test/remove paths are async (prompts); list/show/edit_file are sync.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  print_header,
  print_subheader,
  print_info,
  print_warning,
  print_error,
  print_success,
  print_table_header,
  print_table_row,
  prompt_input,
  prompt_password,
  prompt_yes_no,
  question,
} from '../lib/colors.ts';

import {
  SSH4AGENT_ENV,
  get_server_config,
  add_server_to_env,
  remove_server_from_env,
  test_ssh_connection,
  validate_server_name,
  list_invalid_server_names,
  load_servers,
  get_config,
  expandHome,
} from '../lib/config.ts';

import { wizard_edit_server, select_server_menu } from '../lib/menu.ts';

// ── cmd_server_add ───────────────────────────────────────────────────────────
export async function cmd_server_add(): Promise<void> {
  print_header('Add New SSH Server');

  let serverName = '';
  while (true) {
    serverName = await prompt_input(
      'Server name (e.g., prod1, web_server) — letters, digits, underscore only',
      ''
    );
    if (validate_server_name(serverName)) break;
  }

  const host = await prompt_input('Host/IP address', '');
  const user = await prompt_input('Username', 'root');
  const port = await prompt_input('Port', '22');

  process.stdout.write('\nAuthentication method:\n');
  process.stdout.write('  1) SSH Key\n');
  process.stdout.write('  2) Password\n');
  const authChoice = await prompt_input('Choose [1-2]', '');

  let authType: string;
  let authValue: string;
  if (authChoice === '2') {
    authType = 'password';
    authValue = await prompt_password('Password');
  } else {
    authType = 'key';
    authValue = await prompt_input('SSH key path', `${expandHome('~')}/.ssh/id_rsa`);
    authValue = expandHome(authValue);
  }

  const description = await prompt_input('Description (optional)', '');

  // ── Security mode (v3.5.0+) — fully optional, defaults preserve pre-v3.5.0 behavior ──
  let mode = '';
  let allowPatterns = '';
  let auditLog = '';
  process.stdout.write('\n');
  print_info('Security mode (optional — press Enter to skip and keep current behavior)');
  print_info('  unrestricted = no filter (default, identical to v3.4.x)');
  print_info('  readonly     = block mutating tools + built-in destructive command denylist');
  print_info('  restricted   = command must match SSH_SERVER_<N>_ALLOW_PATTERNS');
  mode = await prompt_input('Mode [unrestricted|readonly|restricted]', 'unrestricted');
  if (mode === '') mode = 'unrestricted';

  if (mode === 'restricted') {
    print_info(
      "Allow patterns: ';'-separated list of regex (e.g. '^docker (ps|logs);^kubectl get ')"
    );
    allowPatterns = await prompt_input('ALLOW_PATTERNS (required for restricted)', '');
  }

  print_info('Audit log: absolute file path to append a JSONL audit record per tool call');
  auditLog = await prompt_input('AUDIT_LOG path (optional)', '');

  process.stdout.write('\n');
  print_subheader('Configuration Summary');
  print_table_row('Name:', serverName);
  print_table_row('Host:', host);
  print_table_row('User:', user);
  print_table_row('Port:', port);
  print_table_row('Auth:', authType);
  if (authType === 'key') print_table_row('Key:', authValue);
  if (description) print_table_row('Description:', description);
  if (mode !== 'unrestricted') print_table_row('Mode:', mode);
  if (allowPatterns) print_table_row('Allow patterns:', allowPatterns);
  if (auditLog) print_table_row('Audit log:', auditLog);

  process.stdout.write('\n');
  if (await prompt_yes_no('Save this configuration?', 'y')) {
    add_server_to_env(
      serverName,
      host,
      user,
      authType,
      authValue,
      port,
      description,
      mode,
      allowPatterns,
      auditLog
    );
    process.stdout.write('\n');
    if (await prompt_yes_no('Test connection now?', 'y')) {
      test_ssh_connection(serverName);
    }
  } else {
    print_info('Server configuration cancelled');
  }
}

// ── cmd_server_list ───────────────────────────────────────────────────────────
export function cmd_server_list(): void {
  print_header('SSH Servers');

  const servers = load_servers();
  if (servers.length === 0) {
    print_warning('No servers configured');
    print_info("Use 'ssh4agent server add' to add a server");
    return;
  }

  const invalidNames = list_invalid_server_names();
  const invalidSet = new Set(invalidNames);

  print_table_header('NAME', 'HOST', 'USER');

  for (const server of servers) {
    const host = get_server_config(server, 'HOST') ?? '';
    const user = get_server_config(server, 'USER') ?? '';
    let port = get_server_config(server, 'PORT') ?? '';
    const description = get_server_config(server, 'DESCRIPTION') ?? '';
    port = port || '22';

    let hostInfo = `${host}:${port}`;
    if (description) hostInfo = `${hostInfo} (${description})`;

    let displayName = server;
    if (invalidSet.has(server)) {
      displayName = `${server}  ⚠ invalid`;
    }

    print_table_row(displayName, hostInfo, user);
  }

  process.stdout.write('\n');
  print_info(`Total servers: ${servers.length}`);

  if (invalidNames.length > 0) {
    process.stdout.write('\n');
    print_warning(
      `${invalidNames.length} server(s) have names that are invisible to MCP clients (Claude Code, etc.)`
    );
    print_info(
      'Names with characters other than letters/digits/underscore produce invalid env vars'
    );
    print_info(`Affected: ${invalidNames.join(' ')}`);
    print_info(
      "Fix: 'ssh4agent server remove <name>' then re-add with a valid name (e.g. replace '-' with '_')"
    );
  }
}

// ── cmd_server_test ───────────────────────────────────────────────────────────
export async function cmd_server_test(server?: string): Promise<void> {
  if (!server) {
    print_header('Test SSH Connection');
    const servers = load_servers();
    if (servers.length === 0) {
      print_warning('No servers configured');
      return;
    }
    process.stdout.write('Select a server to test:\n');
    for (let i = 0; i < servers.length; i++) {
      process.stdout.write(`  ${i + 1}) ${servers[i]}\n`);
    }
    process.stdout.write(`Choose [1-${servers.length}]: `);
    const choice = await question('');
    const n = Number(choice);
    if (/^[0-9]+$/.test(choice.trim()) && n >= 1 && n <= servers.length) {
      server = servers[n - 1];
    } else {
      print_error('Invalid choice');
      return;
    }
  }
  test_ssh_connection(server);
}

// ── cmd_server_remove ─────────────────────────────────────────────────────────
export async function cmd_server_remove(server?: string): Promise<void> {
  if (!server) {
    print_header('Remove SSH Server');
    const servers = load_servers();
    if (servers.length === 0) {
      print_warning('No servers configured');
      return;
    }
    process.stdout.write('Select a server to remove:\n');
    for (let i = 0; i < servers.length; i++) {
      const host = get_server_config(servers[i], 'HOST') ?? '';
      process.stdout.write(`  ${i + 1}) ${servers[i]} (${host})\n`);
    }
    process.stdout.write(`Choose [1-${servers.length}]: `);
    const choice = await question('');
    const n = Number(choice);
    if (/^[0-9]+$/.test(choice.trim()) && n >= 1 && n <= servers.length) {
      server = servers[n - 1];
    } else {
      print_error('Invalid choice');
      return;
    }
  }

  const host = get_server_config(server, 'HOST');
  if (!host) {
    print_error(`Server '${server}' not found`);
    return;
  }

  process.stdout.write('\n');
  print_warning(`This will remove server '${server}' (${host})`);
  if (await prompt_yes_no('Are you sure?', 'n')) {
    remove_server_from_env(server);
  } else {
    print_info('Removal cancelled');
  }
}

// ── cmd_server_edit_file ──────────────────────────────────────────────────────
// Opens the .env in the user's editor. Cross-platform default: $EDITOR → config
// default_editor → notepad (win32) / nano (otherwise).
export function cmd_server_edit_file(): void {
  const configured = get_config('default_editor', '');
  const editor =
    process.env.EDITOR || configured || (process.platform === 'win32' ? 'notepad' : 'nano');

  if (!existsSync(SSH4AGENT_ENV)) {
    print_error(`Configuration file not found: ${SSH4AGENT_ENV}`);
    return;
  }

  print_info(`Opening configuration in ${editor}...`);
  const result = spawnSync(editor, [SSH4AGENT_ENV], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    print_error(`Failed to launch editor: ${result.error.message}`);
    return;
  }
  print_success('Configuration updated');
}

// ── cmd_server_edit ───────────────────────────────────────────────────────────
export async function cmd_server_edit(server?: string): Promise<void> {
  if (!server) {
    await wizard_edit_server();
    return;
  }
  // Verify existence, then delegate to the wizard (which shows its own picker).
  const host = get_server_config(server, 'HOST');
  if (!host) {
    print_error(`Server '${server}' not found`);
    return;
  }
  await wizard_edit_server();
}

// ── cmd_server_show ───────────────────────────────────────────────────────────
export function cmd_server_show(server?: string): void {
  if (!server) {
    print_error('Server name required');
    return;
  }
  const host = get_server_config(server, 'HOST');
  if (!host) {
    print_error(`Server '${server}' not found`);
    return;
  }

  print_header(`Server Details: ${server}`);
  print_table_row('Host:', host);
  print_table_row('User:', get_server_config(server, 'USER') ?? '');
  print_table_row('Port:', get_server_config(server, 'PORT') ?? '');

  const keypath = get_server_config(server, 'KEYPATH');
  const password = get_server_config(server, 'PASSWORD');
  if (keypath) {
    print_table_row('Auth Type:', 'SSH Key');
    print_table_row('Key Path:', keypath);
  } else if (password) {
    print_table_row('Auth Type:', 'Password');
    print_table_row('Password:', '********');
  } else {
    print_table_row('Auth Type:', 'Unknown');
  }

  const description = get_server_config(server, 'DESCRIPTION');
  if (description) print_table_row('Description:', description);

  const defaultDir = get_server_config(server, 'DEFAULT_DIR');
  if (defaultDir) print_table_row('Default Dir:', defaultDir);
}

// ── cmd_server dispatcher ─────────────────────────────────────────────────────
export async function cmd_server(subcommand?: string, ...rest: string[]): Promise<void> {
  switch (subcommand) {
    case 'add':
      await cmd_server_add();
      break;
    case 'list':
    case 'ls':
      cmd_server_list();
      break;
    case 'test':
      await cmd_server_test(rest[0]);
      break;
    case 'remove':
    case 'rm':
      await cmd_server_remove(rest[0]);
      break;
    case 'edit':
      await cmd_server_edit(rest[0]);
      break;
    case 'show':
    case 'info':
      cmd_server_show(rest[0]);
      break;
    default:
      print_error(`Unknown server command: ${subcommand ?? ''}`);
      process.stdout.write('Available commands: add, list, test, remove, edit, show\n');
      process.exitCode = 1;
  }
}
