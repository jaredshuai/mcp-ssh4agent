# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview & Architecture

MCP SSH4Agent is a Model Context Protocol server enabling any MCP-compatible AI agent to manage multiple SSH connections, execute remote commands, transfer files, and manage deployments.

- **MCP Server** (`src/index.ts`): Node.js-based MCP server using the Model Context Protocol SDK via `ssh2`. Tools live in `src/tools/<group>.ts` (37 tools in 6 groups) and receive injected `ToolContext` (see ADR-0002).
- **Server Management CLI** (`cli/ssh-manager.ts`): Pure TypeScript CLI run natively by Node type stripping across Windows, macOS, and Linux.
- **Reference Pointers**:
  - Detailed CLI & development guide: [docs/agents/development.md](docs/agents/development.md)
  - Full tool & configuration reference: [docs/agents/tools-and-config.md](docs/agents/tools-and-config.md)
  - Documentation Master Index: [docs/README.md](docs/README.md)

## Essential Development Commands

```bash
npm start                             # Start MCP server (requires stdin)
npm test                              # Run full test suite (31 suites in series)
npm run typecheck                     # Type-check with tsc (noEmit, baseline 0 errors)
npm run validate                      # Code validation checks (node scripts/validate.ts)
npm run lint                          # Biome linting
npm run lint:fix                      # Biome check --write (safe fixes)
npm run setup-hooks                   # Install git pre-commit forwarder
```

> **Runtime Contract**: TypeScript executed natively via Node's type stripping (Node ≥ 23.6 dev, ≥ 20 for npm consumers; see ADR-0001). No build step in development.

## AI Agent Integration

- **Claude Code**: `claude mcp add ssh4agent -- npx -y mcp-ssh4agent` (published) or `claude mcp add ssh4agent node /absolute/path/to/src/index.ts` (dev).
- **OpenAI Codex**: `ssh4agent codex setup` (writes to `~/.codex/ssh-config.toml`).
- **Cursor / Cline / Others**: command `npx` args `["-y", "mcp-ssh4agent"]` or dev `node /path/to/src/index.ts`.

## Agent skills

### Commit Identity
This machine has no `git user.name`/`user.email` configured, and agents **must never modify git config**. Resolve identity via `gh`:
1. `gh api user --jq "{login, id}"` → e.g. `{"login":"jaredshuai","id":17944691}`
2. Privacy noreply email: `<id>+<login>@users.noreply.github.com`
3. Commit with one-shot env vars: `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`
4. Prefer `git commit -F <msgfile>` over inline here-strings.

### Upstream is Off-Limits
This repo has an `upstream` remote (`bvisible/mcp-ssh-manager`). **NEVER view, fetch, or reference upstream issues, PRs, code, releases, or other upstream info** unless explicitly authorized by the user in the current session. All operations target `origin` (`jaredshuai/mcp-ssh4agent`) — pass `-R jaredshuai/mcp-ssh4agent` to `gh` when in doubt.

### Issue Tracker & Triage
- GitHub issues via `gh`. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- Canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain Docs & Document Governance
- Single-context: [CONTEXT.md](CONTEXT.md) + `docs/adr/` at repo root. See [docs/agents/domain.md](docs/agents/domain.md).
- Continuous document governance & managed block boundaries: see [docs/agents/doc-governance.md](docs/agents/doc-governance.md).

<!-- lazypack:start block=resident-discipline src=DECISIONS.md@0.2.0 gen=aeb0254139bb9c52 input=eadb74741e344613 fp=f244f783b43ffb52 -->
## 工程纪律指针 (lazypack-discipline)

> 派生自 lazypack-discipline 固定层 DECISIONS.md@0.2.0（依据 lazypack-setup 内置快照编译，来源内容标识: 2b38b1b0543489226eda5e3bd2bf411c58c1c331；离线事实源查阅 lazypack-setup/references/DECISIONS.md）。本段为受管托管区，请勿手工破坏标记行。

- **纪律唯一事实源**：固定层规则跨项目不变。如需修改固定层，须走多 AI 讨论章程（§9）。
- **双角色门禁要求**：执行者和审查者都必须运行适用的质量门禁；未接线、不适用、运行失败等按事实报告，不宣称通过或已生效。
- **角色分工与防撞车**：查阅 [docs/agents/roles.md](docs/agents/roles.md)。同一设备同一时刻仅限一名执行者写代码，跨设备协作靠 issue 认领人（assignee），少用 worktree。
- **项目产物登记册**：查阅 [docs/ARTIFACTS.md](docs/ARTIFACTS.md)。所有现行有效基准文档在册唯一登记，未登记产物视为未决草案。
- **质量门禁要求**：查阅 [CODING_STANDARDS.md](CODING_STANDARDS.md)。执行者与审查者均必须执行门禁（§6.4）。能接已有命令则接，未接线诚实记录，不得宣称门禁已生效。
- **提交与发版规则**：查阅 [RELEASE.md](RELEASE.md)。严格采用 Conventional Commits 1.0.0（`type(scope)!: 描述`）与 Google CL 描述法；版本号遵循 SemVer 2.0.0。
<!-- lazypack:end block=resident-discipline -->
