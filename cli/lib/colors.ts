// Colors and formatting library for ssh-manager CLI.
//
// Cross-platform TypeScript port of cli/lib/colors.sh. Uses ANSI escape codes
// (natively supported on Windows 10+ terminals) and node:readline for prompts.
// No shell-isms (no `clear`, no `read -s`, no `printf`).

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

// ── Color codes (match colors.sh) ──────────────────────────────────────────
export const RED = '\x1b[0;31m';
export const GREEN = '\x1b[0;32m';
export const YELLOW = '\x1b[1;33m';
export const BLUE = '\x1b[0;34m';
export const MAGENTA = '\x1b[0;35m';
export const CYAN = '\x1b[0;36m';
export const WHITE = '\x1b[1;37m';
export const GRAY = '\x1b[0;90m';
export const BOLD = '\x1b[1m';
export const NC = '\x1b[0m'; // No Color

// ── Unicode symbols (match colors.sh exactly, including trailing spaces) ──
export const CHECK = '✅';
export const CROSS = '❌';
export const WARN = '⚠️';
export const INFO = 'ℹ️ ';
export const ARROW = '➜';
export const ROCKET = '🚀';
export const KEY = '🔑';
export const SERVER = '🖥️ ';
export const FOLDER = '📁';
export const SYNC = '🔄';
export const MONITOR = '📊';
export const TUNNEL = '🔧';
export const SESSION = '💻';
export const CLIPBOARD = '📋';
export const EYE = '👁️';
export const GEAR = '⚙️ ';
export const PENCIL = '✏️ ';
export const NOTE = '📝';
export const WRENCH = '🔧';
export const LOCK = '🔒';
export const UNLOCK = '🔓';
export const STAR = '⭐';
export const HEART = '❤️';
export const LIGHTBULB = '💡';
export const BUG = '🐛';

// ── Print functions (match colors.sh output byte-for-byte) ──────────────────
export function print_success(msg: string): void {
  process.stdout.write(`${GREEN}${CHECK} ${msg}${NC}\n`);
}

export function print_error(msg: string): void {
  // bash: echo -e "${RED}${CROSS} $1${NC}" >&2
  process.stderr.write(`${RED}${CROSS} ${msg}${NC}\n`);
}

export function print_warning(msg: string): void {
  process.stdout.write(`${YELLOW}${WARN} ${msg}${NC}\n`);
}

export function print_info(msg: string): void {
  process.stdout.write(`${CYAN}${INFO} ${msg}${NC}\n`);
}

export function print_header(title: string): void {
  // bash: \n + BOLD+BLUE+title + \n + BLUE + 60 '=' + NC
  const bar = '='.repeat(60);
  process.stdout.write(`\n${BOLD}${BLUE}${title}${NC}\n`);
  process.stdout.write(`${BLUE}${bar}${NC}\n`);
}

export function print_subheader(title: string): void {
  // bash: \n + BOLD+CYAN+title + \n + CYAN + 40 '-' + NC
  const bar = '-'.repeat(40);
  process.stdout.write(`\n${BOLD}${CYAN}${title}${NC}\n`);
  process.stdout.write(`${CYAN}${bar}${NC}\n`);
}

// ── Table printing with column alignment ────────────────────────────────────
// bash: printf "%-20s %-30s %s\n"
export function print_table_header(col1: string, col2: string, col3: string = ''): void {
  const row = `${col1.padEnd(20)} ${col2.padEnd(30)} ${col3}`.trimEnd();
  const bar = '-'.repeat(70);
  process.stdout.write(`${BOLD}\n`);
  process.stdout.write(`${row}\n`);
  process.stdout.write(`${bar}${NC}\n`);
}

export function print_table_row(col1: string, col2: string, col3: string = ''): void {
  const row = `${col1.padEnd(20)} ${col2.padEnd(30)} ${col3}`.trimEnd();
  process.stdout.write(`${row}\n`);
}

// ── Clear screen (replaces `clear`) ─────────────────────────────────────────
// \x1b[2J = clear screen, \x1b[3J = clear scrollback, \x1b[H = move cursor home
export function clear_screen(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

// ── Status indicators ────────────────────────────────────────────────────────
export function show_status(status: string): void {
  switch (status) {
    case 'active':
    case 'running':
    case 'success':
      process.stdout.write(`${GREEN}● ${status}${NC}\n`);
      break;
    case 'inactive':
    case 'stopped':
      process.stdout.write(`${GRAY}● ${status}${NC}\n`);
      break;
    case 'failed':
    case 'error':
      process.stdout.write(`${RED}● ${status}${NC}\n`);
      break;
    case 'warning':
    case 'degraded':
      process.stdout.write(`${YELLOW}● ${status}${NC}\n`);
      break;
    default:
      process.stdout.write(`● ${status}\n`);
  }
}

// ── Prompt functions (node:readline based, async) ────────────────────────────
//
// The bash originals used `eval` to set a variable by name; here we return the
// value directly. Prompts are async because node:readline is async (and this is
// the only reliable cross-platform way to read a TTY on Windows without
// shelling out). Call sites `await` them.

let _rl: readline.Interface | null = null;

function sharedInterface(): readline.Interface {
  if (!_rl || (_rl as any).closed) {
    _rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
  }
  return _rl;
}

function closeInterface(): void {
  if (_rl && !(_rl as any).closed) {
    try { _rl.close(); } catch { /* ignore */ }
  }
  _rl = null;
}

// Low-level: write the prompt verbatim, read one line.
export function question(q: string): Promise<string> {
  return new Promise((resolve) => {
    const iface = sharedInterface();
    iface.question(q, (ans) => resolve(ans));
  });
}

// prompt_input(prompt, default?): bash default-empty → "prompt: ", else "prompt [default]: "
// Empty input falls back to default when default is provided.
export async function prompt_input(prompt: string, def?: string): Promise<string> {
  const q = def && def !== '' ? `${prompt} [${def}]: ` : `${prompt}: `;
  let ans = await question(q);
  if (ans === '' && def !== undefined) ans = def;
  return ans;
}

// prompt_yes_no(prompt, default='n'): [Y/n] or [y/N] hint, returns boolean.
export async function prompt_yes_no(prompt: string, def: string = 'n'): Promise<boolean> {
  const hint = def === 'y' ? `${prompt} [Y/n]: ` : `${prompt} [y/N]: `;
  let ans = await question(hint);
  if (ans === '') ans = def;
  return /^[yY]([eE][sS])?$/.test(ans);
}

// prompt_password(prompt): silent (no echo). Uses a muted output stream +
// raw-mode stdin so neither the OS nor readline echoes the typed characters.
export async function prompt_password(prompt: string): Promise<string> {
  // The shared interface owns stdin; close it so the muted interface can take over.
  closeInterface();
  const mute = new Writable({
    write(_chunk: Buffer, _encoding: string, callback: () => void) {
      callback();
    },
  });
  const pwIface = readline.createInterface({
    input: process.stdin,
    output: mute,
    terminal: process.stdin.isTTY,
  });
  try {
    const ans = await new Promise<string>((resolve) => {
      pwIface.question(`${prompt}: `, (a: string) => resolve(a));
    });
    process.stdout.write('\n'); // bash `read -s` echoes a newline after input
    return ans;
  } finally {
    try { pwIface.close(); } catch { /* ignore */ }
  }
}

// Pause helper for "Press Enter to continue..." prompts.
export async function pause(msg: string = 'Press Enter to continue...'): Promise<void> {
  await question(msg);
}

// Exported so the main entry can tear down the readline interface on exit
// (otherwise the process may hang waiting on stdin).
export function cleanupPrompts(): void {
  closeInterface();
}
