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
 *
 * @param {string} value - Raw value to quote.
 * @returns {string} The quoted value, e.g. `it's` → `'it'\''s'`.
 */
export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Build a working-directory prefix for a remote command.
 *
 * Linux:    `cd '/opt/app' && `   (POSIX single-quote safe for any path)
 * Windows:  `Set-Location 'C:\app'; ` (PowerShell convention: ' doubled)
 *
 * @param {string} dir - Working directory (assumed non-empty; callers check).
 * @param {string} [platform='linux'] - Target platform; anything other than
 *   'windows' is treated as POSIX.
 * @returns {string} Prefix to prepend to the command.
 */
export function buildCdPrefix(dir, platform = 'linux') {
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
 * @param {string} password - sudo password (any characters).
 * @param {string} command - Command to run under sudo, WITHOUT a leading
 *   `sudo ` prefix (this function adds it).
 * @returns {{command: string, masked: string}} `command` is the runnable
 *   pipeline; `masked` shows `********` in place of the password.
 */
export function buildSudoPipeline(password, command) {
  const bare = String(command).replace(/^sudo\s+/, '');
  const quoted = shSingleQuote(password);
  return {
    command: `echo ${quoted} | sudo -S ${bare}`,
    masked: `echo '********' | sudo -S ${bare}`,
  };
}
