# Tunnels own and dispose their dedicated connection; they do not use the ConnectionPool

An SSH tunnel needs a long-lived connection whose lifetime matches the tunnel, not the
per-server reuse the ConnectionPool gives everything else. Pooling a tunnel's connection
was considered and rejected with three findings: the pool's idle timestamps update only
on `get()`, so an actively-forwarding tunnel would look idle and be reaped by
`cleanupAged()`; the pool's "one connection per server name" invariant cannot host
multiple tunnels to one server; and the tunnel manager's own `reconnect()` would race
the pool's reconnect into double dials. So `ssh_tunnel_create` dials a dedicated
SSHManager outside the pool, `SSHTunnel.close()` disposes it (the
`TunnelableConnection` seam marks `dispose()` optional only for test fakes), and
`shutdown()` runs `closeAllTunnels()` **before** `pool.disposeAll()` — a remote tunnel's
`unforwardIn` must be sent over its own still-live connection.

A **single** `proxyJump` or `proxyCommand` hop is allowed on that dedicated path: the
tunnel owns the hop (`ownedJumpConnection`, distinct from the pool's shared
`jumpConnection`) and disposes the jump only after the target client has ended. Nested
jumps (the jump host itself uses `proxyJump` / `proxyCommand`) stay refused — there is
still no verified multi-hop topology, and borrowing `pool.get(jump)` is forbidden for
the same idle-reap reasons as putting the tunnel itself in the pool. If tunnels ever
move onto pooled connections, the dispose call in `SSHTunnel.close()` is the line to
revisit.
