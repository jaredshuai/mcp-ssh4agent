# SSH Manager CLI

A simple, powerful, and fast cross-platform CLI for managing SSH servers.

## Features

- 🚀 **Fast**: Pure TypeScript, run natively by Node type stripping (no build step)
- 🎨 **Beautiful**: Colored output with emojis
- 📦 **Simple**: Single command for all operations
- 🔧 **Powerful**: Tunnels, sync, monitoring, and more
- 🔌 **Integrated**: Works with MCP SSH Manager server
- 🪟 **Cross-platform**: Runs natively on Windows, macOS, and Linux — no Bash/Git Bash/WSL required

## Installation

### Quick Install

```bash
# From the project root
npm run install-cli     # checks deps + `npm link` (creates the ssh-manager shim)
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
- `rsync` - For `ssh-manager sync` (not bundled on Windows; install separately if needed)
- `jq` - For JSON configuration management
- `sshpass` - For password authentication testing

## Usage

### Server Management

```bash
# Add a new server interactively
ssh-manager server add

# List all servers
ssh-manager server list

# Test connection
ssh-manager server test prod1

# Show server details
ssh-manager server show prod1

# Remove a server
ssh-manager server remove prod1

# Edit configuration
ssh-manager server edit
```

### Quick SSH Connection

```bash
# Connect to a server
ssh-manager ssh prod1
```

### File Synchronization

```bash
# Push files to server
ssh-manager sync push prod1 ./app /var/www/app

# Pull files from server
ssh-manager sync pull prod1 /var/log/app.log ./logs/
```

### SSH Tunnels

```bash
# Local port forwarding (access remote service locally)
ssh-manager tunnel create prod1 local 3307:localhost:3306

# Remote port forwarding (expose local service)
ssh-manager tunnel create prod1 remote 8080:localhost:8080

# SOCKS proxy
ssh-manager tunnel create prod1 dynamic 1080

# List active tunnels
ssh-manager tunnel list
```

### Execute Commands

```bash
# Run command on server
ssh-manager exec prod1 "uptime"

# Run complex commands
ssh-manager exec prod1 "df -h | grep /var"
```

## Configuration

### Server Configuration (.env)

Servers are stored in `.env` file in your project root:

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

Configuration stored in `~/.ssh-manager/config.json`:

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
ssh-manager tunnel create prod1 local 3307:localhost:3306

# Connect to MySQL
mysql -h localhost -P 3307 -u root -p
```

### Deploy Application

```bash
# Sync application files
ssh-manager sync push prod1 ./dist/ /var/www/app/

# Restart service
ssh-manager exec prod1 "sudo systemctl restart app"

# Check status
ssh-manager exec prod1 "systemctl status app"
```

### Backup Logs

```bash
# Create backup directory
mkdir -p ./backups/$(date +%Y%m%d)

# Pull logs
ssh-manager sync pull prod1 /var/log/app/ ./backups/$(date +%Y%m%d)/
```

## Advanced Usage

### Using with MCP Server

The CLI works seamlessly with the MCP SSH Manager server:

```bash
# Use CLI for configuration
ssh-manager server add

# Use MCP tools in Claude for operations
# The same .env file is shared
```

### Scripting

```bash
#!/bin/bash
# Deploy script using ssh-manager

SERVERS=(prod1 prod2 prod3)

for server in "${SERVERS[@]}"; do
    echo "Deploying to $server..."
    ssh-manager sync push $server ./dist/ /var/www/app/
    ssh-manager exec $server "sudo systemctl restart app"
done
```

### Aliases

Create shell aliases for common operations:

```bash
# Add to ~/.bashrc or ~/.zshrc
alias sml='ssh-manager server list'
alias smt='ssh-manager server test'
alias smc='ssh-manager ssh'

# Usage
sml          # List servers
smt prod1    # Test prod1
smc prod1    # Connect to prod1
```

## Troubleshooting

### Command not found

After `npm run install-cli`, the `ssh-manager` shim lives in npm's global bin
directory (`%APPDATA%\npm` on Windows; `/usr/local/bin` or `~/.npm-global/bin`
on macOS/Linux). If your shell can't find it:

- **Restart your terminal** so PATH refreshes (common need on Windows).
- Verify the link: `npm ls -g mcp-ssh-manager` should list it.
- Or skip the global shim entirely and run directly: `node cli/ssh-manager.ts --help`

### Missing optional dependencies

`rsync` / `jq` / `sshpass` are optional — install only what you need:

```bash
# macOS
brew install jq sshpass

# Ubuntu/Debian
sudo apt-get install jq sshpass

# RHEL/CentOS/Fedora
sudo dnf install jq sshpass
```

On Windows, `rsync` is not bundled — install it via MSYS2, Scoop
(`scoop install rsync`), or WSL if you need `ssh-manager sync`. `jq` is
available via Scoop/Chocolatey; `sshpass` has no native Windows build.

## Contributing

The CLI is part of the MCP SSH Manager project. Contributions welcome!

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - See LICENSE file for details