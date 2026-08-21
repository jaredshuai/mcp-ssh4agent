/**
 * Shell quoting and remote command construction.
 *
 * Single source of truth for putting dynamic values (passwords, paths) into
 * shell command strings. Before this module existed, each call site built its
 * own `echo "${password}" | sudo -S ...` / `cd ${dir} && ...` string with no
 * escaping, so any value containing quotes, `$()`, backticks or `;` would
 * break the command or inject arbitrary shell code (see the
 * test_password_special_chars regression history).
 *
 * All functions are pure: no I/O, no SSH dependency.
 */

/**
 * Quote a value for safe interpolation into a POSIX sh command.
 * Uses single quotes (the only quoting form with no expansions inside):
 * everything literal except the single quote itself, which is emitted as
 * the standard close-quote/escape/reopen sequence '\''.
 */
export function shSingleQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Build a working-directory prefix for a remote command.
 *
 * Linux:    `cd '/opt/app' && `   (POSIX single-quote safe for any path)
 * Windows:  `Set-Location 'C:\app'; ` (PowerShell convention: ' doubled)
 *
 * Anything other than 'windows' is treated as POSIX.
 */
export function buildCdPrefix(dir: string, platform = 'linux'): string {
  if (platform === 'windows') {
    const escapedDir = String(dir).replace(/'/g, '\'\'');
    return `Set-Location '${escapedDir}'; `;
  }
  return `cd ${shSingleQuote(dir)} && `;
}

/**
 * Build a `sudo -S` pipeline that feeds the password on stdin.
 *
 * Returns both the real command and a masked variant for logging. The masked
 * form is reconstructed (not regex-replaced) so a password containing quotes
 * can never leak into logs through an incomplete match.
 *
 * `command` must NOT carry a leading `sudo ` prefix (this function adds it).
 */
export function buildSudoPipeline(password: string, command: string): { command: string; masked: string } {
  const bare = String(command).replace(/^sudo\s+/, '');
  const quoted = shSingleQuote(password);
  return {
    command: `echo ${quoted} | sudo -S ${bare}`,
    masked: `echo '********' | sudo -S ${bare}`,
  };
}
