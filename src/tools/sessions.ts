// Persistent-session tools (ssh_session_*). See src/tool-registry.ts for the
// authoritative group membership. Infrastructure arrives via ctx at registration time.

import { z } from 'zod';
import { formatDuration } from '../config.ts';
import { logger } from '../logger.ts';
import { createSession, getSession, listSessions, closeSession } from '../session-manager.ts';

export function registerSessionsTools(ctx: import('../tool-registry.ts').ToolContext) {
  const { register: registerToolConditional, getConnection } = ctx;

  registerToolConditional(
    'ssh_session_start',
    {
      description:
        'Opens a new persistent interactive shell on the named configured server and returns a generated session ID. Stateful and side-effecting: it establishes (or reuses pooled) SSH connection and keeps an open shell that preserves working directory, environment, and command history across later ssh_session_send calls, unlike one-shot ssh_execute. The optional name is only a human label. The session stays open and consumes a remote shell until ssh_session_close is called.',
      inputSchema: {
        server: z.string().describe('Server name from configuration'),
        name: z.string().optional().describe('Optional session name for identification'),
      },
    },
    async ({ server: serverName, name }) => {
      try {
        const ssh = await getConnection(serverName);
        const session = await createSession(serverName, ssh);

        const sessionName = name || `Session on ${serverName}`;

        logger.info('SSH session started', {
          id: session.id,
          server: serverName,
          name: sessionName,
        });

        return {
          content: [
            {
              type: 'text',
              text: `🚀 SSH Session Started\n\nSession ID: ${session.id}\nServer: ${serverName}\nName: ${sessionName}\nState: ${session.state}\nWorking Directory: ${session.context.cwd}\n\nUse ssh_session_send to execute commands in this session.\nUse ssh_session_close to terminate the session.`,
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to start SSH session', {
          server: serverName,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to start session: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  registerToolConditional(
    'ssh_session_send',
    {
      description:
        'Runs one command inside an already-open session identified by its session ID, reusing the persisted working directory, environment, and history of that shell. Mutates remote state like any shell command and is not idempotent; cd and export update the saved context for subsequent calls. Commands run through a bash-style shell (Unix-oriented). The security policy of the underlying server is enforced, so readonly or restricted servers may refuse. Default timeout is 30000 ms.',
      inputSchema: {
        session: z.string().describe('Session ID from ssh_session_start'),
        command: z.string().describe('Command to execute in the session'),
        timeout: z.number().optional().describe('Command timeout in milliseconds (default: 30000)'),
      },
    },
    async ({ session: sessionId, command, timeout = 30000 }) => {
      try {
        const session = getSession(sessionId);

        const startTime = Date.now();
        const result = await session.execute(command, { timeout });
        const duration = Date.now() - startTime;

        logger.info('Session command executed', {
          session: sessionId,
          command: command.substring(0, 50),
          success: result.success,
          duration: `${duration}ms`,
        });

        let output = `📟 Session: ${sessionId}\n`;
        output += `Server: ${session.serverName}\n`;
        output += `Working Directory: ${session.context.cwd}\n`;
        output += `Command: ${command}\n`;
        output += `Duration: ${duration}ms\n`;
        output += '━'.repeat(60) + '\n\n';

        if (result.success) {
          output += '✅ Output:\n' + result.output;
        } else {
          output += '❌ Error:\n' + (result.error || result.output);
        }

        // Add session state info
        output += '\n\n' + '━'.repeat(60) + '\n';
        output += `Session State: ${session.state}\n`;
        output += `Commands Executed: ${session.context.history.length}\n`;

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logger.error('Failed to send command to session', {
          session: sessionId,
          command,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Session error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
    // Policy: the session's underlying server is the subject (not args.server);
    // command-bearing — the funnel matches the command against readonly/
    // restricted patterns.
    {
      serverFrom: (args) => {
        try {
          return getSession(args.session)?.serverName;
        } catch {
          // Unknown/closed session: skip the gate; the handler surfaces the
          // error from getSession itself (same response as before).
          return undefined;
        }
      },
      commandArg: 'command',
    }
  );

  registerToolConditional(
    'ssh_session_list',
    {
      description:
        'Lists currently active SSH sessions with their ID, server, state, working directory, command count, age, idle time, and any defined variables. Read-only: it inspects in-memory session state and changes nothing on remote hosts or local config. The optional server argument is a case-insensitive substring filter on server name; omit it to list every active session. Closed sessions are excluded from the results.',
      inputSchema: {
        server: z.string().optional().describe('Filter by server name'),
      },
    },
    async ({ server }) => {
      try {
        let sessions = listSessions();

        // Filter by server if specified
        if (server) {
          sessions = sessions.filter((s) => s.server.toLowerCase().includes(server.toLowerCase()));
        }

        let output = '📋 Active SSH Sessions\n';
        output += '━'.repeat(60) + '\n\n';

        if (sessions.length === 0) {
          output += 'No active sessions';
          if (server) {
            output += ` for server "${server}"`;
          }
          output += '.\n';
        } else {
          sessions.forEach((session, index) => {
            const age = Math.floor((Date.now() - new Date(session.created).getTime()) / 1000);
            const idle = Math.floor((Date.now() - new Date(session.lastActivity).getTime()) / 1000);

            output += `${index + 1}. Session: ${session.id}\n`;
            output += `   Server: ${session.server}\n`;
            output += `   State: ${session.state}\n`;
            output += `   Working Dir: ${session.cwd || 'unknown'}\n`;
            output += `   Commands Run: ${session.historyCount}\n`;
            output += `   Age: ${formatDuration(age)}\n`;
            output += `   Idle: ${formatDuration(idle)}\n`;

            if (session.variables.length > 0) {
              output += `   Variables: ${session.variables.join(', ')}\n`;
            }

            output += '\n';
          });
        }

        output += '━'.repeat(60) + '\n';
        output += `Total Active Sessions: ${sessions.length}\n`;

        logger.info('Listed SSH sessions', {
          total: sessions.length,
          filter: server,
        });

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error listing sessions: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  registerToolConditional(
    'ssh_session_close',
    {
      description:
        'Terminates an open SSH session given its session ID, writing exit to the remote shell, ending it, and discarding its in-memory history and context; the session ID becomes unusable afterward. Destructive to session state but does not delete remote files. Passing the literal value all closes every active session at once, ignoring individual close errors. It does not drop the pooled underlying connection, only the interactive shell.',
      inputSchema: {
        session: z.string().describe('Session ID to close (or "all" to close all sessions)'),
      },
    },
    async ({ session: sessionId }) => {
      try {
        if (sessionId === 'all') {
          const sessions = listSessions();
          const count = sessions.length;

          sessions.forEach((s) => {
            try {
              closeSession(s.id);
            } catch (err) {
              // Ignore individual close errors
            }
          });

          logger.info('Closed all SSH sessions', { count });

          return {
            content: [
              {
                type: 'text',
                text: `🔚 Closed ${count} SSH sessions`,
              },
            ],
          };
        } else {
          closeSession(sessionId);

          logger.info('SSH session closed', { session: sessionId });

          return {
            content: [
              {
                type: 'text',
                text: `🔚 Session closed: ${sessionId}`,
              },
            ],
          };
        }
      } catch (error) {
        logger.error('Failed to close session', {
          session: sessionId,
          error: error.message,
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to close session: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Helper function to format duration
}
