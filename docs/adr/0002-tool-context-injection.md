# Tool modules receive an injected context instead of importing the entry point

The 37 tool registrations live in `src/tools/<group>.ts` (split out of a 4949-line `src/index.js`). Each group module exports `register<Group>Tools(ctx)` and receives the `ToolContext` (register, getConnection, connection pool maps, policy gate, audit helper) as its single argument. Tool modules never import the entry point.

This exists to break the import cycle that a naive split creates: tool handlers need `getConnection` and the pool, which live in the entry point alongside the MCP server instance — and the entry point imports the tool modules to register them. Constructor-style injection is the same pattern `src/server-groups.ts` already uses for config access (`setServerConfigProvider`).

## Consequences

- Adding infrastructure a tool needs means one new field on `ToolContext` (typed in `src/tool-registry.ts`), not a new import edge into the entry point.
- Handlers keep contextual typing because `register` carries the full signature in the `ToolContext` type.
- The entry point stays the single assembly point: it builds the context once and hands it to all six groups.
