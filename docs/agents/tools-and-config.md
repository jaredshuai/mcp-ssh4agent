# Agent Tools & Configuration Reference (docs/agents/tools-and-config.md)

This document contains the complete reference for all 37 MCP tools, server configuration formats (.env and TOML), priority chains, and security considerations.

## 1. MCP Tools Available (37 Tools in 6 Groups)

### Core Tools (5)
- `ssh_list_servers`: List all configured SSH servers
- `ssh_execute`: Execute commands on remote servers (supports default directories)
- `ssh_upload`: Upload files to remote servers
- `ssh_download`: Download files from remote servers

### Backup & Restore (4)
- `ssh_backup_create`: Create database or file backups (MySQL, PostgreSQL, MongoDB, Files)
- `ssh_backup_list`: List all available backups with metadata
- `ssh_backup_restore`: Restore from previous backups
- `ssh_backup_schedule`: Schedule automatic backups using cron

### Health & Monitoring (6)
- `ssh_health_check`: Comprehensive server health check (CPU, RAM, Disk, Network)
- `ssh_service_status`: Check status of services (nginx, mysql, docker, etc.)
- `ssh_process_manager`: List, monitor, or kill processes
- `ssh_alert_setup`: Configure health monitoring alerts and thresholds

### Database Management (4)
- `ssh_db_dump`: Create database dumps (MySQL, PostgreSQL, MongoDB)
- `ssh_db_import`: Import SQL dumps or restore databases
- `ssh_db_list`: List databases or tables/collections
- `ssh_db_query`: Execute read-only SELECT queries (security validated)

### Deployment & Management (4)
- `ssh_deploy`: Deploy files with automatic permission/backup handling
- `ssh_execute_sudo`: Execute commands with sudo privileges
- `ssh_alias`: Manage server aliases (add/remove/list)
- `ssh_sync`: Bidirectional file synchronization with rsync
- `ssh_monitor`: System resource monitoring
- `ssh_tail`: Real-time log monitoring

### Advanced Features (14)
- `ssh_session_*`: Persistent SSH sessions
- `ssh_tunnel_*`: SSH tunnel management (local/remote/SOCKS)
- `ssh_group_*`: Server group operations
- `ssh_command_alias`: Command alias management
- `ssh_hooks`: Automation hooks
- `ssh_profile`: Profile management

## 2. Server Configuration

### Configuration Formats

MCP SSH4Agent supports two configuration formats:
1. **Environment Variables (.env)** - Traditional format, widely supported across agents
2. **TOML** - Modern format (used by OpenAI Codex; also readable by other agents)

### Configuration Loading Priority

The system loads configurations in this order (highest to lowest priority):
1. Environment variables (`process.env`)
2. `.env` file (resolved via fallback chain: `SSH_ENV_PATH` env var → `~/.ssh4agent/.env` → `cwd/.env` → `~/.env` → `<project-root>/.env`)
3. TOML file (specified by `SSH_CONFIG_PATH` or `~/.codex/ssh-config.toml`)

### .env Format

```env
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
proxy_jump = "bastion"                     # Optional: another server as jump host (tunnels: one hop only)
proxy_command = "command"                   # Optional: custom proxy command (ncat, ssh -W, etc.)
forward_agent = true                       # Optional: forward local ssh-agent to remote (needs SSH_AUTH_SOCK; security risk)
```

## 3. Security Considerations

- Never commit `.env` files (included in `.gitignore`)
- SSH keys preferred over passwords
- Sudo passwords stored separately from regular passwords
- Connection errors logged to stderr for debugging
- Pre-commit hooks check for sensitive data leaks
- See [docs/SECURITY_MODES.md](../SECURITY_MODES.md) for per-server `readonly` and `restricted` execution policies.
