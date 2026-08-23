/**
 * Config unification tests (issue #7).
 *
 * The CLI and the MCP server used to resolve the .env path and parse server
 * entries independently (two chains, two parsers, drifted semantics). Now
 * there is one chain (src/env-path.ts) and one parser core
 * (parseEnvServersText in src/server-fields.ts, also backing the CLI's
 * get_server_config). These tests pin the equivalence.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveEnvFilePath } from '../src/env-path.ts';
import { parseEnvServersText } from '../src/server-fields.ts';
import { ConfigLoader } from '../src/config-loader.ts';

let passed = 0;
function ok(label) {
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

const ENV_CONTENT = [
  '# test config',
  '',
  '# Server: quoted_srv',
  'SSH_SERVER_QUOTED_SRV_HOST=10.2.3.4',
  'SSH_SERVER_QUOTED_SRV_USER=deploy user', // unquoted value with space
  'SSH_SERVER_QUOTED_SRV_PORT=2222',
  'SSH_SERVER_QUOTED_SRV_PASSWORD="pa$s \'word\'"', // double-quoted (writer format)
  'SSH_SERVER_QUOTED_SRV_DESCRIPTION="prod #42 server"', // quoted value containing #
  'SSH_SERVER_QUOTED_SRV_DEFAULT_DIR=/srv/app',
  'SSH_SERVER_QUOTED_SRV_KEYPATH=~/.ssh/id_ed25519',
  '',
  '# Server: minimal',
  'SSH_SERVER_MINIMAL_HOST=10.9.9.9',
  'SSH_SERVER_MINIMAL_USER=root',
  '',
].join('\n');

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-unify-'));
  const envPath = path.join(home, '.env');
  fs.writeFileSync(envPath, ENV_CONTENT, 'utf8');

  // ── one path chain, shared ──────────────────────────────────────────────
  process.env.SSH_ENV_PATH = envPath;
  assert.strictEqual(resolveEnvFilePath(), envPath, 'SSH_ENV_PATH wins');
  delete process.env.SSH_ENV_PATH;

  process.env.SSH4AGENT_ENV = envPath; // deprecated CLI alias still honored
  assert.strictEqual(resolveEnvFilePath(), envPath, 'SSH4AGENT_ENV alias works');
  delete process.env.SSH4AGENT_ENV;

  process.env.SSH4AGENT_HOME = home;
  assert.strictEqual(
    resolveEnvFilePath(),
    path.join(home, '.env'),
    'falls back to $SSH4AGENT_HOME/.env'
  );
  delete process.env.SSH4AGENT_HOME;
  ok('resolveEnvFilePath: one chain, both override names, home fallback');

  // ── one parser: parseEnvServersText === ConfigLoader.loadEnvConfig ──────
  const loader = new ConfigLoader();
  loader.loadEnvConfig(envPath);
  const loaderServers = loader.servers; // Map<lower, ServerConfig>

  const parsed = parseEnvServersText(ENV_CONTENT);

  assert.deepStrictEqual(
    [...parsed.keys()].sort(),
    [...loaderServers.keys()].sort(),
    'same server set discovered'
  );

  const loaderSrv = loaderServers.get('quoted_srv');
  const parsedSrv = parsed.get('quoted_srv');
  for (const field of [
    'host',
    'user',
    'port',
    'password',
    'description',
    'defaultDir',
    'keyPath',
  ]) {
    assert.deepStrictEqual(
      parsedSrv[field],
      loaderSrv[field],
      `field ${field} must match between CLI parser and MCP loader`
    );
  }
  assert.strictEqual(parsedSrv.port, 2222, 'port coerced to number');
  assert.strictEqual(parsedSrv.password, "pa$s 'word'", 'quoted password unquoted');
  assert.strictEqual(parsedSrv.description, 'prod #42 server', '# inside quotes preserved');
  ok('parseEnvServersText matches ConfigLoader field-for-field (quoting included)');

  // ── CLI accessor reads through the shared parser ────────────────────────
  // Import AFTER pointing the CLI config at the temp file (module computes
  // SSH4AGENT_ENV at import time).
  process.env.SSH4AGENT_HOME = home;
  const cliConfig = await import('../cli/lib/config.ts');

  assert.strictEqual(cliConfig.SSH4AGENT_ENV, envPath, 'CLI resolves the same .env file');
  assert.strictEqual(cliConfig.get_server_config('quoted_srv', 'HOST'), '10.2.3.4');
  assert.strictEqual(
    cliConfig.get_server_config('QUOTED_SRV', 'HOST'),
    '10.2.3.4',
    'name case-insensitive'
  );
  assert.strictEqual(cliConfig.get_server_config('quoted_srv', 'USER'), 'deploy user');
  assert.strictEqual(cliConfig.get_server_config('quoted_srv', 'PASSWORD'), "pa$s 'word'");
  assert.strictEqual(cliConfig.get_server_config('quoted_srv', 'DEFAULT_DIR'), '/srv/app');
  assert.strictEqual(cliConfig.get_server_config('quoted_srv', 'KEYPATH'), '~/.ssh/id_ed25519');
  assert.strictEqual(
    cliConfig.get_server_config('minimal', 'PORT'),
    null,
    'absent PORT stays null (callers default it)'
  );
  assert.strictEqual(cliConfig.get_server_config('no-such', 'HOST'), null);
  ok('CLI get_server_config reads the shared parse (quote/spacing/# semantics)');

  // ── resolveServerToSshArgs: the one ssh-arg resolution ──────────────────
  const target = cliConfig.resolveServerToSshArgs('quoted_srv');
  assert.deepStrictEqual(target, {
    host: '10.2.3.4',
    user: 'deploy user',
    port: '2222',
    keypath: '~/.ssh/id_ed25519',
    password: "pa$s 'word'",
  });
  assert.strictEqual(
    cliConfig.resolveServerToSshArgs('minimal').port,
    '22',
    'missing PORT defaults to 22'
  );
  assert.strictEqual(cliConfig.resolveServerToSshArgs('no-such'), null, 'unknown server → null');
  ok('resolveServerToSshArgs resolves dial coordinates once for all callers');

  delete process.env.SSH4AGENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n✅ config unification tests passed (${passed} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
