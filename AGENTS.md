# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

MCP SSH Manager is a Model Context Protocol server that enables any MCP-compatible AI agent to manage multiple SSH connections. It provides tools for executing commands, transferring files, and managing deployments across remote servers.

## Architecture

The system consists of three main components:

1. **MCP Server** (`src/index.ts`): Node.js-based MCP server using the Model Context Protocol SDK
   - Handles SSH connections via ssh2 library
   - Manages connection pooling to avoid reconnecting
   - Provides MCP tools for any AI agent integration (Claude Code, Codex, Cursor, Cline, etc.)
   - Tool definitions live in `src/tools/<group>.ts` (37 tools, 6 groups, see `src/tool-registry.ts`); each group module receives a shared runtime context instead of importing the entry point — see the `ToolContext` interface in `src/tool-registry.ts`

2. **Server Management CLI** (`cli/ssh-manager.ts`, node shebang — native type stripping): interactive CLI for configuration
   - Pure TypeScript (`cli/lib/*.ts`, `cli/commands/*.ts`), run natively by Node — cross-platform, no Bash/Git Bash needed
   - Manages `.env` / TOML server configurations; tests connections; server / group / tool operations

3. **Deployment Helpers** (`src/deploy-helper.ts`, `src/server-aliases.ts`): Advanced features
   - Automated deployment strategies with permission handling
   - Server alias management for simplified access
   - Batch deployment scripts generation

## Commands

### Setup and Installation
```bash
npm install                                    # Install Node.js dependencies
npm run setup-hooks                           # Install git pre-commit hooks (cross-platform TS, no Python)
npm run install-cli                           # Install ssh-manager CLI globally (npm link)
```

> **Cross-platform**: all scripts run via plain `node` on native type stripping (no Bash, no Python, no build step). The `ssh-manager` CLI is TypeScript at `cli/ssh-manager.ts` (node shebang); it runs natively on Windows, macOS, and Linux with no Git Bash/WSL requirement.

### Server Management (TypeScript CLI)
```bash
ssh-manager server add                        # Add a new server
ssh-manager server list                       # List configured servers
ssh-manager server test SERVER                # Test connection to specific server
ssh-manager server remove SERVER              # Remove a server
ssh-manager server show SERVER                 # Show server details
```

### OpenAI Codex Integration
```bash
ssh-manager codex setup                       # Configure for Codex
ssh-manager codex migrate                     # Convert servers to TOML
ssh-manager codex test                        # Test Codex integration
ssh-manager codex convert to-toml            # Convert .env to TOML
ssh-manager codex convert to-env             # Convert TOML to .env
```

### Tool Management (NEW in v3.1)
```bash
ssh-manager tools list                        # Show all tools and status
ssh-manager tools configure                   # Interactive configuration wizard
ssh-manager tools enable <group>              # Enable a tool group
ssh-manager tools disable <group>             # Disable a tool group
ssh-manager tools reset                       # Reset to defaults (all tools)
ssh-manager tools export-claude               # Export auto-approval config
```

**Tool Groups**: core (5), sessions (4), monitoring (6), backup (4), database (4), advanced (14)

**Modes**: all (37 tools, ~43.5k tokens), minimal (5 tools, ~3.5k tokens), custom (variable)

See [docs/TOOL_MANAGEMENT.md](docs/TOOL_MANAGEMENT.md) for complete guide.

### Development and Testing
```bash
npm start                                     # Start MCP server (requires stdin)
npm test                                      # Run the full test suite
npm run typecheck                             # Type-check with tsc (no build, nothing emitted)
npm run test:all                              # Tests + typecheck + validation
npm run validate                              # Run all validation checks (B2: node scripts/validate.ts)
node --check src/index.ts                   # Check source syntax (native type stripping)
```

**Language / typecheck**: the entire server (`src/**/*.ts`, entry `src/index.ts`) is TypeScript run **natively by Node's type stripping** (`engines: ">=23.6.0"`; no tsx, no build, nothing emitted) — `node src/index.ts` is the whole runtime contract. `tsconfig.json` is `noEmit` type-checking only; `allowJs`/`checkJs` cover the plain-JS test files (`tests/**/*.js` is in the include list). Type-stripping caveats apply: only erasable syntax (no enums/namespaces/parameter properties), and relative imports must carry explicit `.ts` extensions. Script/CLI/debug code (`scripts/*.ts`, `cli/**/*.ts`, `debug/*.ts`) runs the same way — plain `node`, no tsx, nothing left in the dependency tree. Baseline is 0 typecheck errors; CI enforces it on Node 24. `typescript` is pinned to `^6` because knip 5 declares `peer typescript ">=5.0.4 <7"` — bumping one requires bumping the other.
New tests default to plain `.js` (checkJs covers them); use `.ts` only when the test itself needs TypeScript syntax.

### Debug Tools (in `debug/` directory)
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

## MCP Tools Available

The server exposes these tools to any MCP-compatible AI agent (Claude Code, Codex, Cursor, Cline, etc.):

### Core Tools
- `ssh_list_servers`: List all configured SSH servers
- `ssh_execute`: Execute commands on remote servers (supports default directories)
- `ssh_upload`: Upload files to remote servers
- `ssh_download`: Download files from remote servers

### Backup & Restore (v2.1+)
- `ssh_backup_create`: Create database or file backups (MySQL, PostgreSQL, MongoDB, Files)
- `ssh_backup_list`: List all available backups with metadata
- `ssh_backup_restore`: Restore from previous backups
- `ssh_backup_schedule`: Schedule automatic backups using cron

### Health & Monitoring (v2.2+)
- `ssh_health_check`: Comprehensive server health check (CPU, RAM, Disk, Network)
- `ssh_service_status`: Check status of services (nginx, mysql, docker, etc.)
- `ssh_process_manager`: List, monitor, or kill processes
- `ssh_alert_setup`: Configure health monitoring alerts and thresholds

### Database Management (v2.3+)
- `ssh_db_dump`: Create database dumps (MySQL, PostgreSQL, MongoDB)
- `ssh_db_import`: Import SQL dumps or restore databases
- `ssh_db_list`: List databases or tables/collections
- `ssh_db_query`: Execute read-only SELECT queries (security validated)

### Deployment & Management
- `ssh_deploy`: Deploy files with automatic permission/backup handling
- `ssh_execute_sudo`: Execute commands with sudo privileges
- `ssh_alias`: Manage server aliases (add/remove/list)
- `ssh_sync`: Bidirectional file synchronization with rsync
- `ssh_monitor`: System resource monitoring
- `ssh_tail`: Real-time log monitoring

### Advanced Features
- `ssh_session_*`: Persistent SSH sessions
- `ssh_tunnel_*`: SSH tunnel management (local/remote/SOCKS)
- `ssh_group_*`: Server group operations
- `ssh_command_alias`: Command alias management
- `ssh_hooks`: Automation hooks
- `ssh_profile`: Profile management

## Server Configuration

### Configuration Formats

MCP SSH Manager supports two configuration formats:

1. **Environment Variables (.env)** - Traditional format, widely supported across agents
2. **TOML** - Modern format (used by OpenAI Codex; also readable by other agents)

### Configuration Loading Priority

The system loads configurations in this order (highest to lowest priority):
1. Environment variables (process.env)
2. `.env` file (resolved via a fallback chain: `SSH_ENV_PATH` env var → `~/.ssh-manager/.env` → `cwd/.env` → `~/.env` → `<project-root>/.env`)
3. TOML file (specified by `SSH_CONFIG_PATH` or `~/.codex/ssh-config.toml`)

### .env Format
```
SSH_SERVER_[NAME]_HOST=hostname
SSH_SERVER_[NAME]_USER=username
SSH_SERVER_[NAME]_PASSWORD=password         # For password auth
SSH_SERVER_[NAME]_KEYPATH=~/.ssh/key       # For SSH key auth
SSH_SERVER_[NAME]_PASSPHRASE=passphrase    # Optional, for passphrase-protected keys
SSH_SERVER_[NAME]_PORT=22                  # Optional
SSH_SERVER_[NAME]_DEFAULT_DIR=/path        # Optional default working directory
SSH_SERVER_[NAME]_SUDO_PASSWORD=pass       # Optional for automated sudo
SSH_SERVER_[NAME]_GROUP=production         # Optional, free-form label for grouping/import-export
SSH_SERVER_[NAME]_PLATFORM=windows         # Optional: "linux" (default) or "windows"
SSH_SERVER_[NAME]_PROXYJUMP=bastion        # Optional: name of another server to use as jump host
SSH_SERVER_[NAME]_PROXYCOMMAND=command      # Optional: custom proxy command (ncat, ssh -W, etc.)
SSH_SERVER_[NAME]_FORWARD_AGENT=true       # Optional: forward local ssh-agent to remote (needs SSH_AUTH_SOCK; security risk)
```

### TOML Format
```toml
[ssh_servers.name]
host = "hostname"
user = "username"
password = "password"                      # For password auth
key_path = "~/.ssh/key"                    # For SSH key auth
passphrase = "key_passphrase"              # Optional, for passphrase-protected keys
port = 22                                  # Optional
default_dir = "/path"                      # Optional default working directory
sudo_password = "pass"                     # Optional for automated sudo
group = "production"                       # Optional, free-form label for grouping/import-export
platform = "windows"                       # Optional: "linux" (default) or "windows"
proxy_jump = "bastion"                     # Optional: name of another server to use as jump host
proxy_command = "command"                   # Optional: custom proxy command (ncat, ssh -W, etc.)
forward_agent = true                       # Optional: forward local ssh-agent to remote (needs SSH_AUTH_SOCK; security risk)
```

## Key Implementation Details

1. **Connection Pooling**: The server maintains persistent SSH connections in a `Map` (the `connections` map in `src/index.ts`) to avoid reconnection overhead

2. **Server Resolution**: Server names are resolved through aliases first, then direct lookup. Names are normalized to lowercase (see `resolveServerName` in `src/server-aliases.ts`)

3. **Default Directories**: If a server has a DEFAULT_DIR configured and no cwd is provided to ssh_execute, commands run in that directory

4. **Deployment Strategy**: The deploy helper detects permission issues and automatically creates scripts for sudo execution when needed

5. **Environment Loading**: Uses dotenv to load configuration from `.env`, resolved via the same fallback chain as the CLI (see `resolveEnvFilePath` in `src/index.ts`; `SSH_ENV_PATH` overrides the chain)

6. **Proxy Command Support**: Custom proxy commands (SOCKS5, ssh -W, etc.) are executed locally to establish connections, with proper error handling and timeout management (see `createProxyCommandSocket` in `src/index.ts`)

7. **Server Groups**: Membership is the union of two sources — the explicit lists in `.server-groups.json` (created via `ssh_group_manage`, which also hold strategy/delay/stopOnError) and the per-server `group` field of the SSH config. Config-derived groups are resolved at read time, never written to `.server-groups.json`, and are read-only for `ssh_group_manage`. `src/index.ts` injects the loaded config into the group layer via `setServerConfigProvider()`; without it the module can only see `.env` servers (src/server-groups.ts)

## Security Considerations

- Never commit `.env` files (included in .gitignore)
- SSH keys preferred over passwords
- Sudo passwords stored separately from regular passwords
- Connection errors logged to stderr for debugging
- Pre-commit hooks check for sensitive data leaks

## Validation and Quality

Run `npm run validate` before commits to check:
- JavaScript syntax validity (`node --check`)
- No `.env` file tracked in git
- MCP server startup
- Dependencies installed

Install the git hook once with `npm run setup-hooks` to run typecheck + validate automatically before each commit.

CI (GitHub Actions): pushes to `main` run the Tests and Code Quality workflows on Node 24 (`.github/workflows/`). Both also accept `workflow_dispatch`, so they can be triggered manually — `gh workflow run "Tests" --ref main`.

## AI Agent Integration

This server is MCP-compatible, so any agent that speaks MCP can drive it. Each agent has its own install path — the entry point is always `node src/index.ts`; only the registration command differs.

**Claude Code:**
```bash
claude mcp add ssh-manager node /absolute/path/to/mcp-ssh-manager/src/index.ts
```
Config stored at `~/.config/claude-code/claude_code_config.json`

**OpenAI Codex:** run `ssh-manager codex setup` (writes TOML to `~/.codex/ssh-config.toml`).

**Other agents (Cursor, Cline, etc.):** point their MCP client at `node /absolute/path/to/mcp-ssh-manager/src/index.ts` and pass servers via `.env` or `SSH_CONFIG_PATH`.

## Agent skills

### Commit identity

This machine has no `git user.name`/`user.email` configured, and agents must never modify git config. Resolve the commit identity through `gh` (already authenticated):

1. `gh api user --jq "{login, id}"` → e.g. `{"login":"jaredshuai","id":17944691}`
2. Derive the privacy-preserving noreply email: `<id>+<login>@users.noreply.github.com`
3. Commit with one-shot env vars (no config change): `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`

Prefer `git commit -F <msgfile>` over inline here-strings — multi-line `-m` arguments are unreliable in PowerShell.

### Issue tracker

GitHub issues (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
