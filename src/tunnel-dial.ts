/**
 * Dedicated-connection dial for ssh_tunnel_create (ADR-0003).
 *
 * Tunnels must not borrow a ConnectionPool hop: idle reap / disconnect on
 * the pooled jump would silently kill the tunnel's forwardOut stream. A
 * single proxyJump hop therefore owns its own jump connection; proxyCommand
 * injects a local sock. Nested jumps stay refused until a real multi-hop
 * topology exists to verify them.
 */

import SSHManager from './ssh-manager.ts';
import { createProxyCommandSocket } from './proxy-command.ts';
import type { TunnelableConnection } from './tunnel-manager.ts';

/** 隧道拨号用的最小连接面：测试可注入假对象，生产用 SSHManager。 */
type TunnelDialConnection = {
  connect: (options?: { sock?: any }) => Promise<void>;
  forwardOut: (srcAddr: string, srcPort: number, dstAddr: string, dstPort: number) => Promise<any>;
  dispose: () => void;
  ownedJumpConnection?: TunnelDialConnection | null;
};

/** resolveServer 在工具上下文中的形状（名字 + Resolved config）。 */
type ResolveServerFn = (name: string) => Promise<{ name: string; config: any } | null | undefined>;

/** 可注入的工厂，供单测替换真实 SSH / ProxyCommand。 */
type DialTunnelDeps = {
  createConnection: (config: any) => TunnelDialConnection;
  openProxyCommandSocket: (proxyCommand: string, host: string, port: number) => Promise<any>;
};

/**
 * 构造生产环境拨号依赖：真实 SSHManager 与系统 ProxyCommand 套接字。
 */
function defaultDialDeps(): DialTunnelDeps {
  return {
    createConnection: (config) => new SSHManager(config) as TunnelDialConnection,
    openProxyCommandSocket: createProxyCommandSocket,
  };
}

/**
 * 为隧道打开一条专属 Connection。单跳 proxyJump 自握门卫线；
 * 门卫自身若仍带跳字段则拒绝。失败时释放已拨起的门卫，避免泄漏。
 */
export async function dialTunnelConnection(
  resolved: { name: string; config: any },
  resolveServer: ResolveServerFn,
  deps?: Partial<DialTunnelDeps>
): Promise<TunnelableConnection> {
  const { createConnection, openProxyCommandSocket } = {
    ...defaultDialDeps(),
    ...deps,
  };
  const config = resolved.config || {};

  if (config.proxyJump) {
    return dialViaOwnedJump(resolved, resolveServer, createConnection);
  }
  if (config.proxyCommand) {
    return dialViaProxyCommand(resolved, createConnection, openProxyCommandSocket);
  }

  const ssh = createConnection(config);
  await ssh.connect();
  return ssh as unknown as TunnelableConnection;
}

/**
 * 经一台直连门卫 Server 拨目标：forwardOut 流作为目标 connect 的 sock。
 */
async function dialViaOwnedJump(
  resolved: { name: string; config: any },
  resolveServer: ResolveServerFn,
  createConnection: DialTunnelDeps['createConnection']
): Promise<TunnelableConnection> {
  const config = resolved.config;
  const jumpResolved = await resolveServer(config.proxyJump);
  if (!jumpResolved || !jumpResolved.config) {
    throw new Error(
      `Proxy jump server "${config.proxyJump}" not found (needed to tunnel to "${resolved.name}").`
    );
  }

  const jumpConfig = jumpResolved.config;
  if (jumpConfig.proxyJump || jumpConfig.proxyCommand) {
    const via = jumpConfig.proxyJump ? 'proxy_jump' : 'proxy_command';
    throw new Error(
      `Server "${resolved.name}" is reachable through proxy_jump "${jumpResolved.name}", ` +
        `but that jump host itself uses ${via}. Tunnels support only a single hop.`
    );
  }

  const jump = createConnection(jumpConfig);
  await jump.connect();

  const target = createConnection(config);
  try {
    const stream = await jump.forwardOut('127.0.0.1', 0, config.host, config.port || 22);
    await target.connect({ sock: stream });
  } catch (error) {
    try {
      jump.dispose();
    } catch {
      /* 门卫已拨起但目标失败：必须拆掉门卫 */
    }
    throw error;
  }

  target.ownedJumpConnection = jump;
  return target as unknown as TunnelableConnection;
}

/**
 * 用 ProxyCommand 产出的本地 sock 拨目标，不经过第二台 SSH Server。
 */
async function dialViaProxyCommand(
  resolved: { name: string; config: any },
  createConnection: DialTunnelDeps['createConnection'],
  openProxyCommandSocket: DialTunnelDeps['openProxyCommandSocket']
): Promise<TunnelableConnection> {
  const config = resolved.config;
  const ssh = createConnection(config);
  let sock: any;
  try {
    sock = await openProxyCommandSocket(config.proxyCommand, config.host, config.port || 22);
    await ssh.connect({ sock });
  } catch (error) {
    try {
      sock?.destroy?.();
    } catch {
      /* best-effort */
    }
    throw error;
  }
  return ssh as unknown as TunnelableConnection;
}
