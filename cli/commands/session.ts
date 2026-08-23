// SSH session commands for ssh4agent CLI: start / list / close.
//
// Sessions are ordinary ssh processes, so start reuses the quick-connect
// spawn (cli/lib/process-utils.ts) and list/close enumerate/terminate ssh
// processes. Closing by PID kills whatever ssh process matches — the caller
// is responsible for picking the right one.

import { spawnSync } from 'node:child_process';
import {
  print_error,
  print_header,
  print_info,
  print_success,
  print_warning,
} from '../lib/colors.ts';
import { listSshProcesses, spawnInteractiveSsh } from '../lib/process-utils.ts';

function sessionUsage(): void {
  print_error('Usage: ssh4agent session <action>');
  process.stdout.write('\n');
  process.stdout.write('Actions:\n');
  process.stdout.write('  start <server>   Start interactive session\n');
  process.stdout.write('  list             List active sessions\n');
  process.stdout.write('  close <pid|all>  Close a session\n');
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    // taskkill is a real .exe — no shell needed.
    const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) print_success(`Terminated process ${pid}`);
    else print_error(`Failed to terminate process ${pid}`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    print_success(`Terminated process ${pid}`);
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') {
      print_warning(`Process ${pid} not found`);
    } else {
      print_error(`Failed to terminate process ${pid}: ${(error as Error).message}`);
    }
  }
}

export async function cmd_session(action?: string, ...rest: string[]): Promise<void> {
  switch (action) {
    case 'start': {
      const server = rest[0];
      if (!server) {
        print_error('Usage: ssh4agent session start <server>');
        process.exitCode = 1;
        return;
      }
      if (spawnInteractiveSsh(server)) {
        print_success('Session ended');
      } else {
        process.exitCode = 1;
      }
      return;
    }
    case 'list': {
      print_header('Active SSH Sessions');
      const procs = listSshProcesses('all');
      if (procs.length > 0) {
        process.stdout.write(procs.map((p) => p.display).join('\n') + '\n');
      } else {
        print_info('No active sessions');
      }
      return;
    }
    case 'close': {
      const target = rest[0];
      if (!target || (target !== 'all' && !/^\d+$/.test(target))) {
        print_error('Usage: ssh4agent session close <pid|all>');
        process.exitCode = 1;
        return;
      }
      if (target === 'all') {
        const pids = listSshProcesses('all')
          .map((p) => p.pid)
          .filter((pid): pid is number => pid !== null);
        if (pids.length === 0) {
          print_info('No active sessions');
          return;
        }
        for (const pid of pids) killPid(pid);
        return;
      }
      killPid(Number(target));
      return;
    }
    case undefined:
    case '':
      sessionUsage();
      process.exitCode = 1;
      return;
    default:
      print_error(`Unknown session command: ${action}`);
      sessionUsage();
      process.exitCode = 1;
  }
}
