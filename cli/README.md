# SSH4Agent CLI

A simple, powerful, and fast cross-platform CLI for managing SSH servers.

## Features

- 🚀 **Fast**: Pure TypeScript, run natively by Node type stripping (no build step)
- 🎨 **Beautiful**: Colored output with emojis
- 📦 **Simple**: Single command for all operations
- 🔧 **Powerful**: Tunnels, sync, monitoring, and more
- 🔌 **Integrated**: Works with MCP SSH4Agent server
- 🪟 **Cross-platform**: Runs natively on Windows, macOS, and Linux — no Bash/Git Bash/WSL required

## Installation

### Quick Install

```bash
# From the project root
npm run install-cli     # checks deps + `npm link` (creates the ssh4agent shim)
```

### Manual Run (no global install)

```bash
node cli/ssh-manager.ts --help
```

### Dependencies

**Required:**
- Node.js (>=23.6) and `npm`
- `ssh`

**Optional:**
- `rsync` - For `ssh4agent sync` (not bundled on Windows; install separately if needed)
- `sshpass` - For password authentication testing

## Usage

### Server Management

```bash
# Add a new server interactively
ssh4agent server add

# List all servers
ssh4agent server list

# Test connection
ssh4agent server test prod1

# Show server details
ssh4agent server show prod1

# Remove a server
ssh4agent server remove prod1

# Edit configuration
ssh4agent server edit
```

### Quick SSH Connection

```bash
# Connect to a server
ssh4agent ssh prod1
```

### File Synchronization

```bash
# Push files to server
ssh4agent sync push prod1 ./app /var/www/app

# Pull files from server
ssh4agent sync pull prod1 /var/log/app.log ./logs/
```

### SSH Tunnels

```bash
# Local port forwarding (access remote service locally)
ssh4agent tunnel create prod1 local 3307:localhost:3306

# Remote port forwarding (expose local service)
ssh4agent tunnel create prod1 remote 8080:localhost:8080

# SOCKS proxy
ssh4agent tunnel create prod1 dynamic 1080

# List active tunnels
ssh4agent tunnel list
```

### Execute Commands

```bash
# Run command on server
ssh4agent exec prod1 "uptime"

# Run complex commands
ssh4agent exec prod1 "df -h | grep /var"
```

## Configuration

### Server Configuration (.env)

Servers are stored in a `.env` file resolved through a shared fallback chain:
`SSH_ENV_PATH` → `SSH4AGENT_ENV` (deprecated alias) → `~/.ssh4agent/.env`
(default, created by `ssh4agent server add`) → legacy `~/.ssh-manager/.env`
(read-only fallback) → `./​.env` → `~/.env` → project-root `.env`.

Example server entries:

```env
# Production Server
SSH_SERVER_PROD1_HOST=192.168.1.100
SSH_SERVER_PROD1_USER=admin
SSH_SERVER_PROD1_PORT=22
SSH_SERVER_PROD1_KEYPATH=~/.ssh/id_rsa
SSH_SERVER_PROD1_DESCRIPTION="Production Web Server"

# Database Server
SSH_SERVER_DB1_HOST=192.168.1.101
SSH_SERVER_DB1_USER=dbadmin
SSH_SERVER_DB1_PASSWORD=secret
SSH_SERVER_DB1_DEFAULT_DIR=/var/lib/mysql
```

### CLI Configuration

Configuration stored in `~/.ssh4agent/config.json`:

```json
{
  "default_editor": "nano",
  "default_shell": "/bin/bash",
  "color_output": true,
  "log_level": "info"
}
```

## Examples

### Database Tunnel

Access remote MySQL locally:

```bash
# Create tunnel
ssh4agent tunnel create prod1 local 3307:localhost:3306

# Connect to MySQL
mysql -h localhost -P 3307 -u root -p
```

### Deploy Application

```bash
# Sync application files
ssh4agent sync push prod1 ./dist/ /var/www/app/

# Restart service
ssh4agent exec prod1 "sudo systemctl restart app"

# Check status
ssh4agent exec prod1 "systemctl status app"
```

### Backup Logs

```bash
# Create backup directory
mkdir -p ./backups/$(date +%Y%m%d)

# Pull logs
ssh4agent sync pull prod1 /var/log/app/ ./backups/$(date +%Y%m%d)/
```

## Advanced Usage

### Using with MCP Server

The CLI works seamlessly with the MCP SSH4Agent server:

```bash
# Use CLI for configuration
ssh4agent server add

# Use MCP tools in Claude for operations
# The same .env file is shared
```

### Scripting

```bash
#!/bin/bash
# Deploy script using ssh4agent

SERVERS=(prod1 prod2 prod3)

for server in "${SERVERS[@]}"; do
    echo "Deploying to $server..."
    ssh4agent sync push $server ./dist/ /var/www/app/
    ssh4agent exec $server "sudo systemctl restart app"
done
```

### Aliases

Create shell aliases for common operations:

```bash
# Add to ~/.bashrc or ~/.zshrc
alias sml='ssh4agent server list'
alias smt='ssh4agent server test'
alias smc='ssh4agent ssh'

# Usage
sml          # List servers
smt prod1    # Test prod1
smc prod1    # Connect to prod1
```

## Troubleshooting

### Command not found

After `npm run install-cli`, the `ssh4agent` shim lives in npm's global bin
directory (`%APPDATA%\npm` on Windows; `/usr/local/bin` or `~/.npm-global/bin`
on macOS/Linux). If your shell can't find it:

- **Restart your terminal** so PATH refreshes (common need on Windows).
- Verify the link: `npm ls -g mcp-ssh4agent` should list it.
- Or skip the global shim entirely and run directly: `node cli/ssh-manager.ts --help`

### Missing optional dependencies

`rsync` / `sshpass` are optional — install only what you need:

```bash
# macOS
brew install sshpass

# Ubuntu/Debian
sudo apt-get install sshpass

# RHEL/CentOS/Fedora
sudo dnf install sshpass
```

On Windows, `rsync` is not bundled — install it via MSYS2, Scoop
(`scoop install rsync`), or WSL if you need `ssh4agent sync`.
`sshpass` has no native Windows build.

## Contributing

The CLI is part of the MCP SSH4Agent project. Contributions welcome!

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - See LICENSE file for details