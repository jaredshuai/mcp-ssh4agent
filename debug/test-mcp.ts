// Debug helper: boot the real MCP server over stdio and verify the handshake.
// Run via: `node debug/test-mcp.ts`
//
// The old test-mcp.js had been broken since the initial commit (wrong entry
// path + newline-delimited JSON-RPC instead of MCP's Content-Length framing),
// so it never actually talked to the server. This rewrite uses the official
// SDK client, which speaks the protocol correctly.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const NC = '\x1b[0m';
const ok = (m: string) => console.log(`${GREEN}✅${NC} ${m}`);
const fail = (m: string) => console.log(`${RED}❌${NC} ${m}`);

// debug/test-mcp.ts → debug → <project root>
const _HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(_HERE);

console.log('🔧 Testing MCP SSH Manager server over stdio');
console.log('=============================================');
console.log('');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, 'src', 'index.ts')],
  cwd: PROJECT_ROOT,
  stderr: 'ignore',
  // Full env: the transport's default whitelist would drop SSH_SERVER_*.
  env: { ...process.env },
});

const client = new Client({ name: 'debug-test-mcp', version: '1.0.0' });

try {
  await client.connect(transport);

  const serverInfo = client.getServerVersion();
  if (serverInfo?.name && serverInfo?.version) {
    ok(`initialize handshake ok: ${serverInfo.name} ${serverInfo.version}`);
  } else {
    throw new Error('server did not report serverInfo in initialize');
  }

  const listed = await client.listTools();
  if (listed.tools.length < 1) {
    throw new Error('tools/list returned no tools');
  }
  ok(`tools/list returned ${listed.tools.length} tools (first: ${listed.tools[0]?.name})`);

  await client.close();
  console.log('');
  console.log('✅ MCP server test complete.');
  process.exit(0);
} catch (error) {
  fail(`MCP server test failed: ${error instanceof Error ? error.message : String(error)}`);
  try {
    await client.close();
  } catch {
    // transport already gone — nothing to clean up
  }
  process.exit(1);
}
