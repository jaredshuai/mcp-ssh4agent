// Cross-platform debug helper (replaces debug/test-groups.sh).
// Run via: `node debug/test-groups.ts`
//
// Prints example `ssh_group_*` / `ssh_execute_group` invocations and the
// group execution strategies. Pure echo → console.log; no shell-isms.

console.log('🧪 Test Server Groups');
console.log('=====================');
console.log('');
console.log('Server Groups allow batch operations on multiple servers with');
console.log('different execution strategies (parallel, sequential, rolling).');
console.log('');
console.log('📋 Test Commands for Server Groups:');
console.log('===================================');
console.log('');
console.log('# 1. List existing groups');
console.log('ssh_group_manage action:"list"');
console.log('');
console.log('# 2. Create a new group');
console.log('ssh_group_manage action:"create" name:"webservers" servers:["web1","web2","web3"] description:"Web application servers" strategy:"rolling" delay:5000');
console.log('');
console.log('# 3. Add servers to a group');
console.log('ssh_group_manage action:"add-servers" name:"production" servers:["prod1","prod2"]');
console.log('');
console.log('# 4. Execute command on a group');
console.log('ssh_execute_group group:"all" command:"uptime" strategy:"parallel"');
console.log('ssh_execute_group group:"production" command:"df -h" strategy:"rolling" delay:3000');
console.log('ssh_execute_group group:"webservers" command:"systemctl status nginx" stopOnError:true');
console.log('');
console.log('# 5. Update group settings');
console.log('ssh_group_manage action:"update" name:"production" strategy:"rolling" delay:10000 stopOnError:true');
console.log('');
console.log('# 6. Remove servers from group');
console.log('ssh_group_manage action:"remove-servers" name:"staging" servers:["old-server"]');
console.log('');
console.log('# 7. Delete a group');
console.log('ssh_group_manage action:"delete" name:"temp-group"');
console.log('');
console.log('📝 Execution Strategies:');
console.log('=======================');
console.log('• parallel   - Execute on all servers simultaneously (fastest)');
console.log('• sequential - Execute one by one in order');
console.log('• rolling    - Execute one by one with delay between (safest)');
console.log('');
console.log('💡 Default Groups:');
console.log('==================');
console.log('• all        - Dynamic group containing all configured servers');
console.log('• production - For production servers (rolling by default)');
console.log('• staging    - For staging/test servers');
console.log('• development- For dev servers');
console.log('');
console.log('⚙️ Use Cases:');
console.log('=============');
console.log('• Deploy updates to all web servers');
console.log('• Restart services across a cluster');
console.log('• Collect metrics from multiple hosts');
console.log('• Execute maintenance tasks');
console.log('• Rolling deployments with validation');
console.log('');
console.log('⚠️  Note: Groups are persisted in .server-groups.json');
console.log("    The 'all' group is dynamic and includes all configured servers");
