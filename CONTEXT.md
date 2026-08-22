# MCP SSH4Agent

An MCP server that lets any MCP-compatible AI agent operate remote servers over SSH: run commands, move files, manage server groups and policy. Single context: one server process, one configuration, one vocabulary.

## Language

### Configuration

**Server**:
A named remote host entry in configuration (host/user/auth/port), the unit every tool addresses. Names are lowercased on load.
_Avoid_: connection, host, machine (a "connection" is a live SSH session to a Server, not the config entry)

**Resolved config**:
The camelCase form a Server takes after loading (e.g. `sudoPassword`, `defaultDir`). `.env` and TOML keys are source syntax and never survive loading.
_Avoid_: server object, config record

**Field table**:
The single source of truth (`src/server-fields.ts`) mapping each field across `.env` key, TOML aliases, and resolved-config name. Both the server loader and the CLI writer consume it.
_Avoid_: field map, schema

**Alias (server)**:
An alternative name resolving to one configured Server. Resolution: alias first, then direct name.
_Avoid_: nickname, shortcut

**Group**:
A named set of servers assembled from two read-only-at-merge sources: explicit member lists (`.server-groups.json`) plus every Server tagged with that `group` field. The `all` group is dynamic — every configured Server.
_Avoid_: pool, cluster

### Runtime

**Tool**:
One MCP capability exposed to agents (e.g. `ssh_execute`), defined in `src/tools/<group>.ts` and conditionally registered based on tool config. 37 tools in 6 groups.
_Avoid_: command (a "command" is the shell string a Tool runs remotely), function, endpoint

**ToolContext**:
The runtime context (register, getConnection, pool maps, policy gate) the entry point injects into each tool group module. Tool modules never import the entry point.
_Avoid_: registry handle, DI container

**Connection**:
A live SSH session to a Server, held in the connection pool and reused across Tool calls until timeout or invalidation.
_Avoid_: session (reserved — see below), link

**Session**:
A stateful shell channel (working directory, env vars preserved across sends) created by `ssh_session_start`. Distinct from a pooled Connection.
_Avoid_: connection, shell

**Policy**:
Per-server security rules (`unrestricted` / `readonly` / `restricted`) gating Tool calls before execution. Evaluated after alias expansion, so an alias cannot hide a denied command.
_Avoid_: permission, ACL

**Audit**:
Append-only JSONL record of Tool calls (arguments sanitized, secrets redacted), written only when a server configures `audit_log`.
_Avoid_: log (too generic — logger output is not Audit)

### Files & transfer

**Deploy**:
Upload flow with strategy: temp file, permission/ownership detection, sudo step-up when needed.
_Avoid_: push, publish

**Sync**:
Bidirectional rsync between local and Server paths, reporting parsed transfer statistics.
_Avoid_: mirror, backup (a "backup" is the dump/restore feature)
