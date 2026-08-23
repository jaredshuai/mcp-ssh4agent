// Codex integration commands for ssh4agent CLI: setup / migrate / test /
// convert. Wires the ConfigLoader primitives (src/config-loader.ts) to the
// documented command surface:
//   setup    → saveToCodexConfig   (register the MCP entry in Codex config)
//   migrate  → migrateEnvToToml    (move .env servers into TOML)
//   test     → boot the registered MCP entry and verify the handshake
//   convert  → exportToToml / loadTomlConfig + exportToEnv

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import TOML from '@iarna/toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConfigLoader } from '../../src/config-loader.ts';
import { print_error, print_info, print_success, print_warning } from '../lib/colors.ts';
import { SSH4AGENT_ENV } from '../lib/config.ts';

// Where Codex reads its own config (setup / test target).
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
// Where SSH servers live in TOML form (migrate / convert target) — same
// default saveToCodexConfig writes into the entry's SSH_CONFIG_PATH.
const SSH_TOML_PATH =
  process.env.SSH_CONFIG_PATH || path.join(os.homedir(), '.codex', 'ssh-config.toml');

function codexUsage(): void {
  print_error('Usage: ssh4agent codex <action>');
  process.stdout.write('\n');
  process.stdout.write('Actions:\n');
  process.stdout.write('  setup                          Configure for Codex\n');
  process.stdout.write('  migrate [env] [toml]           Convert servers to TOML\n');
  process.stdout.write('  test                           Test Codex integration\n');
  process.stdout.write('  convert to-toml [env] [toml]   Convert .env to TOML\n');
  process.stdout.write('  convert to-env [toml] [env]    Convert TOML to .env\n');
}

export async function cmd_codex_setup(configPath?: string): Promise<void> {
  const target = configPath ?? CODEX_CONFIG_PATH;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const loader = new ConfigLoader();
  await loader.saveToCodexConfig(target);
  print_success(`Updated Codex configuration at ${target}`);
  print_info(`Add servers to ${SSH_TOML_PATH}, or migrate from .env: ssh4agent codex migrate`);
}

export async function cmd_codex_migrate(envPath?: string, tomlPath?: string): Promise<void> {
  const src = envPath ?? SSH4AGENT_ENV;
  const dst = tomlPath ?? SSH_TOML_PATH;
  if (!fs.existsSync(src)) {
    print_error(`.env file not found: ${src}`);
    process.exitCode = 1;
    return;
  }
  const loader = new ConfigLoader();
  const count = await loader.migrateEnvToToml(src, dst);
  if (count === 0) {
    print_warning(`No servers found in ${src} — nothing was migrated`);
    return;
  }
  print_success(`Migrated ${count} server(s) from ${src} to ${dst}`);
}

export async function cmd_codex_convert(sub?: string, src?: string, dst?: string): Promise<void> {
  if (sub === 'to-toml') {
    await cmd_codex_migrate(src, dst);
    return;
  }
  if (sub === 'to-env') {
    const tomlSrc = src ?? SSH_TOML_PATH;
    if (!fs.existsSync(tomlSrc)) {
      print_error(`TOML file not found: ${tomlSrc}`);
      process.exitCode = 1;
      return;
    }
    // Fresh loader (empty server map) so the export reflects only the TOML
    // source — matches the clear-then-load semantics of migrateEnvToToml.
    const loader = new ConfigLoader();
    await loader.loadTomlConfig(tomlSrc);
    const out = dst ?? SSH4AGENT_ENV;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, loader.exportToEnv(), 'utf8');
    print_success(`Exported ${loader.servers.size} server(s) from ${tomlSrc} to ${out}`);
    return;
  }
  print_error(`Unknown convert direction: ${sub ?? ''}`);
  process.stdout.write('Usage: ssh4agent codex convert <to-toml|to-env> [source] [destination]\n');
  process.exitCode = 1;
}

export async function cmd_codex_test(configPath?: string): Promise<void> {
  const cfgPath = configPath ?? CODEX_CONFIG_PATH;
  if (!fs.existsSync(cfgPath)) {
    print_error(`Codex config not found: ${cfgPath}`);
    print_info('Run: ssh4agent codex setup');
    process.exitCode = 1;
    return;
  }

  // The entry holds command/args/env; TOML values are untyped, hence `any`.
  let entry: any;
  try {
    const config = TOML.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, any>;
    entry = config.mcp_servers?.ssh4agent;
  } catch (error) {
    print_error(`Failed to parse ${cfgPath}: ${(error as Error).message}`);
    print_info('Run: ssh4agent codex setup');
    process.exitCode = 1;
    return;
  }

  if (!entry) {
    print_error(`No [mcp_servers.ssh4agent] entry in ${cfgPath}`);
    print_info('Run: ssh4agent codex setup');
    process.exitCode = 1;
    return;
  }

  const timeoutMs = Number(entry.startup_timeout_ms ?? 20000);
  // Known limitation: a hand-written `command = "npx"` entry may fail to
  // spawn on Windows (npx is a .cmd shim). The default generated entry uses
  // `node`, which spawns fine everywhere.
  const transport = new StdioClientTransport({
    command: entry.command ?? 'node',
    args: entry.args ?? [],
    // Full ambient env: the transport's default whitelist would drop the
    // variables the server needs (same lesson as debug/test-mcp.ts).
    env: { ...process.env, ...(entry.env ?? {}) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'ssh4agent-codex-test', version: '1.0.0' });

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP handshake timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    const serverInfo = client.getServerVersion();
    if (!serverInfo?.name || !serverInfo?.version) {
      throw new Error('server did not report serverInfo in initialize');
    }
    const listed = await client.listTools();
    print_success(
      `Codex integration OK: ${serverInfo.name} v${serverInfo.version} — ${listed.tools.length} tools available`
    );
  } catch (error) {
    print_error(
      `Codex integration test failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  } finally {
    try {
      await client.close();
    } catch {
      // transport already gone — nothing to clean up
    }
  }
}

export async function cmd_codex(sub?: string, ...rest: string[]): Promise<void> {
  switch (sub) {
    case 'setup':
      await cmd_codex_setup(rest[0]);
      return;
    case 'migrate':
      await cmd_codex_migrate(rest[0], rest[1]);
      return;
    case 'test':
      await cmd_codex_test(rest[0]);
      return;
    case 'convert':
      await cmd_codex_convert(rest[0], rest[1], rest[2]);
      return;
    case undefined:
    case '':
      codexUsage();
      process.exitCode = 1;
      return;
    default:
      print_error(`Unknown codex command: ${sub}`);
      codexUsage();
      process.exitCode = 1;
  }
}
