import { readStateFileText, writeStateFileText } from './state-files.ts';

/**
 * Server alias management
 * Allows using aliases like "prod" instead of full server names
 */

const ALIASES_FILE = '.server-aliases.json';

/**
 * Load server aliases from the state file (~/.ssh4agent, with one-time
 * migration from the legacy install directory — see src/state-files.ts).
 */
function loadAliases(): Record<string, string> {
  try {
    const content = readStateFileText(ALIASES_FILE);
    if (content) {
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`Warning: Could not load aliases: ${error.message}`);
  }
  return {};
}

/**
 * Save server aliases to the state file
 */
function saveAliases(aliases) {
  return writeStateFileText(ALIASES_FILE, JSON.stringify(aliases, null, 2));
}

/**
 * Resolve server name from alias.
 *
 * `aliasesOverride` lets callers (and tests) inject a mapping without touching
 * the aliases file; omitted → read from disk as usual.
 */
export function resolveServerName(nameOrAlias, servers, aliasesOverride?) {
  const aliases = aliasesOverride ?? loadAliases();

  // Check if it's an alias. Own-property + string guard: a bare truthy
  // lookup would also catch INHERITED Object.prototype members (`toString`
  // is a function) and `.toLowerCase()` on one throws (PR #9 review).
  // The target is lowercased because it names a server, and config keys
  // are lowercased on load: returning `Prod-Web` verbatim makes every
  // later `servers[name]` lookup miss and a live server is misreported as
  // a stale alias (PR #9 review, round 2).
  if (Object.hasOwn(aliases, nameOrAlias) && typeof aliases[nameOrAlias] === 'string') {
    return aliases[nameOrAlias].toLowerCase();
  }

  // Check if it's a direct server name
  const normalizedName = nameOrAlias.toLowerCase();
  if (servers[normalizedName]) {
    return normalizedName;
  }

  // Try to find partial match
  const serverNames = Object.keys(servers);
  const matches = serverNames.filter((name) => name.includes(normalizedName));

  if (matches.length === 1) {
    return matches[0];
  } else if (matches.length > 1) {
    throw new Error(`Ambiguous server name "${nameOrAlias}". Matches: ${matches.join(', ')}`);
  }

  // Check if nameOrAlias contains a domain that matches a server
  if (nameOrAlias.includes('.')) {
    const matchingServer = serverNames.find((name) => {
      const serverHost = servers[name].host;
      return (
        serverHost &&
        (serverHost === nameOrAlias ||
          serverHost.includes(nameOrAlias) ||
          nameOrAlias.includes(serverHost))
      );
    });

    if (matchingServer) {
      return matchingServer;
    }
  }

  return null;
}

/**
 * Single server resolution interface: alias → real name → prefix match →
 * domain match (same order as resolveServerName), returning BOTH the
 * canonical name and the full resolved config.
 *
 * This is the one path every config consumer must go through. Looking up
 * `servers[name.toLowerCase()]` directly silently skips alias expansion, so a
 * server reached via alias appears unconfigured — and an unconfigured server
 * degrades to `unrestricted` in policy evaluation (issue #1: an alias could
 * bypass a readonly/restricted policy).
 *
 * Returns `{ name, config }`, or null when nothing matches / the resolved
 * name has no config entry. Never throws for a miss (ambiguity still throws,
 * matching resolveServerName semantics).
 */
export function resolveServer(nameOrAlias, servers, aliasesOverride?) {
  const name = resolveServerName(nameOrAlias, servers, aliasesOverride);
  if (!name) return null;
  return { name, config: servers[name] || null };
}

/**
 * Add or update an alias
 */
export function addAlias(alias, serverName) {
  const aliases = loadAliases();
  aliases[alias] = serverName;
  return saveAliases(aliases);
}

/**
 * Remove an alias
 */
export function removeAlias(alias) {
  const aliases = loadAliases();
  delete aliases[alias];
  return saveAliases(aliases);
}

/**
 * List all aliases with their targets
 */
export function listAliases() {
  const aliases = loadAliases();
  return Object.entries(aliases).map(([alias, target]) => ({
    alias,
    target,
  }));
}
