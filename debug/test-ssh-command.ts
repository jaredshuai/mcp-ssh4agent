// Debug helper: run one real ssh_execute round-trip through the MCP server.
// Run via: `node debug/test-ssh-command.ts`
//
// The old test-ssh-command.js had been broken since the initial commit (wrong
// entry path + newline-delimited JSON-RPC instead of MCP's Content-Length
// framing) and hardcoded a "production" server. This rewrite uses the official
// SDK client and probes whatever server the environment actually configures.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const NC = '\x1b[0m';
const ok = (m: string) => console.log(`${GREEN}✅${NC} ${m}`);
const fail = (m: string) => console.log(`${RED}❌${NC} ${m}`);

// debug/test-ssh-command.ts → debug → <project root>
const _HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(_HERE);

console.log('🔧 Testing ssh_execute through the MCP server');
console.log('==============================================');
console.log('');

// Pick the first server configured via SSH_SERVER_<NAME>_HOST environment
// variables — the same source the server itself reads at highest priority.
const configured = Object.keys(process.env)
  .filter((key) => /^SSH_SERVER_[A-Z0-9_]+_HOST$/.test(key))
  .map((key) => key.slice('SSH_SERVER_'.length, -'_HOST'.length).toLowerCase());

if (configured.length === 0) {
  console.log('⏭️  Skip: no configured servers (set SSH_SERVER_<NAME>_HOST first).');
  process.exit(0);
}

const serverName = configured[0];
ok(`using server "${serverName}" (${configured.length} configured)`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, 'src', 'index.ts')],
  cwd: PROJECT_ROOT,
  stderr: 'ignore',
  // The transport's default env is a sudo-style whitelist that drops
  // SSH_SERVER_*; the whole point here is passing those through.
  env: { ...process.env },
});

const client = new Client({ name: 'debug-test-ssh-command', version: '1.0.0' });

try {
  await client.connect(transport);
  ok('connected to MCP server');

  const result = await client.callTool({
    name: 'ssh_execute',
    arguments: { server: serverName, command: 'hostname && whoami' },
  });

  // Without generics callTool yields unknown content; this helper only reads text blocks.
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

  if (result.isError) {
    throw new Error(text || 'ssh_execute returned an error with no message');
  }

  ok('ssh_execute round-trip ok. Remote said:');
  console.log(text.trim());
  console.log('');

  await client.close();
  console.log('✅ ssh_execute test complete.');
  process.exit(0);
} catch (error) {
  fail(`ssh_execute test failed: ${error instanceof Error ? error.message : String(error)}`);
  try {
    await client.close();
  } catch {
    // transport already gone — nothing to clean up
  }
  process.exit(1);
}
