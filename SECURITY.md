# Security Policy

## Supported Versions

Only the latest published `mcp-ssh4agent` release on npm receives security fixes.
Please upgrade to the newest version before reporting an issue.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report privately through either channel:

- **GitHub Private Vulnerability Reporting** (preferred) — open the
  [**Security** tab](https://github.com/jaredshuai/mcp-ssh4agent/security/advisories)
  of this repository and click **Report a vulnerability**. This keeps the report,
  discussion, and any resulting advisory private until a fix is released.
- **Email** — <security@bvisible.ch> (or <jeremy@bvisible.ch>).

Please include, as far as you can:

- the affected version and the affected tool(s) or source area,
- a description of the vulnerability and its impact,
- a minimal proof of concept or reproduction steps, and
- any suggested remediation.

To keep proof-of-concept work safe, validate against **local package source and
your own owned test boundary** — do not exercise third-party hosts or
maintainer infrastructure.

## Disclosure Process

- We aim to acknowledge a report within **72 hours**.
- We will confirm the issue, determine affected versions, and prepare a fix,
  keeping you informed along the way.
- Fixes are released as a new npm version accompanied by a
  [GitHub Security Advisory](https://github.com/jaredshuai/mcp-ssh4agent/security/advisories)
  (with a CVE where warranted).
- We are happy to **credit reporters** in the advisory and release notes.
  Let us know the name/handle you would like used, or if you prefer to remain anonymous.

## Scope Notes

`mcp-ssh4agent` executes commands on remote hosts on behalf of an AI assistant.
Reports are especially valuable when a tool documented as read-only or safe
(for example `ssh_db_list`, `ssh_db_query`, or any tool permitted under the
`readonly` / `restricted` per-server security modes) can be made to execute
arbitrary commands, escalate privileges, or exfiltrate data on the configured
SSH target.
