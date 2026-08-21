# Server runs on Node native type stripping, floor raised to >=23.6

The entire server (`src/**/*.ts`, entry `node src/index.ts`) is TypeScript executed by Node's native type stripping — no tsx, no build, no emit. This raises `engines` from `>=18.0.0` to `>=23.6.0` and drops Node 18–23 users, because unflagged type stripping only exists from 23.6.

## Considered Options

- **Keep `src/` as plain JS + JSDoc (checkJs)** — the pre-existing state; works on Node 18+, but every module stays second-class TypeScript and the JSDoc-only inference differences (expando literals, `Object.entries(any)`) leak into real bugs.
- **TypeScript via tsx runtime for the server** — keeps Node 18+, but changes the user-facing runtime contract (`npx tsx src/index.js` instead of `node src/index.js`), slows server startup, and touches every agent-integration doc.
- **Compile to JS before publish** — a build step, which the "deploy from src/, no build" project constraint forbids.

Native stripping keeps the `node src/index.ts` contract byte-identical to the old `node src/index.js` one. Decided when the tool modules were split out of `src/index.js` (which shrank 4949 → ~770 lines); the user chose the version-floor trade-off explicitly.

## Consequences

- CI matrices run Node 24 only (was 18.x + 20.x).
- Type-stripping constraints apply to server code: erasable syntax only (no enums, namespaces, parameter properties) and relative imports must carry explicit `.ts` extensions.
- Script/CLI/debug code still runs via tsx — only the server runtime needed the native path.
