# Quick Start Guide - MCP SSH4Agent

Get up and running in 5 minutes! 🚀

## 1️⃣ Clone & Install (1 minute)

```bash
git clone https://github.com/jaredshuai/mcp-ssh4agent.git
cd mcp-ssh4agent
npm install
npm run install-cli
```

## 2️⃣ Add Your First Server (2 minutes)

```bash
# Launch interactive menu
ssh4agent
```

Choose: `1) Server Management` → `1) Add New Server`

Enter:
- Name: `myserver`
- Host: `your.server.com`
- Username: `yourusername`
- Port: `22`
- Choose authentication method (SSH key recommended)

## 3️⃣ Install to Claude Code (1 minute)

```bash
claude mcp add ssh4agent node $(pwd)/src/index.ts
```

## 4️⃣ Test It! (1 minute)

In Claude Code:
```bash
claude
```

Try these commands:
```
"List my SSH servers"
"Execute 'hostname' on myserver"
"Run 'ls -la' on myserver"
```

## 🎉 That's it!

You're now connected to your server through Claude Code!

## 📝 Common Commands

```bash
ssh4agent                    # Interactive menu
ssh4agent server list        # List servers
ssh4agent ssh myserver       # Quick SSH
ssh4agent server test        # Test connections
ssh4agent sync push myserver ./app /var/www/  # Upload files
```

## 💡 Pro Tips

1. **Set environment variable** in `~/.bashrc` or `~/.zshrc`:
   ```bash
   export SSH4AGENT_ENV="/path/to/your/.env"
   ```

2. **Create shortcuts**:
   ```bash
   alias ssm="ssh4agent"
   alias ssm-list="ssh4agent server list"
   ```

Need help? Run `ssh4agent --help`