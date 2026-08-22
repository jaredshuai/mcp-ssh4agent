// Interactive menu library for ssh4agent CLI.
//
// Cross-platform TypeScript port of cli/lib/menu.sh. Menus and wizards are
// async because the prompt primitives (node:readline) are async.
//
// Circular dependency note: this module imports cmd_sync / cmd_tunnel / cmd_ssh
// from ../ssh-manager.ts, while ssh-manager.ts imports the menu/wizard
// functions from here. ESM handles this safely because both sides export
// function declarations (hoisted live bindings); the cross-module references
// are only dereferenced at call time (inside interactive_mode), by which point
// both modules have finished evaluating.

import * as fs from 'node:fs';

import {
  BOLD,
  CYAN,
  GRAY,
  NC,
  print_header,
  print_subheader,
  print_info,
  print_warning,
  print_error,
  print_success,
  print_table_row,
  clear_screen,
  pause,
  question,
  prompt_input,
  prompt_password,
  prompt_yes_no,
  SERVER,
  SESSION,
  SYNC,
  TUNNEL,
  MONITOR,
  ROCKET,
  GEAR,
  INFO,
  CHECK,
  CLIPBOARD,
  WRENCH,
  CROSS,
  NOTE,
  PENCIL,
  KEY,
  LOCK,
  ARROW,
} from './colors.ts';

import {
  SSH4AGENT_ENV,
  SSH4AGENT_CONFIG,
  PROJECT_ROOT,
  get_server_config,
  add_server_to_env,
  update_server_in_env,
  test_ssh_connection,
  validate_server_name,
  load_servers,
  get_config,
  expandHome,
} from './config.ts';

// Cross-module bindings from the main entry (../ssh-manager.ts). These form a
// circular import (ssh-manager.ts → menu.ts → ssh-manager.ts); it is safe
// because every binding below is either a function declaration (hoisted live
// binding) or a `const` that is only *read* inside functions at call time — by
// which point the main entry has finished evaluating. None are read at module
// evaluation time.
import { cmd_exec, cmd_sync, cmd_tunnel, cmd_ssh, get_version } from '../ssh-manager.ts';

// The CLI version lives in the main entry; read lazily so menu.ts never
// touches the `const VERSION` binding during its own evaluation.
function version(): string {
  return get_version();
}

// ── Main menu ─────────────────────────────────────────────────────────────────
export function show_main_menu(): void {
  clear_screen();
  print_header(`SSH4Agent CLI v${version()}`);
  process.stdout.write('\n');
  process.stdout.write(`  ${CYAN}1)${NC} ${SERVER} Server Management\n`);
  process.stdout.write('     Add, list, test, and manage SSH servers\n\n');
  process.stdout.write(`  ${CYAN}2)${NC} ${SESSION} Quick Connect\n`);
  process.stdout.write('     Connect to a server via SSH\n\n');
  process.stdout.write(`  ${CYAN}3)${NC} ${SYNC} File Synchronization\n`);
  process.stdout.write('     Push/pull files with rsync\n\n');
  process.stdout.write(`  ${CYAN}4)${NC} ${TUNNEL} SSH Tunnels\n`);
  process.stdout.write('     Create and manage SSH tunnels\n\n');
  process.stdout.write(`  ${CYAN}5)${NC} ${MONITOR} System Monitoring\n`);
  process.stdout.write('     Monitor server resources\n\n');
  process.stdout.write(`  ${CYAN}6)${NC} ${ROCKET} Execute Commands\n`);
  process.stdout.write('     Run commands on servers\n\n');
  process.stdout.write(`  ${CYAN}7)${NC} ${GEAR} Configuration\n`);
  process.stdout.write('     Edit settings and preferences\n\n');
  process.stdout.write(`  ${CYAN}8)${NC} ${INFO} Help & Documentation\n`);
  process.stdout.write('     View help and examples\n\n');
  process.stdout.write(`  ${CYAN}0)${NC} Exit\n\n`);
  process.stdout.write(`${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n`);
  process.stdout.write('Choose an option [0-8]: ');
}

// ── Server management submenu ─────────────────────────────────────────────────
export function show_server_menu(): void {
  clear_screen();
  print_header('Server Management');
  process.stdout.write('\n');
  process.stdout.write(`  ${CYAN}1)${NC} ${CHECK} Add New Server\n`);
  process.stdout.write('     Configure a new SSH server\n\n');
  process.stdout.write(`  ${CYAN}2)${NC} ${CLIPBOARD} List All Servers\n`);
  process.stdout.write('     Show configured servers\n\n');
  process.stdout.write(`  ${CYAN}3)${NC} ${WRENCH} Test Connection\n`);
  process.stdout.write('     Test server connectivity\n\n');
  process.stdout.write(`  ${CYAN}4)${NC} ${INFO}  Show Server Details\n`);
  process.stdout.write('     Display server configuration\n\n');
  process.stdout.write(`  ${CYAN}5)${NC} ${PENCIL}  Edit Server\n`);
  process.stdout.write('     Modify server settings\n\n');
  process.stdout.write(`  ${CYAN}6)${NC} ${CROSS} Remove Server\n`);
  process.stdout.write('     Delete server configuration\n\n');
  process.stdout.write(`  ${CYAN}7)${NC} ${NOTE} Edit Config File\n`);
  process.stdout.write('     Directly edit .env file\n\n');
  process.stdout.write(`  ${CYAN}0)${NC} ← Back to Main Menu\n\n`);
  process.stdout.write(`${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n`);
  process.stdout.write('Choose an option [0-7]: ');
}

// ── Server selection menu ─────────────────────────────────────────────────────
// Returns the chosen server name, or null if cancelled / no servers.
export async function select_server_menu(
  promptText: string = 'Select a server'
): Promise<string | null> {
  const servers = load_servers();
  if (servers.length === 0) {
    print_warning('No servers configured');
    print_info("Use 'Add New Server' to configure one");
    await pause();
    return null;
  }

  clear_screen();
  print_header(promptText);
  process.stdout.write('\n');

  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    const host = get_server_config(s, 'HOST') ?? '';
    const user = get_server_config(s, 'USER') ?? '';
    const desc = get_server_config(s, 'DESCRIPTION') ?? '';
    process.stdout.write(`  ${CYAN}${i + 1})${NC} ${SERVER}${s}\n`);
    process.stdout.write(`     ${user}@${host}\n`);
    if (desc) process.stdout.write(`     ${GRAY}${desc}${NC}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write(`  ${CYAN}0)${NC} Cancel\n\n`);
  process.stdout.write(`${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n`);
  process.stdout.write(`Choose server [0-${servers.length}]: `);

  const choice = await question('');
  const n = Number(choice);
  if (/^[0-9]+$/.test(choice.trim()) && n >= 1 && n <= servers.length) {
    return servers[n - 1];
  }
  return null;
}

// ── Add-server wizard ──────────────────────────────────────────────────────────
export async function wizard_add_server(): Promise<void> {
  clear_screen();
  print_header('Add New SSH Server - Setup Wizard');
  process.stdout.write('\n');
  print_info('This wizard will guide you through adding a new SSH server.');
  print_info('Press Ctrl+C at any time to cancel.');
  process.stdout.write('\n');

  // Step 1: Server name
  print_subheader('Step 1: Server Identification');
  process.stdout.write('Choose a short, memorable name for this server.\n');
  process.stdout.write('Letters, digits and underscore only — no hyphens (POSIX env var rule).\n');
  process.stdout.write('Examples: prod1, web_server, database, staging\n\n');

  let serverName = '';
  while (true) {
    serverName = await prompt_input('Server name', '');
    if (validate_server_name(serverName)) {
      if (get_server_config(serverName, 'HOST') !== null) {
        print_error(`Server '${serverName}' already exists!`);
        if (await prompt_yes_no('Choose a different name?', 'y')) {
          continue;
        }
        return;
      }
      break;
    }
  }

  // Step 2: Connection details
  process.stdout.write('\n');
  print_subheader('Step 2: Connection Details');
  process.stdout.write("Enter the server's hostname or IP address.\n");
  process.stdout.write('Examples: 192.168.1.100, example.com, server.local\n');
  const host = await prompt_input('Host/IP', '');

  process.stdout.write('\n');
  process.stdout.write('Enter the username for SSH connection.\n');
  process.stdout.write('Common choices: root, ubuntu, admin, deploy\n');
  const user = await prompt_input('Username', process.env.USER || process.env.USERNAME || '');

  process.stdout.write('\n');
  process.stdout.write('Enter the SSH port (standard is 22).\n');
  const port = await prompt_input('SSH Port', '22');

  // Step 3: Authentication
  process.stdout.write('\n');
  print_subheader('Step 3: Authentication Method');
  process.stdout.write('How do you want to authenticate?\n\n');
  process.stdout.write(`  ${CYAN}1)${NC} ${KEY} SSH Key (Recommended)\n`);
  process.stdout.write('     More secure, no password needed\n\n');
  process.stdout.write(`  ${CYAN}2)${NC} ${LOCK} Password\n`);
  process.stdout.write('     Less secure, password required each time\n\n');

  const authChoice = await prompt_input('Choose [1-2]', '');

  let authType: string;
  let authValue: string;
  if (authChoice === '2') {
    authType = 'password';
    process.stdout.write('\n');
    print_warning('Password authentication is less secure than SSH keys.');
    authValue = await prompt_password('Enter password');
  } else {
    authType = 'key';
    process.stdout.write('\n');
    process.stdout.write('Enter the path to your SSH private key.\n');
    process.stdout.write('Common locations:\n');
    process.stdout.write('  • ~/.ssh/id_rsa (default RSA key)\n');
    process.stdout.write('  • ~/.ssh/id_ed25519 (modern ED25519 key)\n');
    process.stdout.write('  • ~/.ssh/custom_key (custom key)\n');
    authValue = await prompt_input('SSH key path', `${expandHome('~')}/.ssh/id_rsa`);
    authValue = expandHome(authValue);

    if (!fs.existsSync(authValue)) {
      print_warning(`Key file not found: ${authValue}`);
      if (!(await prompt_yes_no('Continue anyway?', 'n'))) {
        return;
      }
    }
  }

  // Step 4: Optional settings
  process.stdout.write('\n');
  print_subheader('Step 4: Optional Settings');
  process.stdout.write('Add a description to help identify this server (optional).\n');
  process.stdout.write('Example: Production web server, Database backup, Test environment\n');
  const description = await prompt_input('Description', '');

  process.stdout.write('\n');
  process.stdout.write('Set a default directory for this server (optional).\n');
  process.stdout.write('Example: /var/www/html, /home/user/app, /opt/services\n');
  const defaultDir = await prompt_input('Default directory', '');

  process.stdout.write('\n');
  process.stdout.write('Assign this server to a group (optional).\n');
  process.stdout.write(
    'Servers sharing a group can be targeted together with ssh_execute_group.\n'
  );
  process.stdout.write('Example: production, staging, customer-acme\n');
  const group = await prompt_input('Group', '');

  let forwardAgent = 'n';
  process.stdout.write('\n');
  process.stdout.write('Forward your local ssh-agent to this server (optional).\n');
  process.stdout.write('Lets remote processes use your local keys — e.g. git over SSH.\n');
  print_warning('Security: anyone with root on this host can use your loaded keys');
  print_warning('for the life of the connection. Only enable for servers you trust.');
  if (await prompt_yes_no('Enable SSH agent forwarding?', 'n')) {
    forwardAgent = 'y';
  }

  // Step 5: Review
  process.stdout.write('\n');
  print_subheader('Step 5: Review Configuration');
  process.stdout.write('\n');
  print_table_row('Name:', serverName);
  print_table_row('Host:', host);
  print_table_row('User:', user);
  print_table_row('Port:', port);
  print_table_row('Auth:', authType);
  if (authType === 'key') {
    print_table_row('Key:', authValue);
  } else {
    print_table_row('Password:', '********');
  }
  if (description) print_table_row('Description:', description);
  if (defaultDir) print_table_row('Default Dir:', defaultDir);
  if (group) print_table_row('Group:', group);
  if (forwardAgent === 'y') print_table_row('Agent Forwarding:', 'enabled');

  process.stdout.write('\n');
  if (await prompt_yes_no('Save this configuration?', 'y')) {
    add_server_to_env(serverName, host, user, authType, authValue, port, description);

    const nameUpper = serverName.toUpperCase();
    const extra: string[] = [];
    if (defaultDir) {
      extra.push(`SSH_SERVER_${nameUpper}_DEFAULT_DIR=${defaultDir}`);
    }
    if (group) {
      extra.push(`SSH_SERVER_${nameUpper}_GROUP="${group}"`);
    }
    if (forwardAgent === 'y') {
      extra.push(`SSH_SERVER_${nameUpper}_FORWARD_AGENT=true`);
    }
    if (extra.length) {
      fs.appendFileSync(SSH4AGENT_ENV, extra.join('\n') + '\n', 'utf8');
    }

    process.stdout.write('\n');
    print_success(`Server '${serverName}' added successfully!`);

    process.stdout.write('\n');
    if (await prompt_yes_no('Test connection now?', 'y')) {
      process.stdout.write('\n');
      test_ssh_connection(serverName);
    }

    process.stdout.write('\n');
    print_info(`Quick commands for '${serverName}':`);
    process.stdout.write(`  • Connect: ssh4agent ssh ${serverName}\n`);
    process.stdout.write(`  • Test:    ssh4agent server test ${serverName}\n`);
    process.stdout.write(`  • Execute: ssh4agent exec ${serverName} "command"\n`);

    process.stdout.write('\n');
    await pause();
  } else {
    print_info('Configuration cancelled');
  }
}

// ── Edit-server wizard ──────────────────────────────────────────────────────────
// Matches bash wizard_edit_server: always prompts via select_server_menu
// (the cmd_server_edit path verifies existence but the wizard still shows the
// selection menu — preserved for behavior parity).
export async function wizard_edit_server(): Promise<void> {
  const selected = await select_server_menu('Select Server to Edit');
  if (selected === null) return;
  const serverName = selected;

  const currentHost = get_server_config(serverName, 'HOST') ?? '';
  const currentUser = get_server_config(serverName, 'USER') ?? '';
  let currentPort = get_server_config(serverName, 'PORT') ?? '';
  const currentKeypath = get_server_config(serverName, 'KEYPATH') ?? '';
  const currentPassword = get_server_config(serverName, 'PASSWORD') ?? '';
  const currentDescription = get_server_config(serverName, 'DESCRIPTION') ?? '';
  const currentDefaultDir = get_server_config(serverName, 'DEFAULT_DIR') ?? '';
  currentPort = currentPort || '22';

  let currentAuthType = 'key';
  if (currentPassword) currentAuthType = 'password';

  clear_screen();
  print_header(`Edit Server - ${serverName}`);
  print_info('Press Enter to keep current value, or type new value');
  process.stdout.write('\n');

  print_subheader('Step 1: Connection Details');
  process.stdout.write('----------------------------------------\n');
  const host = await prompt_input('Host/IP', currentHost);
  const user = await prompt_input('Username', currentUser);
  const port = await prompt_input('Port', currentPort);

  process.stdout.write('\n');
  print_subheader('Step 2: Authentication Method');
  process.stdout.write('----------------------------------------\n');
  process.stdout.write(`Current method: ${currentAuthType}\n\n`);
  process.stdout.write('  1) 🔑 SSH Key (Recommended)\n');
  process.stdout.write('     More secure, no password needed\n\n');
  process.stdout.write('  2) 🔒 Password\n');
  process.stdout.write('     Less secure, password required each time\n\n');
  const authChoice = await prompt_input('Choose [1-2] or Enter to keep current', '');

  let authType: string;
  let authValue: string;
  if (authChoice === '') {
    authType = currentAuthType;
    authValue = authType === 'password' ? currentPassword : currentKeypath;
  } else if (authChoice === '2') {
    authType = 'password';
    authValue = await prompt_password('Password');
  } else {
    authType = 'key';
    authValue = await prompt_input(
      'SSH key path',
      currentKeypath || `${expandHome('~')}/.ssh/id_rsa`
    );
    authValue = expandHome(authValue);
  }

  process.stdout.write('\n');
  print_subheader('Step 3: Optional Settings');
  process.stdout.write('----------------------------------------\n');
  const description = await prompt_input('Description (optional)', currentDescription);
  const defaultDir = await prompt_input('Default directory (optional)', currentDefaultDir);

  process.stdout.write('\n');
  print_subheader('Configuration Summary');
  print_table_row('Name:', serverName);
  print_table_row('Host:', host);
  print_table_row('User:', user);
  print_table_row('Port:', port);
  print_table_row('Auth:', authType);
  if (authType === 'key') print_table_row('Key:', authValue);
  if (description) print_table_row('Description:', description);
  if (defaultDir) print_table_row('Default Dir:', defaultDir);

  process.stdout.write('\n');
  if (await prompt_yes_no('Save changes?', 'y')) {
    update_server_in_env(
      serverName,
      host,
      user,
      authType,
      authValue,
      port,
      description,
      defaultDir
    );
    process.stdout.write('\n');
    if (await prompt_yes_no('Test connection now?', 'y')) {
      test_ssh_connection(serverName);
    }
  } else {
    print_info('Changes cancelled');
  }
}

// ── File sync menu ─────────────────────────────────────────────────────────────
export async function show_sync_menu(): Promise<void> {
  clear_screen();
  print_header('File Synchronization');

  const server = await select_server_menu('Select server for file sync');
  if (server === null) return;

  process.stdout.write('\n');
  print_subheader('Sync Direction');
  process.stdout.write(`  ${CYAN}1)${NC} ${ARROW} Push (Local → Remote)\n`);
  process.stdout.write(`     Upload files to ${server}\n\n`);
  process.stdout.write(`  ${CYAN}2)${NC} ${ARROW} Pull (Remote → Local)\n`);
  process.stdout.write(`     Download files from ${server}\n\n`);
  process.stdout.write(`  ${CYAN}0)${NC} Cancel\n\n`);
  const direction = await prompt_input('Choose direction [0-2]', '');

  if (direction === '1') {
    process.stdout.write('\n');
    const source = await prompt_input('Local source path', '.');
    const dest = await prompt_input('Remote destination path', '/tmp/');
    process.stdout.write('\n');
    if (await prompt_yes_no('Dry run first?', 'y')) {
      cmd_sync('push', server, source, dest, '--dry-run');
      process.stdout.write('\n');
      if (await prompt_yes_no('Proceed with actual sync?', 'y')) {
        cmd_sync('push', server, source, dest);
      }
    } else {
      cmd_sync('push', server, source, dest);
    }
  } else if (direction === '2') {
    process.stdout.write('\n');
    const source = await prompt_input('Remote source path', '/tmp/');
    const dest = await prompt_input('Local destination path', '.');
    process.stdout.write('\n');
    if (await prompt_yes_no('Dry run first?', 'y')) {
      cmd_sync('pull', server, source, dest, '--dry-run');
      process.stdout.write('\n');
      if (await prompt_yes_no('Proceed with actual sync?', 'y')) {
        cmd_sync('pull', server, source, dest);
      }
    } else {
      cmd_sync('pull', server, source, dest);
    }
  }

  process.stdout.write('\n');
  await pause();
}

// ── Tunnel creation wizard ──────────────────────────────────────────────────────
export async function wizard_create_tunnel(): Promise<void> {
  clear_screen();
  print_header('SSH Tunnel Creation Wizard');

  const server = await select_server_menu('Select server for tunnel');
  if (server === null) return;

  process.stdout.write('\n');
  print_subheader('Tunnel Type');
  process.stdout.write(`  ${CYAN}1)${NC} Local Port Forwarding\n`);
  process.stdout.write('     Access remote service through local port\n');
  process.stdout.write('     Example: Access remote MySQL on local port 3307\n\n');
  process.stdout.write(`  ${CYAN}2)${NC} Remote Port Forwarding\n`);
  process.stdout.write('     Expose local service to remote server\n');
  process.stdout.write('     Example: Let remote access your local web server\n\n');
  process.stdout.write(`  ${CYAN}3)${NC} Dynamic (SOCKS Proxy)\n`);
  process.stdout.write('     Create SOCKS5 proxy for secure browsing\n');
  process.stdout.write('     Example: Route browser through SSH server\n\n');
  process.stdout.write(`  ${CYAN}0)${NC} Cancel\n\n`);
  const tunnelType = await prompt_input('Choose type [0-3]', '');

  if (tunnelType === '1') {
    process.stdout.write('\n');
    print_info('Local Port Forwarding Setup');
    process.stdout.write('Access a remote service as if it were local\n\n');
    const localPort = await prompt_input('Local port to listen on', '8080');
    const remoteHost = await prompt_input('Remote host (usually localhost)', 'localhost');
    const remotePort = await prompt_input('Remote port to forward to', '80');
    process.stdout.write('\n');
    print_info(`Creating tunnel: localhost:${localPort} → ${server} → ${remoteHost}:${remotePort}`);
    cmd_tunnel('create', server, 'local', `${localPort}:${remoteHost}:${remotePort}`);
    process.stdout.write('\n');
    print_success(`Tunnel created! Access the service at: http://localhost:${localPort}`);
  } else if (tunnelType === '2') {
    process.stdout.write('\n');
    print_info('Remote Port Forwarding Setup');
    process.stdout.write('Expose your local service to the remote server\n\n');
    const remotePort = await prompt_input('Remote port to listen on', '8080');
    const localHost = await prompt_input('Local host (usually localhost)', 'localhost');
    const localPort = await prompt_input('Local port to forward', '3000');
    process.stdout.write('\n');
    print_info(`Creating tunnel: ${server}:${remotePort} → local → ${localHost}:${localPort}`);
    cmd_tunnel('create', server, 'remote', `${remotePort}:${localHost}:${localPort}`);
    process.stdout.write('\n');
    print_success(`Tunnel created! Remote can access at: ${server}:${remotePort}`);
  } else if (tunnelType === '3') {
    process.stdout.write('\n');
    print_info('SOCKS Proxy Setup');
    process.stdout.write('Route all traffic through SSH server\n\n');
    const socksPort = await prompt_input('Local SOCKS port', '1080');
    process.stdout.write('\n');
    print_info(`Creating SOCKS5 proxy on port ${socksPort}`);
    cmd_tunnel('create', server, 'dynamic', socksPort);
    process.stdout.write('\n');
    print_success('SOCKS proxy created!');
    print_info('Configure your browser/app to use:');
    process.stdout.write('  • SOCKS Host: localhost\n');
    process.stdout.write(`  • SOCKS Port: ${socksPort}\n`);
    process.stdout.write('  • SOCKS Type: SOCKS5\n');
  }

  process.stdout.write('\n');
  await pause();
}
