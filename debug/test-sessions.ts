// Cross-platform debug helper (replaces debug/test-sessions.sh).
// Run via: `npx tsx debug/test-sessions.ts`
//
// Prints example `ssh_session_*` invocations and use cases. Pure echo →
// console.log; no shell-isms.

console.log('🧪 Test SSH Sessions');
console.log('====================');
console.log('');
console.log('SSH Sessions allow you to maintain state across multiple commands,');
console.log('keeping context like working directory and environment variables.');
console.log('');
console.log('📋 Test Commands for SSH Sessions:');
console.log('===================================');
console.log('');
console.log('# 1. Start a new session');
console.log('ssh_session_start server:"test-server" name:"Development Session"');
console.log('');
console.log('# 2. Send commands to the session');
console.log('ssh_session_send session:"ssh_1234567_abcd" command:"cd /var/www"');
console.log('ssh_session_send session:"ssh_1234567_abcd" command:"pwd"');
console.log('ssh_session_send session:"ssh_1234567_abcd" command:"ls -la"');
console.log('');
console.log('# 3. List active sessions');
console.log('ssh_session_list');
console.log('ssh_session_list server:"test-server"');
console.log('');
console.log('# 4. Close a session');
console.log('ssh_session_close session:"ssh_1234567_abcd"');
console.log('ssh_session_close session:"all"  # Close all sessions');
console.log('');
console.log('📝 Session Features:');
console.log('===================');
console.log('✅ Persistent state across commands');
console.log('✅ Working directory maintained');
console.log('✅ Command history tracking');
console.log('✅ Session variables support');
console.log('✅ Auto-cleanup of inactive sessions (30 min)');
console.log('✅ Multiple concurrent sessions');
console.log('');
console.log('💡 Use Cases:');
console.log('=============');
console.log('1. Interactive debugging sessions');
console.log('2. Multi-step deployment workflows');
console.log('3. Environment setup and testing');
console.log('4. Long-running processes monitoring');
console.log('');
console.log("⚠️  Note: Replace 'test-server' with an actual configured server");
console.log('    Session IDs are generated automatically when you start a session');
