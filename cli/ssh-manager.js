#!/usr/bin/env node
// Cross-platform launcher: registers tsx, then loads the TypeScript CLI.
// On Windows, dynamic import() requires a file:// URL, not a bare path —
// so we pass the URL object's href directly instead of converting to a path.
await import('tsx/esm'); // register the tsx ESM loader
await import(new URL('./ssh-manager.ts', import.meta.url).href);
