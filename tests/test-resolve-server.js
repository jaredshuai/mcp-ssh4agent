/**
 * Regression tests for the single server resolution interface (issue #1).
 *
 * A bare `servers[name.toLowerCase()]` lookup skips alias expansion, so a
 * server reached via alias looks unconfigured → evaluatePolicy(null) degrades
 * to unrestricted → readonly/restricted policies are silently bypassed, and
 * defaultDir is lost. resolveServer() is the one path that must not have that
 * hole.
 */

import { resolveServer, resolveServerName } from '../src/server-aliases.ts';
import { evaluatePolicy } from '../src/policy.ts';

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
    throw new Error(
      `${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`
    );
  }
}

function assertTrue(cond, message) {
  if (!cond) throw new Error(message);
}

console.log(
  '\n' + YELLOW + 'Running resolveServer tests (issue #1: alias policy bypass)...' + NC + '\n'
);

const ALIASES = { prod: 'production-web', staging_alias: 'staging' };

const SERVERS = {
  'production-web': {
    name: 'production-web',
    host: '10.0.0.1',
    mode: 'readonly',
    defaultDir: '/srv/app',
    platform: 'linux',
  },
  staging: {
    name: 'staging',
    host: '10.0.0.2',
    defaultDir: '/opt/staging',
    platform: 'windows',
  },
};

// ── resolution basics ─────────────────────────────────────────────────────────

test('resolveServer expands an alias to name + config', () => {
  const resolved = resolveServer('prod', SERVERS, ALIASES);
  assertEqual(resolved.name, 'production-web', 'alias should resolve to canonical name');
  assertEqual(resolved.config.host, '10.0.0.1', 'config should be the real server config');
});

test('resolveServer resolves a direct name (case-insensitive)', () => {
  const resolved = resolveServer('Production-Web', SERVERS, ALIASES);
  assertEqual(resolved.name, 'production-web', 'direct name should resolve');
  assertEqual(resolved.config.mode, 'readonly', 'config fields intact');
});

test('resolveServer returns null for an unknown name', () => {
  const resolved = resolveServer('no-such-server', SERVERS, ALIASES);
  assertTrue(resolved === null, 'unknown name should resolve to null');
});

// ── the security hole this issue is about ─────────────────────────────────────

test('readonly policy is NOT bypassed via alias (the issue #1 regression)', () => {
  // The old bug: servers['prod'] → undefined → evaluatePolicy(null) → allowed.
  const resolved = resolveServer('prod', SERVERS, ALIASES);
  const policy = evaluatePolicy(resolved?.config, 'ssh_upload');
  assertEqual(policy.allowed, false, 'mutating tool must be denied through an alias');
  assertTrue(
    policy.reason.includes('readonly'),
    `denial reason should mention readonly mode, got: ${policy.reason}`
  );
});

test('readonly command denylist applies through an alias', () => {
  const resolved = resolveServer('prod', SERVERS, ALIASES);
  const policy = evaluatePolicy(resolved?.config, 'ssh_execute', 'rm -rf /tmp/x');
  assertEqual(policy.allowed, false, 'destructive command must be denied through an alias');
});

test('read-only tool still allowed through an alias on a readonly server', () => {
  const resolved = resolveServer('prod', SERVERS, ALIASES);
  const policy = evaluatePolicy(resolved?.config, 'ssh_execute', 'ls -la');
  assertEqual(policy.allowed, true, 'benign command should pass on readonly via alias');
});

// ── defaultDir / platform survive alias resolution ────────────────────────────

test('defaultDir and platform survive alias resolution', () => {
  const resolved = resolveServer('staging_alias', SERVERS, ALIASES);
  assertEqual(resolved.config.defaultDir, '/opt/staging', 'defaultDir must survive');
  assertEqual(resolved.config.platform, 'windows', 'platform must survive');
});

// ── resolveServerName passthrough semantics ───────────────────────────────────

test('resolveServerName keeps ambiguity detection', () => {
  let threw = false;
  try {
    resolveServerName('web', { 'web-a': {}, 'web-b': {} }, ALIASES);
  } catch (e) {
    threw = e.message.includes('Ambiguous');
  }
  assertTrue(threw, 'ambiguous partial match should throw');
});

// ── cased alias targets (PR #9) ───────────────────────────────────────────────

test('cased alias target resolves to the lowercased config key', () => {
  // Config keys are lowercased on load; an alias stored as `web -> Prod-Web`
  // must resolve to `prod-web` or the config lookup misses and a live
  // server is misreported as a stale alias.
  const aliases = { web: 'Prod-Web' };
  const servers = { 'prod-web': { name: 'prod-web', host: '10.0.0.3' } };
  const resolved = resolveServer('web', servers, aliases);
  assertEqual(resolved.name, 'prod-web', 'alias target must be lowercased');
  assertEqual(resolved.config.host, '10.0.0.3', 'config lookup must succeed through the alias');
});

test('Object.prototype names (toString) are not treated as aliases', () => {
  // A bare truthy `aliases[name]` lookup also hits INHERITED properties:
  // aliases['toString'] is a function, and .toLowerCase() on it throws.
  const servers = { toStringsrv: { name: 'toStringsrv', host: '10.0.0.4' } };
  const resolved = resolveServer('toString', servers, {});
  assertEqual(resolved, null, 'inherited property must not resolve as an alias');
});

test('non-string alias targets are skipped, not crashed on', () => {
  const servers = { 'prod-web': { name: 'prod-web', host: '10.0.0.3' } };
  const resolved = resolveServer('bad', servers, { bad: 123 });
  assertEqual(resolved, null, 'malformed alias target falls through to a clean miss');
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${YELLOW}resolveServer tests: ${passedTests} passed, ${failedTests} failed${NC}\n`);
if (failedTests > 0) process.exit(1);
