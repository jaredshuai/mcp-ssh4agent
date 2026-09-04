/**
 * Tool Configuration Manager
 *
 * Manages tool enablement configuration stored in JSON format.
 * Handles loading, saving, and querying tool configuration.
 *
 * Shared by BOTH the MCP entry point and the ssh4agent CLI: this module is
 * deliberately free of logger (or any stateful) imports — a config store
 * deciding the logging mechanism was over-reach, and the CLI must import it
 * without side effects (no dirs created, no log files opened). Diagnostics
 * belong to the callers.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { TOOL_GROUPS, findToolGroup, getAllTools } from './tool-registry.ts';

/**
 * Configuration file location
 * User-global only: ~/.ssh4agent/tools-config.json
 */
const CONFIG_DIR = path.join(os.homedir(), '.ssh4agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'tools-config.json');
// Pre-rebrand location; kept as a read-only fallback (writes always go to CONFIG_FILE).
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.ssh-manager', 'tools-config.json');

function resolveReadPath(): string {
  return !fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG_FILE)
    ? LEGACY_CONFIG_FILE
    : CONFIG_FILE;
}

/**
 * Tool Configuration Manager Class
 */
class ToolConfigManager {
  // Loaded JSON config; shape varies by mode, null before load().
  config: any;
  configPath: string;

  constructor() {
    this.config = null;
    this.configPath = CONFIG_FILE;
  }

  /**
   * Load tool configuration from file
   * @returns {Promise<Object>} Configuration object
   */
  async load() {
    try {
      const readPath = resolveReadPath();
      if (fs.existsSync(readPath)) {
        const content = fs.readFileSync(readPath, 'utf8');
        this.config = JSON.parse(content);

        // Validate config structure
        if (!this.validateConfig(this.config)) {
          this.config = this.getDefaultConfig();
        }
      } else {
        // No config file - default to all tools enabled
        this.config = this.getDefaultConfig();
      }
    } catch {
      this.config = this.getDefaultConfig();
    }

    return this.config;
  }

  /**
   * Get default configuration (all tools enabled)
   * @returns {Object} Default configuration
   */
  getDefaultConfig() {
    return {
      version: '1.0',
      mode: 'all',
      groups: {
        core: { enabled: true },
        sessions: { enabled: true },
        monitoring: { enabled: true },
        backup: { enabled: true },
        database: { enabled: true },
        advanced: { enabled: true },
      },
      tools: {},
      _comment:
        'Tool configuration for MCP SSH4Agent. Run "ssh4agent tools configure" to customize.',
    };
  }

  /**
   * Validate configuration structure
   * @param {Object} config - Configuration to validate
   * @returns {boolean} True if valid
   */
  validateConfig(config) {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // Check required fields
    if (!config.version || !config.mode) {
      return false;
    }

    // Validate mode
    if (!['all', 'minimal', 'custom'].includes(config.mode)) {
      return false;
    }

    // Check groups structure
    if (config.mode === 'custom' && !config.groups) {
      return false;
    }

    return true;
  }

  /**
   * Check if a specific tool is enabled
   * @param {string} toolName - Name of the tool
   * @returns {boolean} True if enabled
   */
  isToolEnabled(toolName) {
    if (!this.config) {
      return true; // Default to enabled if no config loaded
    }

    // Per-tool override wins in EVERY mode — it is the fine-grained
    // correction, checked before the coarse mode/group rules. (Checking it
    // after the mode switch made overrides dead config in 'all' mode.)
    if (this.config.tools && toolName in this.config.tools) {
      return this.config.tools[toolName];
    }

    // Mode: all - everything enabled
    if (this.config.mode === 'all') {
      return true;
    }

    // Mode: minimal - only core tools
    if (this.config.mode === 'minimal') {
      const group = findToolGroup(toolName);
      return group === 'core';
    }

    // Mode: custom - check group setting
    if (this.config.mode === 'custom') {
      const group = findToolGroup(toolName);
      if (group && this.config.groups && group in this.config.groups) {
        return this.config.groups[group].enabled;
      }
    }

    // Default to enabled if group not found (for new tools in updates)
    return true;
  }

  /**
   * Get array of all enabled tool names
   * @returns {string[]} Array of enabled tool names
   */
  getEnabledTools() {
    const allTools = getAllTools();
    return allTools.filter((tool) => this.isToolEnabled(tool));
  }

  /**
   * Get array of all disabled tool names
   * @returns {string[]} Array of disabled tool names
   */
  getDisabledTools() {
    const allTools = getAllTools();
    return allTools.filter((tool) => !this.isToolEnabled(tool));
  }

  /**
   * Check if a group is enabled
   * @param {string} groupName - Name of the group
   * @returns {boolean} True if enabled
   */
  isGroupEnabled(groupName) {
    if (!this.config) {
      return true;
    }

    if (this.config.mode === 'all') {
      return true;
    }

    if (this.config.mode === 'minimal') {
      return groupName === 'core';
    }

    if (this.config.mode === 'custom' && this.config.groups) {
      return this.config.groups[groupName]?.enabled ?? true;
    }

    return true;
  }

  /**
   * Save configuration to file
   * @returns {Promise<boolean>} True if saved successfully
   */
  async save() {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      // Write config file
      const content = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, content, 'utf8');

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Materialize the CURRENT effective group state into `groups` and switch to
   * custom mode. This is what mode transitions run through: from 'all' every
   * group is on; from 'minimal' only core is. Without materializing first, a
   * single enable from minimal mode left the unmentioned groups at their
   * DEFAULT-ON value — enabling one group silently enabled all 37 tools.
   */
  #materializeCustom() {
    for (const groupName of Object.keys(TOOL_GROUPS)) {
      this.config.groups[groupName] = { enabled: this.isGroupEnabled(groupName) };
    }
    this.config.mode = 'custom';
  }

  /**
   * Enable a tool group
   * @param {string} groupName - Name of the group to enable
   * @returns {Promise<boolean>} True if successful
   */
  async enableGroup(groupName) {
    if (!TOOL_GROUPS[groupName]) {
      return false;
    }

    if (this.config.mode !== 'custom') {
      this.#materializeCustom();
    }

    // Initialize groups if needed
    if (!this.config.groups) {
      this.config.groups = {};
    }

    // Enable the group
    this.config.groups[groupName] = { enabled: true };

    return await this.save();
  }

  /**
   * Disable a tool group
   * @param {string} groupName - Name of the group to disable
   * @returns {Promise<boolean>} True if successful
   */
  async disableGroup(groupName) {
    if (!TOOL_GROUPS[groupName]) {
      return false;
    }

    if (groupName === 'core') {
      return false;
    }

    if (this.config.mode !== 'custom') {
      this.#materializeCustom();
    }

    // Initialize groups if needed
    if (!this.config.groups) {
      this.config.groups = {};
    }

    // Disable the group
    this.config.groups[groupName] = { enabled: false };

    return await this.save();
  }

  /**
   * Enable a specific tool (individual override)
   * @param {string} toolName - Name of the tool to enable
   * @returns {Promise<boolean>} True if successful
   */
  async enableTool(toolName) {
    const allTools = getAllTools();
    if (!allTools.includes(toolName)) {
      return false;
    }

    // Initialize tools object if needed
    if (!this.config.tools) {
      this.config.tools = {};
    }

    // Enable the tool
    this.config.tools[toolName] = true;

    return await this.save();
  }

  /**
   * Disable a specific tool (individual override)
   * @param {string} toolName - Name of the tool to disable
   * @returns {Promise<boolean>} True if successful
   */
  async disableTool(toolName) {
    const allTools = getAllTools();
    if (!allTools.includes(toolName)) {
      return false;
    }

    // Initialize tools object if needed
    if (!this.config.tools) {
      this.config.tools = {};
    }

    // Disable the tool
    this.config.tools[toolName] = false;

    return await this.save();
  }

  /**
   * Set configuration mode
   * @param {string} mode - Mode to set ('all', 'minimal', 'custom')
   * @returns {Promise<boolean>} True if successful
   */
  async setMode(mode) {
    if (!['all', 'minimal', 'custom'].includes(mode)) {
      return false;
    }

    this.config.mode = mode;
    return await this.save();
  }

  /**
   * Replace the whole configuration in one shot (the CLI wizard's write path):
   * validates, assigns and persists. Returns false without writing when the
   * shape is invalid.
   * @param {Object} config - Full configuration object (mode/groups/tools)
   * @returns {Promise<boolean>} True if saved successfully
   */
  async replaceConfig(config) {
    if (!this.validateConfig(config)) {
      return false;
    }
    this.config = config;
    return await this.save();
  }

  /**
   * Reset configuration to defaults. Writes the default (mode: all) to
   * CONFIG_FILE — writing, not deleting: deleting the new file would let a
   * legacy ~/.ssh-manager/tools-config.json resurrect on the next load.
   * @returns {Promise<boolean>} True if successful
   */
  async reset() {
    this.config = this.getDefaultConfig();
    return await this.save();
  }

  /**
   * Get configuration summary
   * @returns {Object} Summary object
   */
  getSummary() {
    const enabledTools = this.getEnabledTools();
    const disabledTools = this.getDisabledTools();
    const totalTools = getAllTools().length;

    return {
      mode: this.config.mode,
      configPath: this.configPath,
      totalTools,
      enabledCount: enabledTools.length,
      disabledCount: disabledTools.length,
      groups: Object.keys(TOOL_GROUPS).map((groupName) => ({
        name: groupName,
        enabled: this.isGroupEnabled(groupName),
        toolCount: TOOL_GROUPS[groupName].length,
      })),
    };
  }

  /**
   * Export Claude Code auto-approval configuration
   * @returns {Object} Auto-approval config snippet
   */
  exportClaudeCodeConfig() {
    const enabledTools = this.getEnabledTools();

    const autoApprovalPatterns = enabledTools.map((tool) => `mcp__ssh4agent__${tool}`);

    return {
      comment: 'Add these patterns to autoApprove.tools in claude_code_config.json',
      patterns: autoApprovalPatterns,
      exampleConfig: {
        autoApprove: {
          tools: autoApprovalPatterns,
        },
      },
    };
  }
}

/**
 * Singleton instance
 */
let toolConfigInstance = null;

/**
 * Load tool configuration (singleton)
 * @returns {Promise<ToolConfigManager>} Configuration manager instance
 */
export async function loadToolConfig() {
  if (!toolConfigInstance) {
    toolConfigInstance = new ToolConfigManager();
    await toolConfigInstance.load();
  }
  return toolConfigInstance;
}

/**
 * Check if a tool is enabled (convenience function)
 * @param {string} toolName - Name of the tool
 * @returns {boolean} True if enabled
 */
export function isToolEnabled(toolName) {
  if (!toolConfigInstance) {
    return true; // Default to enabled before config is loaded
  }
  return toolConfigInstance.isToolEnabled(toolName);
}

/**
 * Fresh (non-singleton) manager for CLI one-shot commands: loads the current
 * config from disk, unaffected by — and unable to mutate — the MCP server's
 * singleton. The CLI's process is short-lived, so it never needs the cache.
 * @returns {Promise<ToolConfigManager>} Loaded manager instance
 */
export async function loadFreshToolConfig() {
  const manager = new ToolConfigManager();
  await manager.load();
  return manager;
}

/**
 * Where the config lives (display + existence checks in the CLI).
 * Not part of ToolConfigManager: the path is a module-level constant, and
 * the CLI shouldn't need an instance to know it.
 */
export const TOOLS_CONFIG_FILE = CONFIG_FILE;
