// Monitor command mapping for ssh4agent CLI.
//
// Single source of truth for the remote monitoring one-liners — the direct
// `monitor <server> <type>` dispatcher and the interactive menu (choice 5)
// both resolve through monitorCommandFor(), so the two paths cannot drift.

export const MONITOR_TYPES = ['overview', 'cpu', 'memory', 'disk', 'network'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

const MONITOR_COMMANDS: Record<MonitorType, string> = {
  overview: 'uptime && free -h && df -h',
  cpu: 'top -bn1 | head -20',
  memory: 'free -h && ps aux --sort=-%mem | head -10',
  disk: 'df -h && du -sh /* 2>/dev/null | sort -h | tail -10',
  network: 'netstat -tulpn 2>/dev/null | grep LISTEN',
};

// Map a monitor type to its remote command. No type → overview; an unknown
// type → null (callers report the valid types).
export function monitorCommandFor(type?: string): string | null {
  const key = type ?? 'overview';
  return (MONITOR_COMMANDS as Record<string, string>)[key] ?? null;
}
