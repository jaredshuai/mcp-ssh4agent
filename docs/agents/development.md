# Agent Development & Commands Reference (docs/agents/development.md)

This document provides detailed development commands, CLI operations, debug helpers, and implementation details for AI agents working in this codebase.

## 1. Setup and Installation

```bash
npm install                                    # Install Node.js dependencies
npm run setup-hooks                           # Install git pre-commit hooks (cross-platform TS, no Python)
npm run install-cli                           # Install ssh4agent CLI globally (npm link)
```

> **Cross-platform**: all scripts run via plain `node` on native type stripping (no Bash, no Python, no build step). The `ssh4agent` CLI is TypeScript at `cli/ssh-manager.ts` (node shebang); it runs natively on Windows, macOS, and Linux with no Git Bash/WSL requirement.

## 2. Server Management CLI

```bash
ssh4agent server add                        # Add a new server
ssh4agent server list                       # List configured servers
ssh4agent server test SERVER                # Test connection to specific server
ssh4agent server remove SERVER              # Remove a server
ssh4agent server show SERVER                 # Show server details
```

## 3. OpenAI Codex Integration

```bash
ssh4agent codex setup                       # Configure for Codex
ssh4agent codex migrate                     # Convert servers to TOML
ssh4agent codex test                        # Test Codex integration
ssh4agent codex convert to-toml            # Convert .env to TOML
ssh4agent codex convert to-env             # Convert TOML to .env
```

## 4. Tool Management CLI

```bash
ssh4agent tools list                        # Show all tools and status
ssh4agent tools configure                   # Interactive configuration wizard
ssh4agent tools enable <group>              # Enable a tool group
ssh4agent tools disable <group>             # Disable a tool group
ssh4agent tools reset                       # Reset to defaults (all tools)
ssh4agent tools export-claude               # Export auto-approval config
```

**Tool Groups**: core (5), sessions (4), monitoring (6), backup (4), database (4), advanced (14)
**Modes**: all (37 tools, ~43.5k tokens), minimal (5 tools, ~3.5k tokens), custom (variable)
See [docs/TOOL_MANAGEMENT.md](../TOOL_MANAGEMENT.md) for complete guide.

## 5. Development and Testing

```bash
npm start                                     # Start MCP server (requires stdin)
npm test                                      # Run the full test suite (28 suites)
npm run typecheck                             # Type-check with tsc (no build, nothing emitted)
npm run test:all                              # Tests + typecheck + validation
npm run validate                              # Run all validation checks (node scripts/validate.ts)
npm run lint                                  # Biome lint (src/, tests/, cli/, scripts/, debug/)
npm run lint:fix                              # Biome check --write: safe fixes + formatting
npm run format                                # Biome format --write
node --check src/index.ts                   # Check source syntax (native type stripping)
```

**Language / typecheck**: the entire server (`src/**/*.ts`, entry `src/index.ts`) is TypeScript run **natively by Node's type stripping** (dev tree needs Node ≥23.6; no tsx, no build, nothing emitted in-repo) — `node src/index.ts` is the whole development runtime contract. Exception for publishing only: the npm artifact is compiled to JS by `tsc -p tsconfig.build.json` on `prepack` (Node refuses type stripping under `node_modules`), so consumers need only Node ≥20 (`engines`). `tsconfig.json` is `noEmit` type-checking only; `allowJs`/`checkJs` cover the plain-JS test files (`tests/**/*.js` is in the include list). Type-stripping caveats apply: only erasable syntax (no enums/namespaces/parameter properties), and relative imports must carry explicit `.ts` extensions. Script/CLI/debug code (`scripts/*.ts`, `cli/**/*.ts`, `debug/*.ts`) runs the same way — plain `node`, no tsx, nothing left in the dependency tree. Baseline is 0 typecheck errors; CI enforces it on Node 24. `typescript` is pinned to `^6` because knip 5 declares `peer typescript ">=5.0.4 <7"` — bumping one requires bumping the other.
New tests default to plain `.js` (checkJs covers them); use `.ts` only when the test itself needs TypeScript syntax.

## 6. Debug Tools (in `debug/` directory)

```bash
node debug/test-claude-code.ts        # Test Claude Code integration (TypeScript, cross-platform)
node debug/test-mcp.ts                # Test MCP connection (initialize + tools/list via SDK client)
node debug/test-ssh-command.ts        # Test SSH command execution (skips when no server configured)
node debug/test-groups.ts             # Print ssh_group_* usage examples and execution strategies
node debug/test-monitoring.ts         # Print ssh_tail / ssh_monitor usage (writes a sample log to temp)
node debug/test-sessions.ts           # Print ssh_session_* usage and session features
node debug/test-sync.ts               # Print ssh_sync usage (creates a demo tree in temp)
node debug/test-tunnels.ts            # Print ssh_tunnel_* usage and common scenarios
```

## 7. Key Implementation Details

1. **Connection Pooling**: The server maintains persistent SSH connections in the `ConnectionPool` class (`src/connection-pool.ts`, instantiated as `pool` in `src/index.ts`) to avoid reconnection overhead; tools reach pooling state only through that instance.
2. **Server Resolution**: Server names are resolved through aliases first, then direct lookup. Names are normalized to lowercase (see `resolveServerName` in `src/server-aliases.ts`).
3. **Default Directories**: If a server has a DEFAULT_DIR configured and no cwd is provided to ssh_execute, commands run in that directory.
4. **Deployment Strategy**: The deploy helper detects permission issues and automatically creates scripts for sudo execution when needed.
5. **Environment Loading**: Uses dotenv to load configuration from `.env`, resolved via the fallback chain: `SSH_ENV_PATH` env var → `~/.ssh4agent/.env` → `cwd/.env` → `~/.env` → `<project-root>/.env`.
6. **Proxy Command Support**: Custom proxy commands (SOCKS5, ssh -W, etc.) are executed locally to establish connections, with proper error handling and timeout management (see `createProxyCommandSocket` in `src/proxy-command.ts`).
7. **Server Groups**: Membership is the union of two sources — the explicit lists in `.server-groups.json` and the per-server `group` field of the SSH config. Config-derived groups are resolved at read time, never written to `.server-groups.json`, and are read-only for `ssh_group_manage`.
