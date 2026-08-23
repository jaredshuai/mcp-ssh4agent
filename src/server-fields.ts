/**
 * Single source of truth for SSH server configuration field names.
 *
 * Two independent loaders used to carry their own copies of this knowledge —
 * `src/config-loader.ts` (MCP server side) and `cli/lib/config.ts` (CLI side)
 * — and they drifted: the CLI wrote `PASSWORD=pw` unquoted while the server
 * exported `PASSWORD="pw"`, and the TOML alias chain (`key_path`/`keypath`/
 * `ssh_key`) existed only on the server side. The v3.0.0 snake→camel
 * migration broke handlers silently because no single place defined the
 * mapping (issue #49). Both loaders now consume this table.
 *
 * Server config values are **camelCase, always**; `SUDO_PASSWORD` / env keys
 * and `sudo_password` / TOML keys are source syntax mapped through this table
 * and never survive into a resolved config.
 *
 * TypeScript run directly: the MCP server imports it under plain `node`
 * (native type stripping, no build step), and the CLI the same way.
 */

import * as dotenv from 'dotenv';

type ServerFieldType = 'string' | 'int' | 'bool' | 'patternList';

interface ServerFieldSpec {
  /** Resolved-config field (camelCase). */
  camel: string;
  /** `.env` key suffix after `SSH_SERVER_<NAME>_`. */
  env: string;
  /** TOML key aliases, first-wins; `[0]` is the canonical key used when exporting TOML. */
  toml: string[];
  /** Value coercion applied on load (default 'string'). */
  type?: ServerFieldType;
  /** Export wraps the value in double quotes (free-form / whitespace-sensitive values). */
  quoteEnv?: boolean;
  /** Value is lowercased on load (platform). */
  lowercase?: boolean;
}

export const SERVER_FIELDS: ServerFieldSpec[] = [
  // identity — always present in practice; host is the anchor key both loaders
  // key off (`SSH_SERVER_<NAME>_HOST` / `[ssh_servers.name]` + `host`).
  { camel: 'host', env: 'HOST', toml: ['host'] },
  { camel: 'user', env: 'USER', toml: ['user', 'username'] },
  { camel: 'password', env: 'PASSWORD', toml: ['password'], quoteEnv: true },
  { camel: 'keyPath', env: 'KEYPATH', toml: ['key_path', 'keypath', 'ssh_key'] },
  { camel: 'passphrase', env: 'PASSPHRASE', toml: ['passphrase'], quoteEnv: true },
  { camel: 'port', env: 'PORT', toml: ['port'], type: 'int' },
  { camel: 'defaultDir', env: 'DEFAULT_DIR', toml: ['default_dir', 'default_directory', 'cwd'] },
  { camel: 'sudoPassword', env: 'SUDO_PASSWORD', toml: ['sudo_password'], quoteEnv: true },
  { camel: 'description', env: 'DESCRIPTION', toml: ['description'], quoteEnv: true },
  { camel: 'group', env: 'GROUP', toml: ['group'], quoteEnv: true },
  { camel: 'platform', env: 'PLATFORM', toml: ['platform'], lowercase: true },
  { camel: 'proxyJump', env: 'PROXYJUMP', toml: ['proxy_jump'] },
  { camel: 'proxyCommand', env: 'PROXYCOMMAND', toml: ['proxy_command', 'proxycommand'] },
  { camel: 'forwardAgent', env: 'FORWARD_AGENT', toml: ['forward_agent'], type: 'bool' },
  // security policy fields — value validation (mode normalization, pattern
  // compilation) stays in policy.js / config-loader.js; this table only maps
  // the keys and coercion.
  { camel: 'mode', env: 'MODE', toml: ['mode'] },
  {
    camel: 'allowPatterns',
    env: 'ALLOW_PATTERNS',
    toml: ['allow_patterns'],
    type: 'patternList',
    quoteEnv: true,
  },
  {
    camel: 'denyPatterns',
    env: 'DENY_PATTERNS',
    toml: ['deny_patterns'],
    type: 'patternList',
    quoteEnv: true,
  },
  { camel: 'auditLog', env: 'AUDIT_LOG', toml: ['audit_log'] },
];

/** Lookup by resolved-config field name. */
export const FIELD_BY_CAMEL = new Map<string, ServerFieldSpec>(
  SERVER_FIELDS.map((f) => [f.camel, f])
);

// Parse a boolean-ish config value. Native booleans (TOML) pass through; the
// strings "true"/"1"/"yes"/"on" (case-insensitive) from .env are true.
// Everything else — "false", "0", "", undefined — is false, so an opt-in
// flag never turns on by accident. (Internal: exercised through the
// serverFrom*Record builders.)
function parseBool(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// Parse a `;`-separated list of regex pattern strings. TOML arrays pass
// through; empty entries are dropped. We do NOT compile here — that happens
// lazily in policy.js so this module stays free of regex error handling.
// (Internal: exercised through the serverFrom*Record builders.)
function parsePatternList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s)).filter((s) => s.length > 0);
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Coerce a raw source value (env string / TOML value) to its resolved-config
// form according to the field spec. Returns `undefined` for absent values so
// callers keep their own defaults (e.g. port 22). (Internal: exercised
// through the serverFrom*Record builders.)
function coerceServerField(
  raw: unknown,
  spec: ServerFieldSpec
): string | number | boolean | string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (spec.type) {
    case 'int':
      return parseInt(String(raw), 10);
    case 'bool':
      return parseBool(raw);
    case 'patternList':
      return parsePatternList(raw);
    default: {
      let text = String(raw);
      if (spec.lowercase) text = text.toLowerCase();
      return text;
    }
  }
}

/**
 * Boolean fields always resolve to an explicit true/false (absent → false),
 * matching the pre-table loaders: `parseBool(undefined)` was false, never
 * undefined. Other types are simply omitted when absent.
 */
function accumulate(out: Record<string, any>, raw: unknown, spec: ServerFieldSpec): void {
  if (raw !== undefined) out[spec.camel] = raw;
  else if (spec.type === 'bool') out[spec.camel] = false;
}

/**
 * Build a camelCase partial config from one server's `.env` entries.
 * `nameUpper` is the upper-case server name as written in the file.
 */
export function serverFromEnvRecord(
  env: Record<string, string | undefined>,
  nameUpper: string
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const spec of SERVER_FIELDS) {
    const value = coerceServerField(env[`SSH_SERVER_${nameUpper}_${spec.env}`], spec);
    accumulate(out, value, spec);
  }
  return out;
}

/**
 * Build a camelCase partial config from one `[ssh_servers.name]` TOML table,
 * honoring the alias chain (first alias that is present wins).
 */
export function serverFromTomlRecord(tomlServer: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const spec of SERVER_FIELDS) {
    let raw;
    for (const key of spec.toml) {
      if (tomlServer[key] !== undefined && tomlServer[key] !== null && tomlServer[key] !== '') {
        raw = tomlServer[key];
        break;
      }
    }
    accumulate(out, coerceServerField(raw, spec), spec);
  }
  return out;
}

/**
 * Whether a value must be quoted to survive dotenv's reader: quoteEnv
 * fields always are, and any value containing `#` (comment start),
 * whitespace (trimmed unquoted), or a PAIRED leading delimiter (starts
 * and ends with the same quote/backtick — dotenv would strip that outer
 * pair) is truncated or reshaped without quotes. Interior quotes alone do
 * NOT require quoting, and neither does an UNPAIRED leading delimiter:
 * dotenv's quoted alternative needs a closing delimiter AND end-of-value,
 * so `` `a'b"c `` falls through to the unquoted alternative
 * (`[^#\r\n]+` passes quotes verbatim) (PR #9 r6/r7).
 */
function quotingRequired(spec: ServerFieldSpec, rendered: string): boolean {
  return spec.quoteEnv || /[#\s]/.test(rendered) || /^(['"`])[\s\S]*\1$/.test(rendered);
}

/**
 * Whether `value` can be written for field `camel` (camelCase) and read
 * back losslessly through dotenv. False ONLY for the unrepresentable
 * case: a value containing BOTH quote characters that also REQUIRES
 * quoting (dotenv does not unescape `\"`, so no quoting scheme can
 * round-trip it). Values that stay unquoted tolerate interior quotes.
 * Shared by serverEnvLine (throws) and the CLI's pre-mutation checks.
 */
export function envValueRepresentable(camel: string, value: unknown): boolean {
  const spec = FIELD_BY_CAMEL.get(camel);
  if (!spec) return false;
  const rendered = Array.isArray(value) ? (value as string[]).join(';') : String(value);
  return !(rendered.includes('"') && rendered.includes("'") && quotingRequired(spec, rendered));
}

/**
 * Render one `.env` export line for a field, applying the shared quoting
 * rule (see quotingRequired). Quote CHOICE matters: dotenv (the reader on
 * both sides — see dotenvParse) stops a double-quoted value at the first
 * unescaped `"`, so a value containing `"` (but no `'`) is single-quoted,
 * and vice versa.
 *
 * A value containing BOTH quote characters AND requiring quoting is
 * UNREPRESENTABLE — it throws so callers can reject the value up front
 * and point the user at TOML, which represents it natively (PR #9 r5/r6).
 */
export function serverEnvLine(
  nameUpper: string,
  spec: ServerFieldSpec,
  value: string | number | boolean | string[]
): string {
  const rendered = Array.isArray(value) ? value.join(';') : String(value);
  if (rendered.includes('"') && rendered.includes("'") && quotingRequired(spec, rendered)) {
    throw new Error(
      `Value for ${nameUpper}.${spec.env} contains both quote characters — ` +
        `.env format cannot represent it losslessly; use TOML instead`
    );
  }
  const needsQuoting = quotingRequired(spec, rendered);
  let rhs: string;
  if (!needsQuoting) {
    rhs = rendered;
  } else if (rendered.includes('"')) {
    rhs = `'${rendered}'`;
  } else {
    rhs = `"${rendered}"`;
  }
  return `SSH_SERVER_${nameUpper}_${spec.env}=${rhs}`;
}

/**
 * The canonical TOML key for a field (the alias exported when generating
 * TOML files — always `spec.toml[0]`).
 */
export function canonicalTomlKey(spec: ServerFieldSpec): string {
  return spec.toml[0];
}

/**
 * Parse raw `.env` file text into per-server camelCase partial configs,
 * keyed by lowercased server name (issue #7).
 *
 * This is the ONE .env reading semantic, shared by the MCP loader
 * (src/config-loader.ts — which layers priority over process.env/TOML) and
 * the CLI (cli/lib/config.ts get_server_config). Both sides used to parse
 * the file independently and had drifted (quote handling, field mapping).
 * dotenv handles the quoting rules; the field table handles the mapping.
 */
export function parseEnvServersText(text: string): Map<string, Record<string, any>> {
  const parsed = dotenvParse(text);
  const out = new Map<string, Record<string, any>>();
  const hostPattern = /^SSH_SERVER_([A-Z0-9_]+)_HOST$/;
  for (const key of Object.keys(parsed)) {
    const match = key.match(hostPattern);
    if (!match) continue;
    const nameLower = match[1].toLowerCase();
    if (out.has(nameLower)) continue; // first anchor wins
    const record = serverFromEnvRecord(parsed, match[1]);
    record.host = parsed[key];
    out.set(nameLower, record);
  }
  return out;
}

// The .env reader is the ACTUAL dotenv parser — the same one
// src/config-loader.ts uses. A hand-rolled subset lived here before and
// drifted from the library on every quoting edge (escaped delimiters,
// interior quotes before comments, comment lines ending in quotes — PR #9
// reviews, rounds 2-4); delegating makes the CLI and MCP sides
// byte-for-byte identical by construction.
function dotenvParse(text: string): Record<string, string> {
  return dotenv.parse(text);
}
