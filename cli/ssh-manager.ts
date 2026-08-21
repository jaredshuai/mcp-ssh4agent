#!/usr/bin/env node
// SSH Manager CLI — main entry.
//
// Cross-platform TypeScript port of cli/ssh-manager (the bash entry).
// Implements: VERSION resolution, show_help/show_version, the cmd_exec /
// cmd_sync / cmd_ssh / cmd_tunnel primitives, the main() dispatcher, and the
// interactive_mode loop. Run natively: `node cli/ssh-manager.ts` (Node
// >=23.6 type stripping).
//
// No shell-isms. `ssh` and `rsync` are the only external binaries spawned
// (both are expected on PATH, matching the bash original). `clear`/`ps`/`sed`/
// `mktemp` are all replaced with node: built-ins.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BOLD, CYAN, GRAY, NC,
  print_header, print_subheader, print_info, print_warning, print_error,
  print_success,
  clear_screen, pause, question, cleanupPrompts,
  prompt_input,
  MONITOR, SESSION, SYNC, TUNNEL, ROCKET, GEAR, INFO, SERVER,
} from './lib/colors.ts';

import {
  PROJECT_ROOT, SSH_MANAGER_CONFIG, SSH_MANAGER_ENV, SSH_MANAGER_HOME,
  init_config, check_dependencies, get_server_config, get_config,
} from './lib/config.ts';

import {
  show_main_menu, show_server_menu, wizard_add_server, wizard_edit_server,
  select_server_menu, show_sync_menu, wizard_create_tunnel,
} from './lib/menu.ts';

import { cmd_server, cmd_server_list, cmd_server_show, cmd_server_edit_file } from './commands/server.ts';
import { cmd_tools } from './commands/tools.ts';

// ── VERSION (derived from package.json, never hardcoded) ─────────────────────
// Matches get_cli_version() in the bash entry: read cli/../package.json first
// (SCRIPT_DIR/../package.json = repo/install root), then cli/package.json
// (SCRIPT_DIR/package.json) for installed copies that bundle package.json
// alongside the script.
function read_version(): string {
  const candidates = [
    path.join(PROJECT_ROOT, 'package.json'),            // cli/../package.json
    path.join(PROJECT_ROOT, 'cli', 'package.json'),     // cli/package.json
  ];
  for (const pkg of candidates) {
    if (fs.existsSync(pkg)) {
      try {
        const data = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (data.version) return String(data.version);
      } catch { /* try next candidate */ }
    }
  }
  return 'unknown';
}

export const VERSION: string = read_version();

// Accessor used by lib/menu.ts (circular import). Function declarations are
// hoisted, so menu.ts can safely import this even during circular evaluation.
export function get_version(): string {
  return VERSION;
}

// ── show_version ───────────────────────────────────────────────────────────────
export function show_version(): void {
  process.stdout.write(`SSH Manager CLI v${VERSION}\n`);
  process.stdout.write('Simple and powerful SSH server management\n');
}

// ── show_help ──────────────────────────────────────────────────────────────────
export function show_help(): void {
  const homeDisplay = process.env.SSH_MANAGER_HOME || '~/.ssh-manager';
  const envDisplay = SSH_MANAGER_ENV || '.env';
  const out: string[] = [];
  out.push(`${BOLD}SSH Manager CLI${NC} - Simple and powerful SSH server management`);
  out.push('');
  out.push(`${BOLD}USAGE:${NC}`);
  out.push('    ssh-manager              # Interactive mode (menu)');
  out.push('    ssh-manager -i           # Interactive mode (menu)');
  out.push('    ssh-manager <command>    # Direct command mode');
  out.push('');
  out.push(`${BOLD}COMMANDS:${NC}`);
  out.push(`    ${CYAN}server${NC}      Server management`);
  out.push('        add         Add a new server');
  out.push('        list        List all servers');
  out.push('        test        Test server connection');
  out.push('        remove      Remove a server');
  out.push('        edit        Edit server configuration');
  out.push('        show        Show server details');
  out.push('    ');
  out.push(`    ${CYAN}sync${NC}        File synchronization (rsync)`);
  out.push('        push        Push files to server');
  out.push('        pull        Pull files from server');
  out.push('    ');
  out.push(`    ${CYAN}tunnel${NC}      SSH tunnel management`);
  out.push('        create      Create a new tunnel');
  out.push('        list        List active tunnels');
  out.push('        close       Close a tunnel');
  out.push('    ');
  out.push(`    ${CYAN}monitor${NC}     System monitoring`);
  out.push('        cpu         Monitor CPU usage');
  out.push('        memory      Monitor memory usage');
  out.push('        disk        Monitor disk usage');
  out.push('        network     Monitor network');
  out.push('    ');
  out.push(`    ${CYAN}session${NC}     SSH session management`);
  out.push('        start       Start interactive session');
  out.push('        list        List active sessions');
  out.push('        close       Close a session');
  out.push('    ');
  out.push(`    ${CYAN}exec${NC}        Execute commands`);
  out.push('        run         Run command on server');
  out.push('        group       Run on server group');
  out.push('    ');
  out.push(`    ${CYAN}config${NC}      Configuration`);
  out.push('        edit        Edit configuration');
  out.push('        show        Show configuration');
  out.push('        init        Initialize configuration');
  out.push('');
  out.push(`    ${CYAN}tools${NC}       Tool activation/deactivation`);
  out.push('        list        Show all tools and their status');
  out.push('        configure   Interactive configuration wizard');
  out.push('        enable      Enable a tool group');
  out.push('        disable     Disable a tool group');
  out.push('        reset       Reset to default (all tools enabled)');
  out.push('        export      Export Claude Code auto-approval config');
  out.push('');
  out.push(`${BOLD}OPTIONS:${NC}`);
  out.push('    -h, --help      Show this help message');
  out.push('    -v, --version   Show version');
  out.push('    -q, --quiet     Quiet mode');
  out.push('    -d, --debug     Debug mode');
  out.push('');
  out.push(`${BOLD}EXAMPLES:${NC}`);
  out.push('    # Add a new server');
  out.push('    ssh-manager server add');
  out.push('    ');
  out.push('    # List all servers');
  out.push('    ssh-manager server list');
  out.push('    ');
  out.push('    # Test connection to prod1');
  out.push('    ssh-manager server test prod1');
  out.push('    ');
  out.push('    # Sync files to server');
  out.push('    ssh-manager sync push prod1 ./app /var/www/app');
  out.push('    ');
  out.push('    # Create SSH tunnel');
  out.push('    ssh-manager tunnel create prod1 local 3307:localhost:3306');
  out.push('    ');
  out.push('    # Monitor server');
  out.push('    ssh-manager monitor prod1 cpu');
  out.push('');
  out.push(`${BOLD}CONFIGURATION:${NC}`);
  out.push(`    Config directory: ${homeDisplay}`);
  out.push(`    Server config:    ${envDisplay}`);
  out.push('');
  out.push(`${BOLD}DOCUMENTATION:${NC}`);
  out.push('    https://github.com/bvisible/mcp-ssh-manager');
  out.push('');
  process.stdout.write(out.join('\n'));
}

// ── cmd_exec: run a command on a server via ssh ────────────────────────────────
export function cmd_exec(server: string, ...commandParts: string[]): void {
  const command = commandParts.join(' ');
  if (!server || !command) {
    print_error('Usage: ssh-manager exec <server> <command>');
    process.exitCode = 1;
    return;
  }
  const host = get_server_config(server, 'HOST');
  const user = get_server_config(server, 'USER');
  let port = get_server_config(server, 'PORT');
  const keypath = get_server_config(server, 'KEYPATH');
  port = port || '22';

  if (!host || !user) {
    print_error(`Server '${server}' not found`);
    process.exitCode = 1;
    return;
  }

  const sshArgs: string[] = ['-p', port];
  if (keypath) sshArgs.push('-i', keypath);

  print_info(`Executing on ${server}: ${command}`);
  const result = spawnSync('ssh', [...sshArgs, `${user}@${host}`, command], { stdio: 'inherit' });
  if (result.status !== 0 && result.error) {
    print_error(`Failed to execute: ${result.error.message}`);
    process.exitCode = 1;
  }
}

// ── cmd_sync: rsync push/pull (rsync is checked lazily here) ───────────────────
// Note: matches bash cmd_sync exactly — only direction/server/source/dest are
// used; any extra args (e.g. the `--dry-run` the menu passes) are dropped.
export function cmd_sync(direction: string, server: string, source: string, dest: string, _extra?: string): void {
  if (!direction || !server || !source || !dest) {
    print_error('Usage: ssh-manager sync <push|pull> <server> <source> <destination>');
    process.exitCode = 1;
    return;
  }

  if (!requireCommand('rsync', 'ssh-manager sync')) {
    process.exitCode = 1;
    return;
  }

  const host = get_server_config(server, 'HOST');
  const user = get_server_config(server, 'USER');
  let port = get_server_config(server, 'PORT');
  const keypath = get_server_config(server, 'KEYPATH');
  port = port || '22';

  if (!host || !user) {
    print_error(`Server '${server}' not found`);
    process.exitCode = 1;
    return;
  }

  let sshOpts = `ssh -p ${port}`;
  if (keypath) sshOpts += ` -i ${keypath}`;

  const rsyncArgs = ['-avz', '--progress', '-e', sshOpts];

  if (direction === 'push') {
    print_info(`Pushing ${source} to ${server}:${dest}`);
    const r = spawnSync('rsync', [...rsyncArgs, source, `${user}@${host}:${dest}`], { stdio: 'inherit' });
    if (r.status !== 0) process.exitCode = 1;
  } else if (direction === 'pull') {
    print_info(`Pulling ${server}:${source} to ${dest}`);
    const r = spawnSync('rsync', [...rsyncArgs, `${user}@${host}:${source}`, dest], { stdio: 'inherit' });
    if (r.status !== 0) process.exitCode = 1;
  } else {
    print_error(`Invalid direction: ${direction} (use push or pull)`);
    process.exitCode = 1;
  }
}

// ── cmd_ssh: quick interactive SSH connection ─────────────────────────────────
export function cmd_ssh(server: string): void {
  if (!server) {
    print_error('Usage: ssh-manager ssh <server>');
    process.exitCode = 1;
    return;
  }
  const host = get_server_config(server, 'HOST');
  const user = get_server_config(server, 'USER');
  let port = get_server_config(server, 'PORT');
  const keypath = get_server_config(server, 'KEYPATH');
  port = port || '22';

  if (!host || !user) {
    print_error(`Server '${server}' not found`);
    process.exitCode = 1;
    return;
  }

  const sshArgs: string[] = ['-p', port];
  if (keypath) sshArgs.push('-i', keypath);

  print_info(`Connecting to ${server}...`);
  const r = spawnSync('ssh', [...sshArgs, `${user}@${host}`], { stdio: 'inherit' });
  if (r.status !== 0) process.exitCode = 1;
}

// ── cmd_tunnel: create / list SSH tunnels ──────────────────────────────────────
export function cmd_tunnel(action: string, ...rest: string[]): void {
  if (action === 'create') {
    const server = rest[0];
    const type = rest[1];
    const ports = rest[2];

    if (!server || !type || !ports) {
      print_error('Usage: ssh-manager tunnel create <server> <local|remote|dynamic> <ports>');
      print_info('Examples:');
      print_info('  Local:   ssh-manager tunnel create prod1 local 3307:localhost:3306');
      print_info('  Remote:  ssh-manager tunnel create prod1 remote 8080:localhost:8080');
      print_info('  Dynamic: ssh-manager tunnel create prod1 dynamic 1080');
      process.exitCode = 1;
      return;
    }

    const host = get_server_config(server, 'HOST');
    const user = get_server_config(server, 'USER');
    let port = get_server_config(server, 'PORT');
    const keypath = get_server_config(server, 'KEYPATH');
    port = port || '22';

    if (!host || !user) {
      print_error(`Server '${server}' not found`);
      process.exitCode = 1;
      return;
    }

    const sshArgs: string[] = ['-p', port, '-N', '-f'];
    if (keypath) sshArgs.push('-i', keypath);

    let ok = false;
    if (type === 'local') {
      print_info(`Creating local tunnel: ${ports}`);
      const r = spawnSync('ssh', [...sshArgs, '-L', ports, `${user}@${host}`], { stdio: 'inherit' });
      ok = r.status === 0;
    } else if (type === 'remote') {
      print_info(`Creating remote tunnel: ${ports}`);
      const r = spawnSync('ssh', [...sshArgs, '-R', ports, `${user}@${host}`], { stdio: 'inherit' });
      ok = r.status === 0;
    } else if (type === 'dynamic') {
      print_info(`Creating SOCKS proxy on port ${ports}`);
      const r = spawnSync('ssh', [...sshArgs, '-D', ports, `${user}@${host}`], { stdio: 'inherit' });
      ok = r.status === 0;
    } else {
      print_error(`Invalid tunnel type: ${type}`);
      process.exitCode = 1;
      return;
    }

    if (ok) {
      print_success('Tunnel created successfully');
    } else {
      print_error('Failed to create tunnel');
      process.exitCode = 1;
    }
    return;
  }

  if (action === 'list') {
    print_header('Active SSH Tunnels');
    const lines = listTunnelProcesses();
    if (lines.length > 0) {
      process.stdout.write(lines.join('\n') + '\n');
    } else {
      print_info('No active tunnels');
    }
    return;
  }

  print_error(`Unknown tunnel command: ${action}`);
  process.stdout.write('Available commands: create, list\n');
  process.exitCode = 1;
}

// Cross-platform tunnel listing (replaces `ps aux | grep ssh`).
// - win32: `tasklist /FI "IMAGENAME eq ssh.exe"` (tasklist cannot see cmdline,
//   so all ssh.exe processes are listed — same limitation as the bash fallback).
// - other: `ps -A -o pid,command`, filtered to lines mentioning ssh with -L/-R/-D.
function listTunnelProcesses(): string[] {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ssh.exe'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
      const out = r.stdout ? r.stdout.toString() : '';
      // tasklist always prints an INFO/empty header when no matches; only
      // return lines that actually reference ssh.exe.
      const lines = out.split(/\r?\n/).filter((l) => /ssh\.exe/i.test(l));
      // When there are matches, preserve the full tasklist table (header + rows)
      // so the user sees column labels — matching the bash spirit of "show ssh".
      if (lines.length > 0) {
        const header = out.split(/\r?\n/).slice(0, 3).join('\n');
        return [header, ...lines];
      }
      return [];
    } catch {
      return [];
    }
  }
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid,command'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = r.stdout ? r.stdout.toString() : '';
    return out
      .split(/\r?\n/)
      .filter((l) => /ssh/.test(l) && /(-L|-R|-D)/.test(l) && !/grep/.test(l));
  } catch {
    return [];
  }
}

// ── requireCommand: lazy feature-specific dependency check ────────────────────
function requireCommand(cmd: string, feature: string): boolean {
  // Defer to config.check_dependencies' helper by re-implementing the PATH walk
  // here (cheap, avoids an extra import cycle through config.ts at call time).
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter);
  const isWin = process.platform === 'win32';
  const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
  let found = false;
  if (isWin) {
    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
    outer: for (const d of dirs) {
      if (!d) continue;
      for (const ext of exts) {
        if (exists(path.join(d, cmd + ext))) { found = true; break outer; }
      }
    }
  } else {
    for (const d of dirs) {
      if (d && exists(path.join(d, cmd))) { found = true; break; }
    }
  }
  if (!found) {
    print_error(`'${cmd}' is required for ${feature} but was not found on PATH`);
    if (cmd === 'rsync') {
      print_info('Install rsync:');
      print_info('  • macOS:   brew install rsync');
      print_info('  • Debian:  sudo apt-get install rsync');
      print_info('  • Windows: install via MSYS2/Cygwin, or use WSL');
    }
    return false;
  }
  return true;
}

// ── interactive_mode ───────────────────────────────────────────────────────────
export async function interactive_mode(): Promise<void> {
  init_config();
  if (!check_dependencies()) process.exit(1);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    show_main_menu();
    const choice = await question('');

    if (choice === '1') {
      // Server Management submenu
      // eslint-disable-next-line no-constant-condition
      while (true) {
        show_server_menu();
        const sc = await question('');

        if (sc === '1') {
          await wizard_add_server();
        } else if (sc === '2') {
          cmd_server_list();
          process.stdout.write('\n');
          await pause();
        } else if (sc === '3') {
          const sel = await select_server_menu('Test Connection');
          if (sel !== null) {
            test_ssh_connection_proxy(sel);
            process.stdout.write('\n');
            await pause();
          }
        } else if (sc === '4') {
          const sel = await select_server_menu('Show Server Details');
          if (sel !== null) {
            cmd_server_show(sel);
            process.stdout.write('\n');
            await pause();
          }
        } else if (sc === '5') {
          await wizard_edit_server();
          process.stdout.write('\n');
          await pause();
        } else if (sc === '6') {
          const sel = await select_server_menu('Remove Server');
          if (sel !== null) {
            process.stdout.write('\n');
            // Defer to config.remove_server_from_env via server command to keep
            // the confirm + remove flow in one place.
            const { remove_server_from_env } = await import('./lib/config.ts');
            if (await confirmYesNo(`Remove server '${sel}'?`, 'n')) {
              remove_server_from_env(sel);
            }
            process.stdout.write('\n');
            await pause();
          }
        } else if (sc === '7') {
          cmd_server_edit_file();
          process.stdout.write('\n');
          await pause();
        } else if (sc === '0') {
          break;
        }
      }
    } else if (choice === '2') {
      // Quick Connect
      const sel = await select_server_menu('Quick Connect');
      if (sel !== null) {
        print_info(`Connecting to ${sel}...`);
        cmd_ssh(sel);
      }
    } else if (choice === '3') {
      // File Sync
      await show_sync_menu();
    } else if (choice === '4') {
      // SSH Tunnels
      await wizard_create_tunnel();
    } else if (choice === '5') {
      // System Monitoring
      const sel = await select_server_menu('System Monitoring');
      if (sel !== null) {
        process.stdout.write('\n');
        print_subheader('Monitor Type');
        process.stdout.write('  1) Overview\n');
        process.stdout.write('  2) CPU\n');
        process.stdout.write('  3) Memory\n');
        process.stdout.write('  4) Disk\n');
        process.stdout.write('  5) Network\n');
        process.stdout.write('\n');
        const mt = await question('Choose [1-5]: ');
        if (mt === '1') cmd_exec(sel, 'uptime && free -h && df -h');
        else if (mt === '2') cmd_exec(sel, 'top -bn1 | head -20');
        else if (mt === '3') cmd_exec(sel, 'free -h && ps aux --sort=-%mem | head -10');
        else if (mt === '4') cmd_exec(sel, 'df -h && du -sh /* 2>/dev/null | sort -h | tail -10');
        else if (mt === '5') cmd_exec(sel, 'netstat -tulpn 2>/dev/null | grep LISTEN');
        process.stdout.write('\n');
        await pause();
      }
    } else if (choice === '6') {
      // Execute Commands
      const sel = await select_server_menu('Execute Command');
      if (sel !== null) {
        process.stdout.write('\n');
        const command = await prompt_input('Command to execute', 'uptime');
        process.stdout.write('\n');
        cmd_exec(sel, command);
        process.stdout.write('\n');
        await pause();
      }
    } else if (choice === '7') {
      // Configuration
      clear_screen();
      print_header('Configuration');
      process.stdout.write('  1) Edit CLI config\n');
      process.stdout.write('  2) Show CLI config\n');
      process.stdout.write('  3) Edit server config (.env)\n');
      process.stdout.write('  0) Back\n');
      process.stdout.write('\n');
      const cc = await question('Choose [0-3]: ');
      if (cc === '1') {
        await editFileWithEditor(SSH_MANAGER_CONFIG);
      } else if (cc === '2') {
        if (fs.existsSync(SSH_MANAGER_CONFIG)) {
          process.stdout.write(fs.readFileSync(SSH_MANAGER_CONFIG, 'utf8'));
        }
        await pause();
      } else if (cc === '3') {
        cmd_server_edit_file();
      }
    } else if (choice === '8') {
      // Help — bash pipes through `less`; not available cross-platform, so we
      // print directly.
      show_help();
    } else if (choice === '0' || choice === 'q' || choice === 'Q') {
      print_info('Goodbye!');
      process.exit(0);
    }
  }
}

// Thin async wrapper around test_ssh_connection so the interactive loop can
// `await` it (the underlying config primitive is sync).
async function test_ssh_connection_proxy(server: string): Promise<void> {
  const { test_ssh_connection } = await import('./lib/config.ts');
  test_ssh_connection(server);
}

// prompt_yes_no lives in colors.ts but is async; the loop already awaits, so
// import it lazily to keep the top-level imports tidy.
async function confirmYesNo(prompt: string, def: string): Promise<boolean> {
  const { prompt_yes_no } = await import('./lib/colors.ts');
  return prompt_yes_no(prompt, def);
}

// Spawn `$EDITOR <file>` (or a platform default editor) with inherit stdio.
async function editFileWithEditor(file: string): Promise<void> {
  const configured = get_config('default_editor', '');
  const editor = process.env.EDITOR || configured || (process.platform === 'win32' ? 'notepad' : 'nano');
  const r = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) print_error(`Failed to launch editor: ${r.error.message}`);
}

// ── main dispatcher ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Help/version short-circuit (before init_config / dependency check, matching bash).
  const first = args[0];
  if (first === '-h' || first === '--help' || first === 'help') {
    show_help();
    process.exit(0);
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    show_version();
    process.exit(0);
  }

  init_config();
  if (!check_dependencies()) {
    process.exit(1);
  }

  const command = first;
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'server':
        await cmd_server(rest[0], ...rest.slice(1));
        break;
      case 'exec':
        cmd_exec(rest[0] ?? '', ...rest.slice(1));
        break;
      case 'sync':
        cmd_sync(rest[0] ?? '', rest[1] ?? '', rest[2] ?? '', rest[3] ?? '');
        break;
      case 'ssh':
      case 'connect':
        cmd_ssh(rest[0] ?? '');
        break;
      case 'tunnel':
        cmd_tunnel(rest[0] ?? '', ...rest.slice(1));
        break;
      case 'tools':
        await cmd_tools(rest[0], ...rest.slice(1));
        break;
      case 'config': {
        const sub = rest[0];
        if (sub === 'edit') {
          await editFileWithEditor(SSH_MANAGER_CONFIG);
        } else if (sub === 'show') {
          if (fs.existsSync(SSH_MANAGER_CONFIG)) {
            process.stdout.write(fs.readFileSync(SSH_MANAGER_CONFIG, 'utf8'));
          } else {
            print_error(`Configuration file not found: ${SSH_MANAGER_CONFIG}`);
          }
        } else if (sub === 'init') {
          init_config();
        } else {
          print_error(`Unknown config command: ${sub ?? ''}`);
        }
        break;
      }
      case undefined:
      case '':
      case '-i':
      case '--interactive':
      case 'menu':
        await interactive_mode();
        break;
      default:
        print_error(`Unknown command: ${command}`);
        process.stdout.write("Run 'ssh-manager --help' for usage information\n");
        process.exit(1);
    }
  } finally {
    // Close any lingering readline interface so non-interactive commands exit.
    cleanupPrompts();
  }
}

main().catch((e: Error) => {
  print_error(e.message);
  process.exit(1);
});
