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
 * (native type stripping, no build step), the CLI through tsx.
 */

export type ServerFieldType = 'string' | 'int' | 'bool' | 'patternList';

export interface ServerFieldSpec {
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
  { camel: 'host',         env: 'HOST',           toml: ['host'] },
  { camel: 'user',         env: 'USER',           toml: ['user', 'username'] },
  { camel: 'password',     env: 'PASSWORD',       toml: ['password'],                  quoteEnv: true },
  { camel: 'keyPath',      env: 'KEYPATH',        toml: ['key_path', 'keypath', 'ssh_key'] },
  { camel: 'passphrase',   env: 'PASSPHRASE',     toml: ['passphrase'],                quoteEnv: true },
  { camel: 'port',         env: 'PORT',           toml: ['port'],                      type: 'int' },
  { camel: 'defaultDir',   env: 'DEFAULT_DIR',    toml: ['default_dir', 'default_directory', 'cwd'] },
  { camel: 'sudoPassword', env: 'SUDO_PASSWORD',  toml: ['sudo_password'],             quoteEnv: true },
  { camel: 'description',  env: 'DESCRIPTION',    toml: ['description'],               quoteEnv: true },
  { camel: 'group',        env: 'GROUP',          toml: ['group'],                     quoteEnv: true },
  { camel: 'platform',     env: 'PLATFORM',       toml: ['platform'],                  lowercase: true },
  { camel: 'proxyJump',    env: 'PROXYJUMP',      toml: ['proxy_jump'] },
  { camel: 'proxyCommand', env: 'PROXYCOMMAND',   toml: ['proxy_command', 'proxycommand'] },
  { camel: 'forwardAgent', env: 'FORWARD_AGENT',  toml: ['forward_agent'],             type: 'bool' },
  // security policy fields — value validation (mode normalization, pattern
  // compilation) stays in policy.js / config-loader.js; this table only maps
  // the keys and coercion.
  { camel: 'mode',          env: 'MODE',           toml: ['mode'] },
  { camel: 'allowPatterns', env: 'ALLOW_PATTERNS', toml: ['allow_patterns'],           type: 'patternList', quoteEnv: true },
  { camel: 'denyPatterns',  env: 'DENY_PATTERNS',  toml: ['deny_patterns'],            type: 'patternList', quoteEnv: true },
  { camel: 'auditLog',      env: 'AUDIT_LOG',      toml: ['audit_log'] },
];

/** Lookup by resolved-config field name. */
export const FIELD_BY_CAMEL = new Map<string, ServerFieldSpec>(SERVER_FIELDS.map((f) => [f.camel, f]));

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
function coerceServerField(raw: unknown, spec: ServerFieldSpec): string | number | boolean | string[] | undefined {
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
export function serverFromEnvRecord(env: Record<string, string | undefined>, nameUpper: string): Record<string, any> {
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
 * Render one `.env` export line for a field, applying the shared quoting
 * rule: free-form / whitespace-sensitive values are double-quoted so a ` #`
 * inside the value cannot truncate it on read-back. Pattern lists join with `;`.
 */
export function serverEnvLine(nameUpper: string, spec: ServerFieldSpec, value: string | number | boolean | string[]): string {
  const rendered = Array.isArray(value) ? value.join(';') : String(value);
  const rhs = spec.quoteEnv ? `"${rendered}"` : rendered;
  return `SSH_SERVER_${nameUpper}_${spec.env}=${rhs}`;
}

/**
 * The canonical TOML key for a field (the alias exported when generating
 * TOML files — always `spec.toml[0]`).
 */
export function canonicalTomlKey(spec: ServerFieldSpec): string {
  return spec.toml[0];
}
