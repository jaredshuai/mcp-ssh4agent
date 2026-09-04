# One tool-config owner: the CLI consumes src/tool-config-manager.ts (and the manager carries no logging)

Tool enablement configuration has exactly one owner — `src/tool-config-manager.ts`,
backed by the `src/tool-registry.ts` data (groups, counts, descriptions). The
ssh4agent CLI consumes both directly instead of re-implementing them: before this,
the CLI's copy had already drifted four ways (a different core-group description, a
hardcoded 37-tool list in export-claude — a third copy of the registry, a reset that
deleted the file and could resurrect a legacy `~/.ssh-manager` config on the next
load, and a mode transition that silently enabled all 37 tools from minimal mode).
The CLI now keeps only rendering and prompts.

Two shape decisions came with it:

- **The manager is logger-free on purpose.** A config store deciding the logging
  mechanism was over-reach, and the CLI must be able to import it with zero side
  effects (no `~/.ssh4agent` created, no log file opened). Diagnostics belong to the
  callers — the entry point logs its own summary; the CLI has its `print_*` output.
  This extends the established shared set (server-fields, env-path) that the CLI
  already imports from `src/`; stateful runtime modules stay off-limits.
- **Semantics live in the manager, not per-caller.** Mode transitions materialize
  the current effective state into custom mode before flipping one group;
  reset writes the default (mode: all) rather than deleting; per-tool overrides win
  in every mode. The CLI gets these by calling `enableGroup`/`disableGroup`/
  `replaceConfig`/`reset` instead of hand-writing config JSON.
