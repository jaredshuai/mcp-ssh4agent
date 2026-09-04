/**
 * Profile Loader for SSH4Agent
 * Loads configuration profiles for different project types
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readStateFileText, writeStateFileText, legacyStateFilePath } from './state-files.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read-only bundled profile definitions — package data, NOT user state, so
// living in the install directory is correct.
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
// The active-profile pointer IS user state: it lives in the state dir
// (~/.ssh4agent, issue #8). readStateFileText migrates the install-dir
// `.ssh4agent-profile` on first read; the pre-rebrand `.ssh-manager-profile`
// is handled explicitly below.
const PROFILE_STATE_NAME = '.ssh4agent-profile';
const LEGACY_PROFILE_STATE_NAME = '.ssh-manager-profile';

/**
 * Get the active profile name
 */
export function getActiveProfileName() {
  // 1. Check environment variable
  if (process.env.SSH4AGENT_PROFILE) {
    return process.env.SSH4AGENT_PROFILE;
  }

  // 2. Check the state file (with one-time migration from the install-dir
  //    `.ssh4agent-profile` built into readStateFileText).
  let content = readStateFileText(PROFILE_STATE_NAME);

  // Pre-rebrand fallback: the install-dir `.ssh-manager-profile`. Migrated
  // best-effort into the state dir under the new name, same one-time-move
  // contract as every other state file.
  if (content === null) {
    const legacy = legacyStateFilePath(LEGACY_PROFILE_STATE_NAME);
    if (fs.existsSync(legacy)) {
      try {
        content = fs.readFileSync(legacy, 'utf8');
      } catch (error) {
        console.error(`Error reading legacy profile config: ${error.message}`);
        content = null;
      }
      if (content !== null) {
        writeStateFileText(PROFILE_STATE_NAME, content);
      }
    }
  }

  if (content !== null) {
    const profileName = content.trim();
    if (profileName) {
      return profileName;
    }
  }

  // 3. Default to 'default' profile
  return 'default';
}

/**
 * Load a profile by name
 */
export function loadProfile(profileName = null) {
  const name = profileName || getActiveProfileName();
  const profilePath = path.join(PROFILES_DIR, `${name}.json`);

  try {
    if (fs.existsSync(profilePath)) {
      const profileData = fs.readFileSync(profilePath, 'utf8');
      const profile = JSON.parse(profileData);

      console.error(`📦 Loaded profile: ${profile.name} - ${profile.description}`);
      return profile;
    } else {
      console.error(`⚠️  Profile '${name}' not found, using default profile`);
      return loadDefaultProfile();
    }
  } catch (error) {
    console.error(`❌ Error loading profile '${name}': ${error.message}`);
    return loadDefaultProfile();
  }
}

/**
 * Load the default profile
 */
function loadDefaultProfile() {
  const defaultPath = path.join(PROFILES_DIR, 'default.json');

  try {
    if (fs.existsSync(defaultPath)) {
      const profileData = fs.readFileSync(defaultPath, 'utf8');
      return JSON.parse(profileData);
    }
  } catch (error) {
    console.error(`Error loading default profile: ${error.message}`);
  }

  // Return minimal profile if default doesn't exist
  return {
    name: 'minimal',
    description: 'Minimal profile',
    commandAliases: {},
    hooks: {},
  };
}

/**
 * List all available profiles
 */
export function listProfiles() {
  try {
    const files = fs.readdirSync(PROFILES_DIR);
    const profiles = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const profilePath = path.join(PROFILES_DIR, file);
        try {
          const data = fs.readFileSync(profilePath, 'utf8');
          const profile = JSON.parse(data);
          profiles.push({
            name: profile.name || file.replace('.json', ''),
            description: profile.description || 'No description',
            file: file,
            aliasCount: Object.keys(profile.commandAliases || {}).length,
            hookCount: Object.keys(profile.hooks || {}).length,
          });
        } catch (error) {
          console.error(`Error reading profile ${file}: ${error.message}`);
        }
      }
    }

    return profiles;
  } catch (error) {
    console.error(`Error listing profiles: ${error.message}`);
    return [];
  }
}

/**
 * Set the active profile
 */
export function setActiveProfile(profileName) {
  try {
    // Verify profile exists
    const profilePath = path.join(PROFILES_DIR, `${profileName}.json`);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`Profile '${profileName}' does not exist`);
    }

    // Write to the state dir — never the install directory (issue #8: a
    // global npm install makes it read-only, so the write used to fail at
    // runtime).
    return writeStateFileText(PROFILE_STATE_NAME, profileName);
  } catch (error) {
    console.error(`Error setting active profile: ${error.message}`);
    return false;
  }
}
