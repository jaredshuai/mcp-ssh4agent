/**
 * Test Suite for src/shell-quote.ts
 *
 * Validates:
 *  - shSingleQuote: POSIX single-quote escaping (' → '\'')
 *  - buildCdPrefix: platform-correct working-directory prefixes
 *  - buildSudoPipeline: password piped to sudo -S is fully escaped, and the
 *    masked variant never leaks any part of the password
 *
 * Revives the regression intent of the old debug/test_password_special_chars.sh
 * (bash CLI era): passwords containing quotes / $() / backticks / semicolons
 * must survive command construction without breaking out of their quoting.
 */
import { shSingleQuote, buildCdPrefix, buildSudoPipeline } from '../src/shell-quote.ts';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const NC = '\x1b[0m';

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`${GREEN}✓${NC} ${name}`);
    passedTests++;
  } catch (error) {
    console.log(`${RED}✗${NC} ${name}`);
    console.log(`  ${RED}Error: ${error.message}${NC}`);
    failedTests++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`
    );
  }
}

function assertFalse(cond, message) {
  if (cond) throw new Error(message);
}

// ── shSingleQuote ────────────────────────────────────────────────────────────

test('plain value is wrapped in single quotes', () => {
  assertEqual(shSingleQuote('abc'), `'abc'`);
});

test('empty string quotes to empty single quotes', () => {
  assertEqual(shSingleQuote(''), `''`);
});

test('embedded single quote uses close-escape-reopen sequence', () => {
  assertEqual(shSingleQuote(`it's`), `'it'\\''s'`);
});

test('double quotes, $(), backticks and semicolons stay literal', () => {
  const nasty = `"$(rm -rf /)"; ` + 'echo `id`';
  assertEqual(shSingleQuote(nasty), `'${nasty}'`);
});

test('backslash stays literal (no double-quote expansion semantics)', () => {
  assertEqual(shSingleQuote('a\\b'), `'a\\b'`);
});

// ── buildCdPrefix ────────────────────────────────────────────────────────────

test('linux prefix uses cd with quoted path', () => {
  assertEqual(buildCdPrefix('/opt/app'), `cd '/opt/app' && `);
});

test('linux prefix with space in path', () => {
  assertEqual(buildCdPrefix('/opt/my app'), `cd '/opt/my app' && `);
});

test('linux prefix with quote in path cannot break out', () => {
  const out = buildCdPrefix(`/opt/o'brien`);
  // The quoted segment must contain the escaped form, not a raw breakout.
  assertEqual(out, `cd '/opt/o'\\''brien' && `);
});

test('windows prefix uses Set-Location with doubled quotes', () => {
  assertEqual(
    buildCdPrefix('C:\\Program Files\\app', 'windows'),
    `Set-Location 'C:\\Program Files\\app'; `
  );
  assertEqual(buildCdPrefix("C:\\o'brien", 'windows'), `Set-Location 'C:\\o''brien'; `);
});

// ── buildSudoPipeline ────────────────────────────────────────────────────────

test('plain password and command', () => {
  const { command, masked } = buildSudoPipeline('pw123', 'systemctl restart nginx');
  assertEqual(command, `echo 'pw123' | sudo -S systemctl restart nginx`);
  assertEqual(masked, `echo '********' | sudo -S systemctl restart nginx`);
});

test('leading sudo prefix on command is stripped (no sudo sudo)', () => {
  const { command } = buildSudoPipeline('pw', 'sudo uptime');
  assertEqual(command, `echo 'pw' | sudo -S uptime`);
});

// The regression class from the old bash-CLI era: special-character passwords.
const NASTY_PASSWORDS = [
  `Jx"ds$2016`,
  `pa';ss`,
  'back`tick',
  `semi;colon$(id)`,
  `trailing\\slash`,
  `'\''`,
  `a b c`,
];

for (const pw of NASTY_PASSWORDS) {
  test(`nasty password stays contained: ${JSON.stringify(pw)}`, () => {
    const { command, masked } = buildSudoPipeline(pw, 'uptime');

    // 1) The password appears exactly once, in its escaped single-quoted form.
    const escaped = shSingleQuote(pw);
    assertEqual(command, `echo ${escaped} | sudo -S uptime`);

    // 2) After sh removes the outer quoting, the fed password must equal the
    //    original. Simulate the shell's parse of the '\'' sequence:
    //    strip outer quotes, then undo close-escape-reopen.
    const fed = escaped.slice(1, -1).replace(/'\\''/g, `'`);
    assertEqual(fed, pw, 'shell-side password round-trip');

    // 3) The masked variant must not contain ANY substring of the password
    //    longer than 2 chars (defence against partial leaks).
    for (let i = 0; i + 3 <= pw.length; i++) {
      assertFalse(
        masked.includes(pw.slice(i, i + 3)),
        `masked output leaks password fragment: ${JSON.stringify(pw.slice(i, i + 3))}`
      );
    }
  });
}

test('masked command keeps the command tail intact', () => {
  const { masked } = buildSudoPipeline('secret', 'df -h /var');
  assertEqual(masked, `echo '********' | sudo -S df -h /var`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passedTests} passed, ${failedTests} failed`);
process.exit(failedTests > 0 ? 1 : 0);
