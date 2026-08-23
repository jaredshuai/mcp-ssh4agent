/**
 * Test isolation: point SSH4AGENT_HOME at a throwaway temp dir BEFORE any
 * src module is imported, so tests never read or write the developer's real
 * ~/.ssh4agent state (aliases, history, hooks config...).
 *
 * Import this module FIRST in a test file — ESM evaluates imports in order,
 * so every later import (logger, hooks-system, server-aliases, ...) resolves
 * its state paths against TEST_HOME.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4agent-test-'));
process.env.SSH4AGENT_HOME = TEST_HOME;

// Remove the throwaway home when the test process exits — without this,
// every run leaks an ssh4agent-test-* dir in the OS temp dir (the module
// is evaluated once per process, so the handler is registered once).
process.on('exit', () => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
