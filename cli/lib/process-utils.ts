// Process utilities for ssh4agent CLI — SSH process enumeration and the
// interactive ssh spawn shared by `cmd_ssh` and `session start`.
//
// Lives in cli/lib/ so command modules never import cli/ssh-manager.ts, which
// executes main() at top level (importing it would boot the whole CLI).

import { spawnSync } from 'node:child_process';
import { print_error, print_info } from './colors.ts';
import { resolveServerToSshArgs } from './config.ts';

export interface SshProcess {
  pid: number | null;
  display: string;
}

// Parse the PID out of a `ps -A -o pid,command` line (PID is the first
// column); returns null when the line has no numeric first column.
function parsePsPid(line: string): number | null {
  const first = line.trim().split(/\s+/)[0];
  const pid = Number.parseInt(first ?? '', 10);
  return Number.isNaN(pid) ? null : pid;
}

// Parse the PID out of a tasklist row (second column: Image Name, PID, ...).
function parseTasklistPid(line: string): number | null {
  const pid = Number.parseInt(line.trim().split(/\s+/)[1] ?? '', 10);
  return Number.isNaN(pid) ? null : pid;
}

// Cross-platform SSH process enumeration (replaces `ps aux | grep ssh`).
// - win32: `tasklist /FI "IMAGENAME eq ssh.exe"` (tasklist cannot see cmdline,
//   so both filters list every ssh.exe process — same limitation as the bash
//   fallback). When rows match, the tasklist table header is kept as a
//   pid-less display row so column labels stay visible.
// - other: `ps -A -o pid,command`; 'tunnels' keeps only -L/-R/-D lines,
//   'all' keeps every ssh line.
export function listSshProcesses(filter: 'tunnels' | 'all'): SshProcess[] {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ssh.exe'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = r.stdout ? r.stdout.toString() : '';
      // tasklist always prints an INFO/empty header when no matches; only
      // keep lines that actually reference ssh.exe.
      const lines = out.split(/\r?\n/).filter((l) => /ssh\.exe/i.test(l));
      if (lines.length === 0) return [];
      const header = out.split(/\r?\n/).slice(0, 3).join('\n');
      return [
        { pid: null, display: header },
        ...lines.map((l) => ({ pid: parseTasklistPid(l), display: l })),
      ];
    } catch {
      return [];
    }
  }
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid,command'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = r.stdout ? r.stdout.toString() : '';
    return out
      .split(/\r?\n/)
      .filter((l) =>
        filter === 'tunnels'
          ? /ssh/.test(l) && /(-L|-R|-D)/.test(l) && !/grep/.test(l)
          : /ssh/.test(l) && !/grep/.test(l)
      )
      .map((l) => ({ pid: parsePsPid(l), display: l }));
  } catch {
    return [];
  }
}

// Resolve a configured server and spawn an interactive ssh session for it
// (stdio inherit). Returns true when ssh exited cleanly. Shared by `cmd_ssh`
// (quick connect) and `session start`.
export function spawnInteractiveSsh(server: string): boolean {
  const target = resolveServerToSshArgs(server);
  if (!target) {
    print_error(`Server '${server}' not found`);
    return false;
  }

  const sshArgs: string[] = ['-p', target.port];
  if (target.keypath) sshArgs.push('-i', target.keypath);

  print_info(`Connecting to ${server}...`);
  const r = spawnSync('ssh', [...sshArgs, `${target.user}@${target.host}`], {
    stdio: 'inherit',
  });
  return r.status === 0;
}
