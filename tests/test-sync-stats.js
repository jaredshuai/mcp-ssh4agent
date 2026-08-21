// Unit tests for rsync --stats parsing (src/rsync-stats.ts).
//
// Regression guard for ssh_sync's false "no files needed to be transferred"
// report. The tool scrapes rsync's stats block, whose shape varies by rsync
// version (2.x vs 3.x wording), implementation (GNU "bytes" vs openrsync "B"),
// and host locale (thousands/decimal separators). These cases pin every variant
// seen in the wild — the openrsync samples are captured verbatim from a live
// macOS run, the GNU/locale samples mirror documented rsync output.
import { parseRsyncStats, parseGroupedNumber } from '../src/rsync-stats.ts';

let passed = 0;
let failed = 0;
const ok = (label) => {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
};
const ko = (label, detail) => {
  console.log(`\x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
};
function eq(actual, expected, label) {
  if (actual === expected) ok(label);
  else ko(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Real openrsync output (captured on macOS 15, /usr/bin/rsync) ------------

const OPENRSYNC_SMALL = `Transfer starting: 2 files
file.txt
Number of files: 2
Number of files transferred: 1
Total file size: 28 B
Total transferred file size: 28 B
Unmatched data: 28 B
Matched data: 0 B
File list size: 83 B
Total sent: 170 B
Total received: 42 B

sent 170 bytes  received 42 bytes  100952 bytes/sec
total size is 28  speedup is 0.13`;

const OPENRSYNC_LARGE = `Transfer starting: 2 files
big.bin
Number of files: 2
Number of files transferred: 1
Total file size: 5242880 B
Total transferred file size: 5242880 B
Unmatched data: 5242880 B
Matched data: 0 B
File list size: 82 B
Total sent: 5251 B
Total received: 42 B

sent 5251 bytes  received 42 bytes  188362 bytes/sec
total size is 5242880  speedup is 990.53`;

// --- GNU rsync 3.x, C locale ------------------------------------------------

const GNU_3X = `Number of files: 1 (reg: 1)
Number of created files: 0
Number of regular files transferred: 1
Total file size: 40 bytes
Total transferred file size: 40 bytes
Literal data: 40 bytes
Matched data: 0 bytes
File list size: 0
File list generation time: 0.001 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 137
Total bytes received: 35

sent 137 bytes  received 35 bytes  344.00 bytes/sec
total size is 40  speedup is 0.23`;

// --- GNU rsync 3.x, US locale (comma thousands, dot decimal) ----------------

const GNU_3X_US = `Number of regular files transferred: 1,234
Total transferred file size: 1,048,576 bytes
sent 1,200,000 bytes  received 35 bytes  2,470.50 bytes/sec
total size is 1,048,576  speedup is 0.87`;

// --- GNU rsync 3.x, EU locale (dot thousands, comma decimal) ----------------

const GNU_3X_EU = `Number of regular files transferred: 1.234
Total transferred file size: 1.048.576 bytes
sent 1.200.000 bytes  received 35 bytes  2.470,50 bytes/sec
total size is 1.048.576  speedup is 0,87`;

// --- Legacy rsync 2.x (no "regular", "wrote/read" speed line) ---------------

const RSYNC_2X = `Number of files: 5
Number of files transferred: 5
Total file size: 2048 bytes
Total transferred file size: 2048 bytes
wrote 2100 bytes  read 80 bytes  4360.00 bytes/sec
total size is 2048  speedup is 0.94`;

// --- Nothing changed: a real, successful sync that moved zero files ---------

const NO_FILES = `Number of files: 3 (reg: 3)
Number of regular files transferred: 0
Total file size: 1024 bytes
Total transferred file size: 0 bytes
sent 80 bytes  received 12 bytes  184.00 bytes/sec
total size is 1024  speedup is 11.13`;

const statsCases = [
  { name: 'openrsync small', output: OPENRSYNC_SMALL, files: 1, size: 28, speed: 100952 },
  {
    name: 'openrsync large (raw bytes, no MB)',
    output: OPENRSYNC_LARGE,
    files: 1,
    size: 5242880,
    speed: 188362,
  },
  { name: 'GNU rsync 3.x (regular files / bytes)', output: GNU_3X, files: 1, size: 40, speed: 344 },
  {
    name: 'GNU rsync 3.x US locale (1,234 / 1,048,576)',
    output: GNU_3X_US,
    files: 1234,
    size: 1048576,
    speed: 2470.5,
  },
  {
    name: 'GNU rsync 3.x EU locale (1.234 / 1.048.576)',
    output: GNU_3X_EU,
    files: 1234,
    size: 1048576,
    speed: 2470.5,
  },
  { name: 'legacy rsync 2.x (no "regular")', output: RSYNC_2X, files: 5, size: 2048, speed: 4360 },
  { name: 'successful sync, zero files moved', output: NO_FILES, files: 0, size: 0, speed: 184 },
];

console.log('parseRsyncStats — full output samples:');
for (const c of statsCases) {
  const stats = parseRsyncStats(c.output, 1234);
  eq(stats.filesTransferred, c.files, `${c.name}: filesTransferred`);
  eq(stats.totalSize, c.size, `${c.name}: totalSize`);
  eq(stats.speed, c.speed, `${c.name}: speed`);
  eq(stats.totalTime, 1234, `${c.name}: totalTime passthrough`);
}

// Defensive: rsync that produced no stats block (build without --stats, an
// early failure, a dry run that printed nothing) must yield safe zeros, never
// null, and leave speed undefined.
console.log('\nparseRsyncStats — missing stats block:');
{
  const stats = parseRsyncStats('rsync: connection unexpectedly closed\n', 99);
  eq(stats.filesTransferred, 0, 'no stats: filesTransferred defaults to 0');
  eq(stats.totalSize, 0, 'no stats: totalSize defaults to 0');
  eq(stats.speed, undefined, 'no stats: speed left undefined');
  eq(stats.totalTime, 99, 'no stats: totalTime passthrough');
}

// Distinguish "Total transferred file size" from the unrelated "Total file
// size" line that precedes it (all files vs only the ones actually sent).
console.log('\nparseRsyncStats — does not confuse "Total file size":');
{
  const stats = parseRsyncStats(
    'Total file size: 9999 bytes\nTotal transferred file size: 42 bytes\n',
    1
  );
  eq(stats.totalSize, 42, 'picks "transferred" size, not total size');
}

console.log('\nparseGroupedNumber — locale-aware number parsing:');
eq(parseGroupedNumber('28'), 28, 'plain integer');
eq(parseGroupedNumber('5242880'), 5242880, 'large plain integer');
eq(parseGroupedNumber('1,048,576'), 1048576, 'US thousands (comma)');
eq(parseGroupedNumber('1.048.576'), 1048576, 'EU thousands (dot)');
eq(parseGroupedNumber('1,234'), 1234, 'single comma, 3 digits => thousands');
eq(parseGroupedNumber('1.234'), 1234, 'single dot, 3 digits => thousands (integer)');
eq(parseGroupedNumber('0'), 0, 'zero');
eq(parseGroupedNumber('344.00', { allowDecimal: true }), 344, 'decimal with dot');
eq(
  parseGroupedNumber('2,470.50', { allowDecimal: true }),
  2470.5,
  'US decimal (comma thousands, dot decimal)'
);
eq(
  parseGroupedNumber('2.470,50', { allowDecimal: true }),
  2470.5,
  'EU decimal (dot thousands, comma decimal)'
);
eq(parseGroupedNumber('100952', { allowDecimal: true }), 100952, 'decimal context, integer value');
eq(
  parseGroupedNumber('1,5', { allowDecimal: true }),
  1.5,
  'single separator, non-3 digits => decimal'
);
eq(
  parseGroupedNumber('1,234,567', { allowDecimal: true }),
  1234567,
  'repeated separator => thousands even in decimal context'
);

console.log(`\n${failed === 0 ? '✅' : '❌'} sync-stats tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
