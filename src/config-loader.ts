import * as dotenv from 'dotenv';
import TOML from '@iarna/toml';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.ts';
import { VALID_MODES } from './policy.ts';
import {
  SERVER_FIELDS,
  serverFromEnvRecord,
  serverFromTomlRecord,
  serverEnvLine,
  canonicalTomlKey,
} from './server-fields.ts';

/**
 * A resolved SSH server configuration, as produced by this loader and consumed
 * by every handler. **Field names are camelCase, always** — the `.env` keys
 * (`SUDO_PASSWORD`) and TOML keys (`sudo_password`) are source syntax and are
 * mapped here; they never survive into a resolved config.
 *
 * This is the contract that broke in issue #49: handlers kept reading the
 * pre-v3.0.0 snake_case names, which silently evaluated to `undefined`. Anything
 * typed as a `ServerConfig` now makes that a type error rather than a runtime
 * no-op. `tests/test-config-field-names.js` guards the same contract at runtime.
 */
export interface ServerConfig {
  /** Normalized (lowercased) server name. */
  name: string;
  /** Hostname or IP address. */
  host: string;
  /** SSH user. */
  user?: string;
  /** Password for password authentication. */
  password?: string;
  /** Path to the private key (`KEYPATH` / `key_path`). */
  keyPath?: string;
  /** Passphrase for a protected private key. */
  passphrase?: string;
  /** TCP port; defaults to 22. */
  port?: number;
  /** Working directory used when a tool omits `cwd`. */
  defaultDir?: string;
  /** Password piped to `sudo -S`. */
  sudoPassword?: string;
  /** Free-form description. */
  description?: string;
  /** Free-form group label; also feeds server groups. */
  group?: string;
  /** `'linux'` (default) or `'windows'`. */
  platform?: string;
  /** Name of another configured server to jump through. */
  proxyJump?: string;
  /** Custom proxy command (`%h` / `%p` placeholders). */
  proxyCommand?: string;
  /** Forward the local ssh-agent to this server. */
  forwardAgent?: boolean;
  /** Security mode: `unrestricted`, `readonly` or `restricted`. */
  mode?: string;
  /** Regex sources allowed in `restricted` mode. */
  allowPatterns?: string[];
  /** Regex sources always refused. */
  denyPatterns?: string[];
  /** Path to a per-server audit log. */
  auditLog?: string;
  /** Which configuration source won for this server. */
  source?: 'env' | 'toml';
}

// Normalize a mode string. Returns 'unrestricted' for any falsy/unknown input,
// after logging a warning when the input is set but invalid. This keeps existing
// configs (no MODE field) on the fast path. Key mapping and value coercion live
// in server-fields.js; only mode *validation* is a loader concern.
function normalizeMode(raw, serverName) {
  if (raw === undefined || raw === null || raw === '') return 'unrestricted';
  const normalized = String(raw).toLowerCase().trim();
  if (!VALID_MODES.has(normalized)) {
    logger.warn(
      `Unknown security mode "${raw}" for server "${serverName}" — falling back to "unrestricted". Valid: ${[...VALID_MODES].join(', ')}.`
    );
    return 'unrestricted';
  }
  return normalized;
}

export class ConfigLoader {
  servers: Map<string, ServerConfig>;
  configSource: string | null;

  constructor() {
    this.servers = new Map();
    this.configSource = null;
  }

  /**
   * Load configuration from multiple sources with priority:
   * 1. Environment variables (highest priority)
   * 2. .env file
   * 3. TOML config file (lowest priority)
   */
  async load(options: { envPath?: string; tomlPath?: string; preferToml?: boolean } = {}): Promise<Map<string, ServerConfig>> {
    const {
      envPath = path.join(process.cwd(), '.env'),
      tomlPath = process.env.SSH_CONFIG_PATH || path.join(os.homedir(), '.codex', 'ssh-config.toml'),
      preferToml = false
    } = options;

    // Clear existing servers
    this.servers.clear();

    // Load in reverse priority order (lowest to highest)
    let loadedFromToml = false;
    let loadedFromEnv = false;

    // Try loading TOML config first (lowest priority)
    if (fs.existsSync(tomlPath)) {
      try {
        await this.loadTomlConfig(tomlPath);
        loadedFromToml = true;
        logger.info(`Loaded SSH configuration from TOML: ${tomlPath}`);
      } catch (error) {
        logger.warn(`Failed to load TOML config: ${error.message}`);
      }
    }

    // Load .env file (higher priority, overwrites TOML)
    if (!preferToml && fs.existsSync(envPath)) {
      try {
        this.loadEnvConfig(envPath);
        loadedFromEnv = true;
        logger.info(`Loaded SSH configuration from .env: ${envPath}`);
      } catch (error) {
        logger.warn(`Failed to load .env config: ${error.message}`);
      }
    }

    // Load from environment variables (highest priority, overwrites everything)
    this.loadEnvironmentVariables();

    // Determine primary config source
    if (loadedFromEnv) {
      this.configSource = 'env';
    } else if (loadedFromToml) {
      this.configSource = 'toml';
    } else if (this.servers.size > 0) {
      this.configSource = 'environment';
    } else {
      this.configSource = null;
      logger.warn('No SSH server configurations found');
    }

    return this.servers;
  }

  /**
   * Load configuration from TOML file
   */
  async loadTomlConfig(tomlPath) {
    const content = fs.readFileSync(tomlPath, 'utf8');
    const config = TOML.parse(content);

    if (config.ssh_servers) {
      for (const [name, serverConfig] of Object.entries(config.ssh_servers)) {
        const normalizedName = name.toLowerCase();
        // Field names, alias chains and value coercion come from the shared
        // SERVER_FIELDS table (src/server-fields.ts) — the same single source
        // of truth the CLI-side writer consumes. Cast: the builder returns a
        // wide value union; per-field types are guaranteed by the table.
        const raw = /** @type {any} */ (serverFromTomlRecord(serverConfig));
        const allow = raw.allowPatterns || [];
        const deny = raw.denyPatterns || [];
        const mode = normalizeMode(raw.mode, normalizedName);
        if (mode === 'restricted' && allow.length === 0) {
          logger.warn(
            `Server "${normalizedName}" is in "restricted" mode but has no allow_patterns — every command will be refused. Set allow_patterns to enable any execution.`
          );
        }

        this.servers.set(normalizedName, {
          name: normalizedName,
          ...raw,
          host: raw.host,
          port: raw.port || 22,
          mode,
          allowPatterns: allow,
          denyPatterns: deny,
          source: 'toml'
        });
      }
    }
  }

  /**
   * Load configuration from .env file
   */
  loadEnvConfig(envPath) {
    const result = dotenv.config({ path: envPath, processEnv: {} });
    if (result.error) {
      throw result.error;
    }

    this.parseEnvVariables({
      ...process.env,
      ...(result.parsed || {})
    });
  }

  /**
   * Load configuration from environment variables
   */
  loadEnvironmentVariables() {
    this.parseEnvVariables(process.env);
  }

  /**
   * Parse environment variables for SSH server configurations
   */
  parseEnvVariables(env: Record<string, string | undefined>) {
    const serverPattern = /^SSH_SERVER_([A-Z0-9_]+)_HOST$/;
    const processedServers = new Set();

    for (const [key, value] of Object.entries(env)) {
      const match = key.match(serverPattern);
      if (!match) continue;

      const serverName = match[1].toLowerCase();

      // Skip if already processed from a higher priority source
      if (processedServers.has(serverName)) continue;

      // Field names and coercion come from the shared SERVER_FIELDS table
      // (src/server-fields.ts) — the same table the CLI-side writer uses.
      // Cast: wide value union; per-field types are guaranteed by the table.
      const raw = /** @type {any} */ (serverFromEnvRecord(env, match[1]));
      const allow = raw.allowPatterns || [];
      const mode = normalizeMode(raw.mode, serverName);
      if (mode === 'restricted' && allow.length === 0) {
        logger.warn(
          `Server "${serverName}" is in "restricted" mode but has no SSH_SERVER_${match[1]}_ALLOW_PATTERNS — every command will be refused. Set ALLOW_PATTERNS to enable any execution.`
        );
      }

      const server: ServerConfig = {
        name: serverName,
        ...raw,
        // The key matched SSH_SERVER_<NAME>_HOST, so the value is present.
        host: value as string,
        // Matches the pre-table behaviour: a missing PORT becomes 22, while a
        // non-numeric PORT stays NaN (surfaced to the user) rather than
        // silently defaulting.
        port: raw.port ?? 22,
        mode,
        allowPatterns: allow,
        denyPatterns: raw.denyPatterns || [],
        source: 'env'
      };

      this.servers.set(serverName, server);
      processedServers.add(serverName);
    }
  }

  /**
   * Get server configuration by name
   *
   * @param {string} name
   * @returns {ServerConfig|undefined}
   */
  getServer(name) {
    return this.servers.get(name.toLowerCase());
  }

  /**
   * Get all server configurations
   *
   * @returns {ServerConfig[]}
   */
  getAllServers() {
    return Array.from(this.servers.values());
  }

  /**
   * Check if server exists
   */
  hasServer(name) {
    return this.servers.has(name.toLowerCase());
  }

  /**
   * Export current configuration to TOML format. Keys come from the shared
   * SERVER_FIELDS table (canonical alias = toml[0]); only fields with a value
   * are emitted, plus the security-field clean-up rules noted inline.
   */
  exportToToml() {
    const config = {
      ssh_servers: {} as Record<string, any>
    };

    for (const [name, server] of this.servers) {
      /** @type {Record<string, any>} */
      const serverConfig = {
        host: server.host,
        user: server.user,
        port: server.port
      };

      for (const spec of SERVER_FIELDS) {
        if (spec.camel === 'host' || spec.camel === 'user' || spec.camel === 'port') continue; // always emitted above
        const value = server[spec.camel];
        // Only emit when opted in, so generated TOML stays clean by default.
        if (spec.camel === 'forwardAgent') {
          if (value === true) serverConfig[canonicalTomlKey(spec)] = true;
          continue;
        }
        // Only emit security fields if they diverge from defaults — keeps
        // generated TOML files clean for users who never opted in.
        if (spec.camel === 'mode') {
          if (value && value !== 'unrestricted') serverConfig[canonicalTomlKey(spec)] = value;
          continue;
        }
        if (spec.camel === 'allowPatterns' || spec.camel === 'denyPatterns') {
          if (Array.isArray(value) && value.length > 0) serverConfig[canonicalTomlKey(spec)] = value;
          continue;
        }
        if (value) serverConfig[canonicalTomlKey(spec)] = value;
      }

      config.ssh_servers[name] = serverConfig;
    }

    return TOML.stringify(config);
  }

  /**
   * Export current configuration to .env format. Lines come from the shared
   * SERVER_FIELDS table (same key names and quoting rules the CLI writer
   * uses), including FORWARD_AGENT — which the pre-table hand-rolled version
   * silently dropped on env export.
   */
  exportToEnv() {
    const lines = ['# SSH Server Configuration'];
    lines.push('# Generated by MCP SSH Manager');
    lines.push('');

    for (const [name, server] of this.servers) {
      const upperName = name.toUpperCase();
      lines.push(`# Server: ${name}`);

      for (const spec of SERVER_FIELDS) {
        const value = server[spec.camel];
        switch (spec.camel) {
        case 'host':
        case 'user':
          // Always emitted; unquoted (machine-shaped values).
          lines.push(serverEnvLine(upperName, spec, value));
          break;
        case 'port':
          lines.push(serverEnvLine(upperName, spec, value || 22));
          break;
        case 'forwardAgent':
          // Only emit when opted in, matching the TOML export rule.
          if (value === true) lines.push(serverEnvLine(upperName, spec, 'true'));
          break;
        case 'mode':
          if (value && value !== 'unrestricted') {
            lines.push(serverEnvLine(upperName, spec, value));
          }
          break;
        case 'allowPatterns':
        case 'denyPatterns':
          if (Array.isArray(value) && value.length > 0) {
            lines.push(serverEnvLine(upperName, spec, value));
          }
          break;
        default:
          if (value) lines.push(serverEnvLine(upperName, spec, value));
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Save configuration to Codex TOML format
   */
  async saveToCodexConfig(codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')) {
    // Existing Codex config may hold arbitrary keys; keep it loose.
    let config: Record<string, any> = {};

    // Load existing config if it exists
    if (fs.existsSync(codexConfigPath)) {
      const content = fs.readFileSync(codexConfigPath, 'utf8');
      config = TOML.parse(content);
    }

    // Add MCP server configuration
    if (!config.mcp_servers) {
      config.mcp_servers = {};
    }

    config.mcp_servers['ssh-manager'] = {
      command: 'node',
      args: [path.join(process.cwd(), 'src', 'index.ts')],
      env: {
        SSH_CONFIG_PATH: path.join(os.homedir(), '.codex', 'ssh-config.toml')
      },
      startup_timeout_ms: 20000
    };

    // Write back to config file
    const tomlContent = TOML.stringify(config);
    fs.writeFileSync(codexConfigPath, tomlContent, 'utf8');

    logger.info(`Updated Codex configuration at ${codexConfigPath}`);
  }

  /**
   * Migrate .env configuration to TOML
   */
  async migrateEnvToToml(envPath, tomlPath) {
    // Load from .env
    this.servers.clear();
    this.loadEnvConfig(envPath);

    // Export to TOML
    const tomlContent = this.exportToToml();

    // Ensure directory exists
    const tomlDir = path.dirname(tomlPath);
    if (!fs.existsSync(tomlDir)) {
      fs.mkdirSync(tomlDir, { recursive: true });
    }

    // Write TOML file
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');

    logger.info(`Migrated ${this.servers.size} servers from ${envPath} to ${tomlPath}`);
    return this.servers.size;
  }
}
