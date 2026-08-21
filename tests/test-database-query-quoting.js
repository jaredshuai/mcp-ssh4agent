import {
  buildHeredoc,
  buildMySQLQueryCommand,
  buildPostgreSQLQueryCommand,
  buildMongoDBQueryCommand
} from '../src/database-manager.ts';

/**
 * Regression tests for issue #44: ssh_db_query must not let the remote shell parse the
 * SQL/JS query text. The query builders now deliver the query on stdin via a single-
 * quoted heredoc, so backtick-quoted identifiers survive intact and the query cannot
 * inject shell commands.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
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
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, message) {
  if (!cond) throw new Error(message);
}

const DELIM = '__MCP_SQL_EOF__';

/**
 * Extract the heredoc body delivered to stdin from a built command string.
 * The body is every line between the `<<'DELIM'` opening line and the terminator line.
 */
function extractHeredocBody(command) {
  const lines = command.split('\n');
  const start = lines.findIndex(l => l.includes(`<<'${DELIM}'`));
  assertTrue(start !== -1, `command has no heredoc opening: ${command}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l === DELIM);
  assertTrue(end !== -1, `command has no heredoc terminator on its own line: ${command}`);
  return rest.slice(0, end).join('\n');
}

console.log('\n' + YELLOW + 'Running Database Query Quoting Tests (issue #44)...' + NC + '\n');

// --- MySQL (JSON format, the default) ---

test('MySQL: backtick identifier is carried verbatim on stdin, not via -e', () => {
  const query = 'SELECT a.id FROM app_table a LEFT JOIN `other-db`.notes o ON a.ext = o.ext';
  const cmd = buildMySQLQueryCommand({ database: 'app', query });
  assertEqual(extractHeredocBody(cmd), query, 'heredoc body must equal the query verbatim');
  assertTrue(!cmd.includes('-e "'), 'must not interpolate query into a double-quoted -e argument');
  assertTrue(cmd.includes(`<<'${DELIM}'`), 'must use a single-quoted heredoc delimiter');
});

test('MySQL: awk JSON pipe stays on the heredoc opening line, terminator stays alone', () => {
  const query = 'SELECT 1';
  const cmd = buildMySQLQueryCommand({ database: 'app', query });
  const lines = cmd.split('\n');
  const openLine = lines.find(l => l.includes(`<<'${DELIM}'`));
  assertTrue(/\| awk /.test(openLine), 'awk pipe must be on the heredoc opening line');
  assertEqual(lines[lines.length - 1], DELIM, 'last line must be the bare terminator');
});

test('MySQL: shell-substitution payload is inert inside the heredoc body', () => {
  const query = 'SELECT \'$(id)\', `whoami`';
  const cmd = buildMySQLQueryCommand({ database: 'app', query });
  assertEqual(extractHeredocBody(cmd), query, 'payload must be passed verbatim, never shell-evaluated');
});

test('MySQL: non-JSON format also uses the heredoc', () => {
  const query = 'SELECT * FROM `t`';
  const cmd = buildMySQLQueryCommand({ database: 'app', query, format: 'text' });
  assertEqual(extractHeredocBody(cmd), query, 'non-json body must equal the query');
  assertTrue(!cmd.includes('-e "'), 'non-json must not use -e "..."');
  assertTrue(!/\| awk /.test(cmd), 'non-json must not pipe through awk');
});

// --- PostgreSQL ---

test('PostgreSQL: query carried via heredoc, not -c "..."', () => {
  const query = 'SELECT * FROM "weird-table" WHERE x = $1';
  const cmd = buildPostgreSQLQueryCommand({ database: 'app', query });
  assertEqual(extractHeredocBody(cmd), query, 'pg heredoc body must equal the query');
  assertTrue(!cmd.includes('-c "'), 'must not interpolate query into -c "..."');
});

// --- MongoDB ---

test('MongoDB: find script carried via heredoc, not --eval "..."', () => {
  const query = '{name: "a`b`c"}';
  const cmd = buildMongoDBQueryCommand({ database: 'app', collection: 'users', query });
  const body = extractHeredocBody(cmd);
  assertEqual(body, `db.users.find(${query}).forEach(printjson)`, 'mongo body must embed query verbatim');
  assertTrue(!cmd.includes('--eval "'), 'must not interpolate query into --eval "..."');
});

test('MongoDB: empty query defaults to find({})', () => {
  const cmd = buildMongoDBQueryCommand({ database: 'app', collection: 'users' });
  assertEqual(extractHeredocBody(cmd), 'db.users.find({}).forEach(printjson)', 'default find must be {}');
});

// --- buildHeredoc defensive guard ---

test('buildHeredoc throws when the body contains a delimiter-only line', () => {
  let threw = false;
  try {
    buildHeredoc(`SELECT 1\n${DELIM}\nSELECT 2`);
  } catch {
    threw = true;
  }
  assertTrue(threw, 'a body line equal to the delimiter must be rejected');
});

test('buildHeredoc emits the pipeline on the opening line', () => {
  const frag = buildHeredoc('SELECT 1', { pipeline: '| awk "{print}"' });
  assertTrue(frag.startsWith(` <<'${DELIM}' | awk "{print}"\n`), 'pipeline must follow the marker on line one');
  assertTrue(frag.endsWith(`\n${DELIM}`), 'fragment must end with the bare terminator');
});

// --- Stochastic: random metacharacter-laden queries are delivered verbatim ---

test('stochastic: random shell-metacharacter queries round-trip verbatim through the heredoc', () => {
  // Single-line tokens only (heredoc bodies are line-oriented); include the metacharacters
  // that the old double-quoted construction would have evaluated.
  const alphabet = 'abcXYZ012 .`$()\'"-_*=,;:[]{}';
  const randToken = () => {
    const len = 1 + Math.floor(Math.random() * 12);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };

  for (let i = 0; i < 500; i++) {
    // Build a SELECT query that passes isSafeQuery (starts with SELECT, no mutating keywords).
    const query = `SELECT ${randToken()} ${randToken()}`;
    const cmd = buildMySQLQueryCommand({ database: 'db', query });
    assertEqual(extractHeredocBody(cmd), query, `iteration ${i}: body must equal query verbatim`);
    // The terminator must remain alone on the final line (never broken by the payload).
    assertEqual(cmd.split('\n').pop(), DELIM, `iteration ${i}: terminator must stay on its own line`);
  }
});

console.log('\n' + YELLOW + 'Results:' + NC);
console.log(`  ${GREEN}Passed: ${passedTests}${NC}`);
console.log(`  ${RED}Failed: ${failedTests}${NC}`);

if (failedTests > 0) process.exit(1);
