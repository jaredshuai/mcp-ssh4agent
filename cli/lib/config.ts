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
import {
  FIELD_BY_CAMEL,
  SERVER_FIELDS,
  serverEnvLine,
  parseEnvServersText,
} from '../../src/server-fields.ts';
import { resolveEnvFilePath } from '../../src/env-path.ts';

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

// Values containing BOTH quote characters cannot be written to .env
// losslessly (serverEnvLine throws for them) — check BEFORE any file
// mutation so add/update fail cleanly with guidance instead of a
// half-written file.
function envValueRepresentable(...values: string[]): boolean {
  for (const v of values) {
    if (v && v.includes('"') && v.includes("'")) {
      print_error(`Value contains both ' and " — the .env format cannot store it losslessly.`);
      print_info(
        'Store this server in TOML instead (ssh4agent codex migrate), or change the value.'
      );
      return false;
    }
  }
  return true;
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

// Resolve .env through the ONE shared fallback chain (src/env-path.ts):
// SSH_ENV_PATH → SSH4AGENT_ENV (deprecated alias) → ~/.ssh4agent/.env →
// legacy ~/.ssh-manager/.env → $PWD/.env → ~/.env → <package root>/.env →
// default ~/.ssh4agent/.env. The CLI and the MCP entry point can no longer
// disagree about which file holds the servers (issue #7).
//
// The chain documents the legacy dir as a READ-ONLY fallback, so when it is
// the resolved file we migrate it into the config home once (copy, then use
// the new path for reads AND writes) instead of mutating the legacy file.
//
// Guards (PR #9 review):
// - An explicit SSH_ENV_PATH / SSH4AGENT_ENV override is respected verbatim:
//   migration only runs when the legacy file was reached through the
//   fallback chain, never when the user pointed at it directly.
// - The CLI's own config.json/aliases.json must move in the SAME step:
//   this migration creates ~/.ssh4agent, which flips resolveConfigHome()
//   below to the new directory — without the copy, the legacy settings
//   would be orphaned behind a fresh default config.
let resolvedEnvPath: string = resolveEnvFilePath();
const homeEnvPath = path.join(SSH4AGENT_HOME, '.env');
const envOverrideSet = Boolean(process.env.SSH_ENV_PATH || process.env.SSH4AGENT_ENV);
if (
  !envOverrideSet &&
  resolvedEnvPath !== homeEnvPath &&
  path.dirname(resolvedEnvPath) === LEGACY_HOME
) {
  const homeExisted = fs.existsSync(SSH4AGENT_HOME);
  try {
    fs.mkdirSync(SSH4AGENT_HOME, { recursive: true });
    fs.copyFileSync(resolvedEnvPath, homeEnvPath);
    print_info(`Migrated legacy config ${resolvedEnvPath} → ${homeEnvPath}`);
    resolvedEnvPath = homeEnvPath;
  } catch {
    // Best-effort rollback: a half-finished migration must not flip
    // CONFIG_HOME (which follows dir existence) to the new directory
    // while .env still resolves to the legacy file — that split-brain
    // reads servers from legacy but writes config to the empty new
    // home (PR #9 review, round 3). Undo what this attempt created;
    // rmdirSync only removes the dir when empty, so pre-existing user
    // content under SSH4AGENT_HOME is never touched.
    try {
      fs.unlinkSync(homeEnvPath);
    } catch {
      /* best-effort */
    }
    if (!homeExisted) {
      try {
        fs.rmdirSync(SSH4AGENT_HOME);
      } catch {
        /* non-empty or already gone */
      }
    }
  }
}

// Legacy CLI settings (config.json / aliases.json) migrate INDEPENDENTLY of
// where the servers live. A TOML or cwd-.env setup never enters the .env
// migration above, yet the MCP side's state dir creates ~/.ssh4agent on
// first startup — after that, resolveConfigHome() stops falling back to
// the legacy dir and init_config() would replace the user's editor/shell/
// history settings with defaults.
//
// All-or-nothing per run (PR #9 r5): a partial copy that leaves the new
// home WITHOUT config.json is worse than no migration — init_config()
// would write defaults over the gap and every later run sees the file as
// "already migrated". On failure, this run's copies are removed and the
// home dir (if this run created it) too, so the next invocation retries.
if (fs.existsSync(LEGACY_HOME)) {
  const homeExisted = fs.existsSync(SSH4AGENT_HOME);
  const pending: Array<{ from: string; to: string }> = [];
  for (const file of ['config.json', 'aliases.json']) {
    const from = path.join(LEGACY_HOME, file);
    const to = path.join(SSH4AGENT_HOME, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) pending.push({ from, to });
  }
  if (pending.length > 0) {
    const done: string[] = [];
    try {
      fs.mkdirSync(SSH4AGENT_HOME, { recursive: true });
      for (const p of pending) {
        fs.copyFileSync(p.from, p.to);
        done.push(p.to);
      }
      for (const p of pending) print_info(`Migrated legacy CLI config ${p.from} → ${p.to}`);
    } catch {
      for (const f of done) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* best-effort */
        }
      }
      if (!homeExisted) {
        try {
          fs.rmdirSync(SSH4AGENT_HOME);
        } catch {
          /* non-empty or already gone */
        }
      }
    }
  }
}
export const SSH4AGENT_ENV: string = resolvedEnvPath;

// Computed AFTER the migration above: when the migration created
// ~/.ssh4agent (with .env + config.json), the CLI must read AND write the
// new home immediately — resolving first would point this invocation at
// the legacy dir and lose any config written before the next run.
const CONFIG_HOME: string = resolveConfigHome();

export const SSH4AGENT_CONFIG: string = path.join(CONFIG_HOME, 'config.json');

export const SSH4AGENT_ALIASES: string = path.join(CONFIG_HOME, 'aliases.json');

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

// get_server_config(server, field): read one server field through the SAME
// parser the MCP loader uses (parseEnvServersText in src/server-fields.ts).
// The CLI's own line-parsing implementation was deleted — the two sides had
// drifted on quoting and field mapping (issue #7). `field` is the `.env`
// suffix (HOST, USER, KEYPATH, DEFAULT_DIR, ...); returns null when the file,
// server, or field is absent.
export function get_server_config(server: string, field: string): string | null {
  if (!fs.existsSync(SSH4AGENT_ENV)) return null;
  const servers = parseEnvServersText(fs.readFileSync(SSH4AGENT_ENV, 'utf8'));
  const record = servers.get(server.toLowerCase());
  if (!record) return null;
  const fieldUpper = field.toUpperCase();
  const spec = SERVER_FIELDS.find((f) => f.env === fieldUpper);
  if (!spec) return null;
  const value = record[spec.camel];
  if (value === undefined || value === null || value === '') return null;
  // Pattern lists (ALLOW/DENY_PATTERNS) keep their .env `;`-separated wire
  // format — String([]) would join with commas and break round-tripping.
  if (Array.isArray(value)) return value.join(';');
  return String(value);
}

// Case-insensitive `SSH_SERVER_<name>_HOST=` line marker. Hand-authored
// files may use any casing (`SSH_SERVER_Prod_HOST=`) while the CLI
// addresses servers by their lowercased name — every existence check
// (add duplicate guard, update, remove, has_server_entry) must agree, or
// users get flows like "remove works but update claims not found"
// (PR #9 review, round 3).
function hostMarkerRe(name: string): RegExp {
  return new RegExp(`^SSH_SERVER_${escapeRegex(name)}_HOST=`, 'i');
}

// `SSH_SERVER_<name>_<FIELD>=` matcher for rewrite/delete flows. The field
// alternation (from the shared field table) is what makes it exact: a bare
// `^SSH_SERVER_${name}_` prefix also matches OTHER servers whose names
// START with `name` — `server remove foo` would take `foo_bar`'s lines
// with it (PR #9 review, round 4).
function serverLinesRe(name: string): RegExp {
  const fields = SERVER_FIELDS.map((f) => f.env).join('|');
  return new RegExp(`^SSH_SERVER_${escapeRegex(name)}_(?:${fields})=`, 'i');
}

// Raw-line existence check that ALSO sees names the MCP loader silently
// drops (e.g. `bad-name` — invalid in env-var syntax). load_servers() lists
// those entries, so remove flows must recognize them too for the
// documented remove-and-readd recovery to work.
export function has_server_entry(server: string): boolean {
  if (!fs.existsSync(SSH4AGENT_ENV)) return false;
  return readEnvLines().some((l) => hostMarkerRe(server).test(l));
}

// The SSH dial coordinates every CLI ssh/rsync/tunnel invocation needs.
// Used to be re-fetched field-by-field in five places (cmd_exec, cmd_sync,
// cmd_tunnel, test_ssh_connection, spawnInteractiveSsh).
export interface SshTarget {
  host: string;
  user: string;
  port: string;
  keypath: string | null;
  password: string | null;
}

// Resolve a configured server to its ssh arguments. Returns null when the
// server is unknown or lacks HOST/USER.
export function resolveServerToSshArgs(server: string): SshTarget | null {
  const host = get_server_config(server, 'HOST');
  const user = get_server_config(server, 'USER');
  if (!host || !user) return null;
  return {
    host,
    user,
    port: get_server_config(server, 'PORT') || '22',
    keypath: get_server_config(server, 'KEYPATH'),
    password: get_server_config(server, 'PASSWORD'),
  };
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

  // Reject unrepresentable values before touching the file.
  if (
    !envValueRepresentable(authValue, description) ||
    (allowPatterns && !envValueRepresentable(allowPatterns)) ||
    (auditLog && !envValueRepresentable(auditLog))
  ) {
    return false;
  }

  // Check if server already exists
  if (fs.existsSync(SSH4AGENT_ENV)) {
    const existing = readEnvLines();
    if (existing.some((l) => hostMarkerRe(name).test(l))) {
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

  // Reject unrepresentable values before touching the file.
  if (!envValueRepresentable(authValue, description, defaultDir)) {
    return false;
  }

  if (!fs.existsSync(SSH4AGENT_ENV) || !readEnvLines().some((l) => hostMarkerRe(name).test(l))) {
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
  // bash: sed "/^# Server: $name$/d; /^SSH_SERVER_${name_upper}_/d" —
  // case-insensitive so hand-authored cased entries rewrite cleanly, and
  // field-anchored so `foo` cannot swallow `foo_bar`'s lines.
  const commentRe = new RegExp(`^# Server: ${escapeRegex(name)}$`);
  const lineRe = serverLinesRe(name);
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
// leaving the `# Server: name` comment behind. Case-insensitive for the
// same reason as has_server_entry(): hand-authored entries may use any
// casing while the CLI addresses servers by their lowercased name.
export function remove_server_from_env(name: string): boolean {
  if (!fs.existsSync(SSH4AGENT_ENV) || !readEnvLines().some((l) => hostMarkerRe(name).test(l))) {
    print_error(`Server '${name}' not found`);
    return false;
  }
  try {
    fs.copyFileSync(SSH4AGENT_ENV, `${SSH4AGENT_ENV}.bak`);
  } catch {
    /* ignore */
  }
  // Field-anchored: `server remove foo` must not take `foo_bar`'s lines.
  const kept = readEnvLines().filter((l) => !serverLinesRe(name).test(l));
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
  const target = resolveServerToSshArgs(server);
  if (!target) {
    print_error(`Server '${server}' not found or incomplete configuration`);
    return false;
  }
  const { host, user, port, keypath, password } = target;

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
