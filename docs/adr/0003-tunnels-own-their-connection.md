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
`unforwardIn` must be sent over its own still-live connection. Tunnels on
proxyJump/proxyCommand-reachable servers are refused with an explicit error (a direct
dial would silently hang; full jump traversal is unimplemented until a real need
appears). If tunnels ever move onto pooled connections, the dispose call in
`SSHTunnel.close()` is the line to revisit.
