# advanced.ts stays one file — the tool group is the unit, not the domain

src/tools/advanced.ts (14 tools spanning eight loosely-related domains) is the one
group file that looks like a grab-bag, so every architecture review is tempted to
split it by domain (deploy.ts, tunnels.ts, groups.ts, …). That split was evaluated
and declined: it moves code without deepening anything. No interface changes; the
ToolContext destructure repeats per file; private helpers like `formatConfigMembers`
need new homes; and ADR-0002's one-register-call-per-group shape would need either
six extra entry-point calls or an aggregation layer that reassembles what the split
divided. The envelope-funnel deepening (ADR-era candidate 1) already removed ~540
lines of per-handler boilerplate from this file — it is 1128 lines, not the 1670 it
peaked at. Revisit only when a domain inside the file accumulates shared private
helpers that serve it alone; split along THAT seam, and keep `registerAdvancedTools`
as the single aggregation entry so ADR-0002's shape survives.
