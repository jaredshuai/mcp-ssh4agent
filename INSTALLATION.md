# Installation Guide for MCP SSH4Agent

## 📋 Prerequisites

- **Node.js** (v23.6 or higher — the server and CLI run TypeScript natively via type stripping) - [Download](https://nodejs.org/)
- **Claude Code CLI** - [Installation Guide](https://claude.ai/code)
- **Git** - For cloning the repository

Verify installations:
```bash
node --version   # Should show v23.6.x or higher
claude --version # Should show Claude Code version
```

## 🚀 Quick Installation

```bash
# 1. Clone the repository
git clone https://github.com/jaredshuai/mcp-ssh4agent.git
cd mcp-ssh4agent

# 2. Install dependencies
npm install

# 3. Install the CLI globally (npm link)
npm run install-cli

# 4. Install to Claude Code
claude mcp add ssh4agent node $(pwd)/src/index.ts
```

## 🔧 Server Configuration

### Interactive Mode (Recommended)

```bash
# Launch interactive menu
ssh4agent

# Choose "Server Management" → "Add New Server"
# Follow the guided wizard
```

### Direct Commands

```bash
ssh4agent server add    # Add new server
ssh4agent server list   # List all servers
ssh4agent server test   # Test connection
ssh4agent server remove # Remove server
```

### Manual Configuration

Edit the `.env` file directly:

```env
# Pattern: SSH_SERVER_[NAME]_[PROPERTY]

# Password authentication
SSH_SERVER_PROD1_HOST=example.com
SSH_SERVER_PROD1_USER=admin
SSH_SERVER_PROD1_PASSWORD=secure_password
SSH_SERVER_PROD1_PORT=22
SSH_SERVER_PROD1_DESCRIPTION="Production Server"

# SSH key authentication (recommended)
SSH_SERVER_DEV1_HOST=dev.example.com
SSH_SERVER_DEV1_USER=developer
SSH_SERVER_DEV1_KEYPATH=~/.ssh/id_rsa
SSH_SERVER_DEV1_PORT=22
SSH_SERVER_DEV1_DEFAULT_DIR=/var/www
```

## ✅ Verification

### 1. Check CLI Installation

```bash
ssh4agent --version
# Should show: SSH4Agent CLI v4.0.0
```

### 2. Check MCP Installation

```bash
claude mcp list
# Should show: ssh4agent
```

### 3. Test in Claude Code

Open Claude Code and try:
```
"List all SSH servers"
"Connect to production server"
"Upload file to staging"
```

## 🛠️ Troubleshooting

### CLI not found

```bash
# Add to your PATH
echo 'export PATH="$PATH:/usr/local/bin"' >> ~/.bashrc
source ~/.bashrc
```

### Servers not showing

```bash
# Check .env file location
export SSH4AGENT_ENV="$(pwd)/.env"
ssh4agent server list
```

### Permission denied

```bash
# Fix SSH key permissions
chmod 600 ~/.ssh/your_key
```

### MCP tools not available

```bash
# Restart Claude Code and re-add
claude mcp remove ssh4agent
claude mcp add ssh4agent node $(pwd)/src/index.ts
```

## 🌍 Environment Variables

Set these in your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
# Point to your .env file
export SSH4AGENT_ENV="/path/to/your/.env"

# Optional: Set default log level
export SSH_LOG_LEVEL="INFO"
```

## 📦 Project Scope Installation

To share with your team:

```bash
# Create project configuration
claude mcp add ssh4agent --scope project node $(pwd)/src/index.ts
```

This creates `.mcp.json` that can be committed to Git.

## 🗑️ Uninstallation

```bash
# Remove from Claude Code
claude mcp remove ssh4agent

# Uninstall CLI
npm uninstall -g mcp-ssh4agent

# Remove configuration
rm -rf ~/.ssh4agent
```

## 📚 Next Steps

After installation:
1. Add your servers using the interactive wizard
2. Test connections: `ssh4agent server test`
3. Try quick SSH: `ssh4agent ssh servername`
4. Explore features: `ssh4agent --help`

For more information, see the [README](README.md).