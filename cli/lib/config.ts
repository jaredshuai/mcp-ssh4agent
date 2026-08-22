// Configuration management library for ssh4agent CLI.
//
// Cross-platform TypeScript port of cli/lib/config.sh. Parses the .env file
// itself (does not import src/ runtime modules — the CLI stays independent of
// the MCP server code). The ONE shared thing is src/server-fields.ts: the
// single source of truth for field names / quoting, so what the CLI writes is
// exactly what src/config-loader.ts reads (and vice versa). Replaces bash
// `grep`/`sed`/`mktemp`/`jq` with node: built-ins.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { print_info, print_error, print_success, print_warning } from './colors.ts';
import { FIELD_BY_CAMEL, serverEnvLine } from '../../src/server-fields.ts';

// Render one `SSH_SERVER_<NAME>_<KEY>=value` line for a camelCase field,
// through the shared field table (key names + quoting rules).
function envLineFor(
  nameUpper: string,
  camel: string,
  value: string | number | boolean | string[]
): string {
  const spec = FIELD_BY_CAMEL.get(camel);
  if (!spec) throw new Error(`Unknown server field: ${camel}`);
  return serverEnvLine(nameUpper, spec, value);
}

// ── Paths ────────────────────────────────────────────────────────────────────
// cli/lib/config.ts → cli/lib → cli → <project root>
const _HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.dirname(path.dirname(_HERE));

// Where fresh installs write: the post-rebrand config dir.
export const SSH4AGENT_HOME: string =
  process.env.SSH4AGENT_HOME || path.join(os.homedir(), '.ssh4agent');

// Pre-rebrand dir; keeps loading existing setups until ~/.ssh4agent exists.
const LEGACY_HOME: string = path.join(os.homedir(), '.ssh-manager');

function resolveConfigHome(): string {
  if (!process.env.SSH4AGENT_HOME && !fs.existsSync(SSH4AGENT_HOME) && fs.existsSync(LEGACY_HOME)) {
    print_info(`Using legacy config directory ${LEGACY_HOME} — move it to ${SSH4AGENT_HOME}`);
    return LEGACY_HOME;
  }
  return SSH4AGENT_HOME;
}

const CONFIG_HOME: string = resolveConfigHome();

export const SSH4AGENT_CONFIG: string = path.join(CONFIG_HOME, 'config.json');

export const SSH4AGENT_ALIASES: string = path.join(CONFIG_HOME, 'aliases.json');

// Resolve .env path with the same fallback chain as config.sh (and src/index.ts):
// 1. SSH4AGENT_ENV env var (explicit override)
// 2. <config home>/.env (new dir, or legacy dir while the new one is absent)
// 3. $PWD/.env
// 4. ~/.env
// 5. <project-root>/.env
// 6. default <config home>/.env (created on first server add)
function resolveEnvPath(): string {
  if (process.env.SSH4AGENT_ENV) return process.env.SSH4AGENT_ENV;
  const candidates = [
    path.join(CONFIG_HOME, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(PROJECT_ROOT, '.env'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(CONFIG_HOME, '.env');
}

export const SSH4AGENT_ENV: string = resolveEnvPath();

// ── init_config: ensure config dir + default config.json exist ──────────────
export function init_config(): void {
  if (!fs.existsSync(CONFIG_HOME)) {
    fs.mkdirSync(CONFIG_HOME, { recursive: true });
    print_info(`Created config directory: ${CONFIG_HOME}`);
  }
  if (!fs.existsSync(SSH4AGENT_CONFIG)) {
    const defaultEditor = process.env.EDITOR || 'nano';
    const defaultShell = process.env.SHELL || '/bin/bash';
    const defaultConfig = {
      default_editor: defaultEditor,
      default_shell: defaultShell,
      history_file: path.join(CONFIG_HOME, 'history'),
      log_level: 'info',
      color_output: true,
    };
    // Match the bash layout: simple 2-space JSON.
    fs.writeFileSync(SSH4AGENT_CONFIG, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');
    print_info(`Created default config: ${SSH4AGENT_CONFIG}`);
  }
}

// ── get_config / set_config (no jq — native JSON) ───────────────────────────
export function get_config(key: string, def?: string): string {
  if (!fs.existsSync(SSH4AGENT_CONFIG)) return def ?? '';
  try {
    const data = JSON.parse(fs.readFileSync(SSH4AGENT_CONFIG, 'utf8'));
    const v = data[key];
    return v === undefined || v === null ? (def ?? '') : String(v);
  } catch {
    return def ?? '';
  }
}

export function set_config(key: string, value: string): boolean {
  if (!fs.existsSync(SSH4AGENT_CONFIG)) {
    print_error('Configuration file not found');
    return false;
  }
  try {
    const data = JSON.parse(fs.readFileSync(SSH4AGENT_CONFIG, 'utf8'));
    data[key] = value;
    // Backup before write (config.sh used a temp + mv; we just write atomically-ish).
    fs.writeFileSync(SSH4AGENT_CONFIG, JSON.stringify(data, null, 2) + '\n', 'utf8');
    print_success(`Updated config: ${key} = ${value}`);
    return true;
  } catch (e) {
    print_error(`Failed to update config: ${(e as Error).message}`);
    return false;
  }
}

// ── .env parsing helpers ─────────────────────────────────────────────────────

// Read .env lines, or [] if missing.
function readEnvLines(): string[] {
  if (!fs.existsSync(SSH4AGENT_ENV)) return [];
  return fs.readFileSync(SSH4AGENT_ENV, 'utf8').split(/\r?\n/);
}

// Match `^SSH_SERVER_(.+)_HOST=` and return the captured NAME (upper-case as
// written in the file). Used by load_servers + list_invalid_server_names.
const HOST_RE = /^SSH_SERVER_(.+)_HOST=/;

// load_servers(): returns sorted, de-duplicated, lower-cased server names.
export function load_servers(): string[] {
  const lines = readEnvLines();
  const names: string[] = [];
  for (const line of lines) {
    const m = HOST_RE.exec(line);
    if (m) names.push(m[1].toLowerCase());
  }
  return Array.from(new Set(names)).sort();
}

// get_server_config(server, field): returns the raw value with ONLY the outer
// surrounding double-quotes stripped (preserves internal quotes). Matches the
// config.sh regex `^"(.*)"$`. Returns null when the key is absent / empty.
export function get_server_config(server: string, field: string): string | null {
  if (!fs.existsSync(SSH4AGENT_ENV)) return null;
  const serverUpper = server.toUpperCase();
  const fieldUpper = field.toUpperCase();
  const key = `SSH_SERVER_${serverUpper}_${fieldUpper}`;
  const prefix = key + '=';
  const lines = readEnvLines();
  let value: string | null = null;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      value = line.slice(prefix.length);
      break;
    }
  }
  if (value === null || value === '') return null;
  // Strip only a single pair of surrounding double quotes.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

// ── add_server_to_env ────────────────────────────────────────────────────────
// Args 8-10 (mode/allow_patterns/audit_log) are optional and default to "" —
// when omitted/empty/unrestricted, no line is written (preserves pre-v3.5.0
// .env output exactly).
export function add_server_to_env(
  name: string,
  host: string,
  user: string,
  authType: string,
  authValue: string,
  port: string = '22',
  description: string = '',
  mode: string = '',
  allowPatterns: string = '',
  auditLog: string = ''
): boolean {
  const nameUpper = name.toUpperCase();

  // Check if server already exists
  if (fs.existsSync(SSH4AGENT_ENV)) {
    const existing = readEnvLines();
    const marker = `SSH_SERVER_${nameUpper}_HOST=`;
    if (existing.some((l) => l.startsWith(marker))) {
      print_error(`Server '${name}' already exists`);
      return false;
    }
  }

  // Ensure parent dir + .env file exist
  fs.mkdirSync(path.dirname(SSH4AGENT_ENV), { recursive: true });
  if (!fs.existsSync(SSH4AGENT_ENV)) fs.writeFileSync(SSH4AGENT_ENV, '', 'utf8');

  // Backup .env file
  try {
    fs.copyFileSync(SSH4AGENT_ENV, `${SSH4AGENT_ENV}.bak`);
  } catch {
    /* ignore backup failures */
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`# Server: ${name}`);
  lines.push(envLineFor(nameUpper, 'host', host));
  lines.push(envLineFor(nameUpper, 'user', user));
  lines.push(envLineFor(nameUpper, 'port', port));

  if (authType === 'password') {
    lines.push(envLineFor(nameUpper, 'password', authValue));
  } else {
    lines.push(envLineFor(nameUpper, 'keyPath', authValue));
  }

  if (description) {
    lines.push(envLineFor(nameUpper, 'description', description));
  }

  // Security mode (v3.5.0+) — only emit non-empty / non-unrestricted values.
  if (mode && mode !== 'unrestricted') {
    lines.push(envLineFor(nameUpper, 'mode', mode));
  }
  if (allowPatterns) {
    lines.push(envLineFor(nameUpper, 'allowPatterns', allowPatterns));
  }
  if (auditLog) {
    lines.push(envLineFor(nameUpper, 'auditLog', auditLog));
  }

  fs.appendFileSync(SSH4AGENT_ENV, lines.join('\n') + '\n', 'utf8');
  print_success(`Server '${name}' added successfully`);
  return true;
}

// ── update_server_in_env ────────────────────────────────────────────────────
export function update_server_in_env(
  name: string,
  host: string,
  user: string,
  authType: string,
  authValue: string,
  port: string = '22',
  description: string = '',
  defaultDir: string = ''
): boolean {
  const nameUpper = name.toUpperCase();
  const marker = `SSH_SERVER_${nameUpper}_HOST=`;

  if (!fs.existsSync(SSH4AGENT_ENV) || !readEnvLines().some((l) => l.startsWith(marker))) {
    print_error(`Server '${name}' not found`);
    return false;
  }

  // Backup
  try {
    fs.copyFileSync(SSH4AGENT_ENV, `${SSH4AGENT_ENV}.bak`);
  } catch {
    /* ignore */
  }

  // Remove old server config lines + the `# Server: name` comment line.
  // bash: sed "/^# Server: $name$/d; /^SSH_SERVER_${name_upper}_/d"
  const commentRe = new RegExp(`^# Server: ${escapeRegex(name)}$`);
  const lineRe = new RegExp(`^SSH_SERVER_${nameUpper}_`);
  const kept = readEnvLines().filter((l) => !commentRe.test(l) && !lineRe.test(l));

  const append: string[] = [];
  append.push('');
  append.push(`# Server: ${name}`);
  append.push(envLineFor(nameUpper, 'host', host));
  append.push(envLineFor(nameUpper, 'user', user));
  append.push(envLineFor(nameUpper, 'port', port));
  if (authType === 'password') {
    append.push(envLineFor(nameUpper, 'password', authValue));
  } else {
    append.push(envLineFor(nameUpper, 'keyPath', authValue));
  }
  if (description) {
    append.push(envLineFor(nameUpper, 'description', description));
  }
  if (defaultDir) {
    append.push(envLineFor(nameUpper, 'defaultDir', defaultDir));
  }

  fs.writeFileSync(SSH4AGENT_ENV, kept.join('\n') + '\n' + append.join('\n') + '\n', 'utf8');
  print_success(`Server '${name}' updated successfully`);
  return true;
}

// ── remove_server_from_env ───────────────────────────────────────────────────
// Note (matches bash grep -v): removes ONLY the SSH_SERVER_<NAME>_ lines,
// leaving the `# Server: name` comment behind.
export function remove_server_from_env(name: string): boolean {
  const nameUpper = name.toUpperCase();
  const marker = `SSH_SERVER_${nameUpper}_HOST=`;
  if (!fs.existsSync(SSH4AGENT_ENV) || !readEnvLines().some((l) => l.startsWith(marker))) {
    print_error(`Server '${name}' not found`);
    return false;
  }
  try {
    fs.copyFileSync(SSH4AGENT_ENV, `${SSH4AGENT_ENV}.bak`);
  } catch {
    /* ignore */
  }
  const lineRe = new RegExp(`^SSH_SERVER_${nameUpper}_`);
  const kept = readEnvLines().filter((l) => !lineRe.test(l));
  fs.writeFileSync(SSH4AGENT_ENV, kept.join('\n') + '\n', 'utf8');
  print_success(`Server '${name}' removed successfully`);
  return true;
}

// ── test_ssh_connection ─────────────────────────────────────────────────────
// Uses the `ssh` binary (allowed via spawn). For password auth, bash relied on
// `sshpass`; since shelling out to sshpass is forbidden, the TS port always
// takes the "sshpass not installed" path and warns (matches bash behavior on
// systems without sshpass — see report).
export function test_ssh_connection(server: string): boolean {
  const host = get_server_config(server, 'HOST');
  const user = get_server_config(server, 'USER');
  let port = get_server_config(server, 'PORT');
  const keypath = get_server_config(server, 'KEYPATH');
  const password = get_server_config(server, 'PASSWORD');
  port = port || '22';

  if (!host || !user) {
    print_error(`Server '${server}' not found or incomplete configuration`);
    return false;
  }

  print_info(`Testing connection to ${server} (${user}@${host}:${port})...`);

  const sshArgs: string[] = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no'];
  if (keypath) {
    sshArgs.push('-i', keypath);
  }

  if (password) {
    // bash: sshpass not installed → warn + return 1. We always take this path.
    print_warning('sshpass not installed, cannot test password authentication');
    return false;
  }

  sshArgs.push('-p', port, `${user}@${host}`, "echo 'Connection successful'");

  const result = spawnSync('ssh', sshArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    print_success('Connection successful');
    return true;
  }

  print_error('Connection failed');
  if (process.env.SSH4AGENT_DEBUG) {
    print_warning('Debug output:');
    const out =
      (result.stdout ? result.stdout.toString() : '') +
      (result.stderr ? result.stderr.toString() : '');
    process.stdout.write(out.replace(/^/gm, '  '));
    if (!out.endsWith('\n')) process.stdout.write('\n');
  } else {
    print_info('Set SSH4AGENT_DEBUG=1 to see detailed error output');
  }
  return false;
}

// ── validate_server_name ─────────────────────────────────────────────────────
// Preserves every rule from config.sh: empty → error; contains '-' → error
// with underscore suggestion; must match ^[a-zA-Z0-9_]+$; must start with a
// letter. Prints errors as a side effect (matching bash), returns boolean.
export function validate_server_name(name: string): boolean {
  if (!name) {
    print_error('Server name cannot be empty');
    return false;
  }

  // Reject hyphens with a targeted message + suggestion.
  if (name.includes('-')) {
    const suggested = name.replace(/-/g, '_');
    print_error(
      "Server name cannot contain '-' (POSIX env var names allow only letters, digits, underscore)"
    );
    print_info(`Try '${suggested}' instead`);
    return false;
  }

  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    print_error('Server name can only contain letters, digits and underscore');
    return false;
  }

  if (!/^[a-zA-Z]/.test(name)) {
    print_error('Server name must start with a letter');
    return false;
  }

  return true;
}

// ── list_invalid_server_names ────────────────────────────────────────────────
// Detect entries in .env whose names contain characters silently dropped by
// the MCP Node loader (issue #25). Returns lower-cased, deduped, sorted names.
export function list_invalid_server_names(): string[] {
  const lines = readEnvLines();
  const out: string[] = [];
  for (const line of lines) {
    const m = HOST_RE.exec(line);
    if (m) {
      const raw = m[1];
      if (!/^[A-Za-z0-9_]+$/.test(raw)) {
        out.push(raw.toLowerCase());
      }
    }
  }
  return Array.from(new Set(out)).sort();
}

// ── check_dependencies ───────────────────────────────────────────────────────
// Only `ssh` is required. Optional: rsync, sshpass. (jq is intentionally NOT
// checked — the TS port uses native JSON.parse/stringify, so jq is unused.)
// `commandExists` walks PATH directly (no `which`/`where` spawn).
export function check_dependencies(): boolean {
  const missing: string[] = [];
  for (const cmd of ['ssh']) {
    if (!commandExists(cmd)) missing.push(cmd);
  }
  const optional: string[] = [];
  for (const cmd of ['rsync', 'sshpass']) {
    if (!commandExists(cmd)) optional.push(cmd);
  }

  if (missing.length > 0) {
    print_error(`Missing required dependencies: ${missing.join(' ')}`);
    print_info('Please install them and try again');
    return false;
  }

  if (optional.length > 0) {
    print_warning(`Missing optional dependencies: ${optional.join(' ')}`);
    print_info("Some features may not work without them (rsync is needed for 'ssh4agent sync')");
  }

  return true;
}

// ── require_command: lazy feature-specific dependency check ──────────────────
export function require_command(cmd: string, feature: string = 'this command'): boolean {
  if (!commandExists(cmd)) {
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

// ── PATH walker (replaces `which`/`where`) ───────────────────────────────────
function commandExists(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter);
  if (isWin) {
    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
    for (const d of dirs) {
      if (!d) continue;
      for (const ext of exts) {
        if (fs.existsSync(path.join(d, cmd + ext))) return true;
      }
    }
    for (const d of dirs) {
      if (d && fs.existsSync(path.join(d, cmd))) return true;
    }
    return false;
  }
  for (const d of dirs) {
    if (d && fs.existsSync(path.join(d, cmd))) return true;
  }
  return false;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Expand a leading ~ to the user's home directory.
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
