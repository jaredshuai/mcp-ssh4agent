// Parsing helpers for `rsync --stats` output.
//
// `ssh_sync` runs rsync with `--stats` and scrapes the summary block to report
// how many files were transferred. Three things make that scraping fragile, and
// all three are handled here so the tool never falsely claims "no files
// transferred" when a sync actually moved data:
//
//   1. rsync 2.x prints "Number of files transferred: N" while rsync 3.x prints
//      "Number of regular files transferred: N" (the word "regular" was added).
//   2. Byte counts carry an implementation-specific unit suffix: GNU rsync
//      writes "... bytes", openrsync (the default on recent macOS) writes
//      "... B". Both keep raw byte counts even for large files (no K/M/G).
//   3. Depending on the rsync host locale the numbers may use "," or "." as a
//      thousands separator (and the opposite char as the decimal separator).
//
// Keeping this in its own module makes it unit-testable without booting the MCP
// server (importing src/index.ts starts the stdio server as a side effect).

// Parse a number rsync may have grouped with locale-specific separators.
// Counts and sizes are integers (raw bytes); speed carries an optional
// fractional part, so `allowDecimal` says whether the last separator may be a
// decimal point rather than a thousands group.
export function parseGroupedNumber(raw: string, { allowDecimal = false }: { allowDecimal?: boolean } = {}): number {
  const separators = raw.match(/[.,]/g) || [];
  if (separators.length === 0) return Number(raw);

  const distinctSeparators = new Set(separators);
  const lastChar = separators[separators.length - 1];
  const lastIndex = raw.lastIndexOf(lastChar);
  const digitsAfterLast = raw.length - lastIndex - 1;

  // The last separator is a decimal point only when a fractional part is allowed
  // and it cannot be a thousands group:
  //   - two distinct separators ("1.234,56" / "1,234.56") => the last is decimal
  //   - a single separator repeated ("1.234.567") => all are thousands groups
  //   - a single separator with exactly 3 trailing digits ("1,234") => thousands
  const repeated = separators.length > 1;
  const twoTypes = distinctSeparators.size === 2;
  const isDecimal = allowDecimal && (twoTypes || (!repeated && digitsAfterLast !== 3));

  if (!isDecimal) {
    // Every separator just groups thousands; strip them all.
    return Number(raw.replace(/[.,]/g, ''));
  }
  const integerPart = raw.slice(0, lastIndex).replace(/[.,]/g, '');
  const fractionPart = raw.slice(lastIndex + 1);
  return Number(`${integerPart}.${fractionPart}`);
}

// Statistics ssh_sync reports; speed only present when rsync printed that line.
export interface RsyncStats {
  filesTransferred: number;
  totalSize: number;
  totalTime: number;
  speed?: number;
}

// Extract the statistics ssh_sync reports from a full rsync stdout capture.
// Counts default to 0 (never null) when the matching line is absent — e.g. an
// rsync build that produced no --stats block — so callers can use the result
// directly. `speed` is only set when present, matching the optional output line.
export function parseRsyncStats(output: string, totalTime: number): RsyncStats {
  const stats: RsyncStats = {
    filesTransferred: 0,
    totalSize: 0,
    totalTime,
  };

  // rsync 2.x: "Number of files transferred", rsync 3.x: "... regular files ...".
  const filesMatch = output.match(/Number of (?:regular )?files transferred:\s*([\d,.]+)/);
  // GNU rsync suffixes byte counts with "bytes", openrsync with "B".
  const sizeMatch = output.match(/Total transferred file size:\s*([\d,.]+)\s*(?:bytes|B)\b/);
  const speedMatch = output.match(/([\d,.]+)\s*bytes\/sec/);

  if (filesMatch) stats.filesTransferred = parseGroupedNumber(filesMatch[1]);
  if (sizeMatch) stats.totalSize = parseGroupedNumber(sizeMatch[1]);
  if (speedMatch) stats.speed = parseGroupedNumber(speedMatch[1], { allowDecimal: true });

  return stats;
}
