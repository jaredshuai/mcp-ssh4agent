// Interactive demo preview for the ssh-manager CLI (replaces cli/demo.sh).
// Run via: `npm run demo` → `node scripts/demo.ts`
//
// Pure Node.js, no shell-isms. Cross-platform clear screen via ANSI codes.
// The mid-script "Press Enter" pause only blocks when stdin is a TTY; in a
// pipe / CI it prints everything non-stop so the demo is scriptable.

import * as readline from 'node:readline';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const clearScreen = () => process.stdout.write('\x1b[2J\x1b[H');

clearScreen();
console.log(`${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${CYAN}         SSH Manager CLI - Interactive Demo${RESET}`);
console.log(`${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log('');

console.log(`${GREEN}✨ Welcome to SSH Manager CLI!${RESET}`);
console.log('');
console.log('This demo will show you the key features of the interactive interface.');
console.log('');

console.log(`${YELLOW}📋 Main Features:${RESET}`);
console.log('  • Interactive menu with numbered choices');
console.log('  • Guided server setup wizard');
console.log('  • Server management (add, list, test, remove)');
console.log('  • Quick SSH connections');
console.log('  • File synchronization');
console.log('  • SSH tunnel creation');
console.log('  • System monitoring');
console.log('');

console.log(`${YELLOW}🚀 To start the interactive mode, run:${RESET}`);
console.log('');
console.log('    ssh-manager');
console.log('    ssh-manager -i');
console.log('    ssh-manager --interactive');
console.log('');

console.log(`${YELLOW}📝 The interactive mode will show you:${RESET}`);
console.log('');
console.log('  1. Main menu with 8 options');
console.log('  2. Server management submenu');
console.log('  3. Guided wizards for complex tasks');
console.log('  4. Server selection menus');
console.log('  5. Real-time feedback with colors and emojis');
console.log('');

console.log(`${YELLOW}🎯 Example: Adding a Server${RESET}`);
console.log('');
console.log("When you choose 'Server Management' → 'Add New Server', you'll get:");
console.log('  • Step-by-step wizard');
console.log('  • Input validation');
console.log('  • Clear examples for each field');
console.log('  • Review before saving');
console.log('  • Option to test connection');
console.log('');

console.log(`${YELLOW}💡 Tips:${RESET}`);
console.log('  • Press 0 to go back in any menu');
console.log('  • Press Ctrl+C to exit anytime');
console.log('  • All configurations are saved in .env file');
console.log('  • Compatible with MCP server');
console.log('');

// Pause only when interactive; skip in pipes so the demo streams fully.
if (process.stdin.isTTY) {
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter to see the main menu preview...', () => {
      rl.close();
      resolve();
    });
  });
  console.log('');
}

const menu = [
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '           SSH Manager CLI v3.8.0',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  1) 🖥️  Server Management',
  '     Add, list, test, and manage SSH servers',
  '',
  '  2) 💻 Quick Connect',
  '     Connect to a server via SSH',
  '',
  '  3) 🔄 File Synchronization',
  '     Push/pull files with rsync',
  '',
  '  4) 🔧 SSH Tunnels',
  '     Create and manage SSH tunnels',
  '',
  '  5) 📊 System Monitoring',
  '     Monitor server resources',
  '',
  '  6) 🚀 Execute Commands',
  '     Run commands on servers',
  '',
  '  7) ⚙️  Configuration',
  '     Edit settings and preferences',
  '',
  '  8) ℹ️  Help & Documentation',
  '     View help and examples',
  '',
  '  0) Exit',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  'Choose an option [0-8]: _',
  '',
].join('\n');
console.log(menu);

console.log(`${GREEN}✅ Ready to try it yourself!${RESET}`);
console.log('');
console.log('Run: ssh-manager');
console.log('');
