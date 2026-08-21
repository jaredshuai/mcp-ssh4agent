import path from 'path';
import crypto from 'crypto';
import { shSingleQuote, buildSudoPipeline } from './shell-quote.js';

/**
 * Deploy helper functions for secure file deployment
 */

/**
 * Generate a unique temporary filename
 */
export function getTempFilename(originalName) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  return `/tmp/${base}_${timestamp}_${random}${ext}`;
}

/**
 * Build deployment strategy based on target path and permissions
 */
export function buildDeploymentStrategy(remotePath, options = {}) {
  const {
    sudoPassword = null,
    owner = null,
    permissions = null,
    backup = true,
    restart = null
  } = options;

  const strategy = {
    steps: [],
    requiresSudo: false
  };

  // Step 1: Backup existing file if requested
  if (backup) {
    strategy.steps.push({
      type: 'backup',
      command: `if [ -f "${remotePath}" ]; then cp "${remotePath}" "${remotePath}.bak.$(date +%Y%m%d_%H%M%S)"; fi`
    });
  }

  // Step 2: Determine if we need sudo
  const needsSudo = remotePath.startsWith('/etc/') ||
                    remotePath.startsWith('/var/') ||
                    remotePath.startsWith('/usr/') ||
                    owner || permissions;

  if (needsSudo) {
    strategy.requiresSudo = true;
  }

  // Step 3: Copy from temp to final location
  const quotedRemotePath = shSingleQuote(remotePath);
  const copyCmd = needsSudo && sudoPassword ?
    buildSudoPipeline(sudoPassword, `cp {{tempFile}} ${quotedRemotePath}`).command :
    needsSudo ?
      `sudo cp {{tempFile}} ${quotedRemotePath}` :
      `cp {{tempFile}} ${quotedRemotePath}`;

  strategy.steps.push({
    type: 'copy',
    command: copyCmd
  });

  // Step 4: Set ownership if specified
  if (owner) {
    const chownCmd = sudoPassword ?
      buildSudoPipeline(sudoPassword, `chown ${owner} ${quotedRemotePath}`).command :
      `sudo chown ${owner} ${quotedRemotePath}`;

    strategy.steps.push({
      type: 'chown',
      command: chownCmd
    });
  }

  // Step 5: Set permissions if specified
  if (permissions) {
    const chmodCmd = sudoPassword ?
      buildSudoPipeline(sudoPassword, `chmod ${permissions} ${quotedRemotePath}`).command :
      `sudo chmod ${permissions} ${quotedRemotePath}`;

    strategy.steps.push({
      type: 'chmod',
      command: chmodCmd
    });
  }

  // Step 6: Restart service if specified
  if (restart) {
    strategy.steps.push({
      type: 'restart',
      command: restart
    });
  }

  // Step 7: Cleanup temp file
  strategy.steps.push({
    type: 'cleanup',
    command: 'rm -f {{tempFile}}'
  });

  return strategy;
}

/**
 * Parse deployment configuration from file path patterns
 * Examples:
 *   /home/user/app/file.js -> normal deploy
 *   /etc/nginx/sites-available/site -> needs sudo
 *   /var/www/html/index.html -> needs sudo
 */
export function detectDeploymentNeeds(remotePath) {
  const needs = {
    sudo: false,
    suggestedOwner: null,
    suggestedPerms: null
  };

  // System directories that typically need sudo
  if (remotePath.startsWith('/etc/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'root:root';
    needs.suggestedPerms = '644';
  } else if (remotePath.startsWith('/var/www/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'www-data:www-data';
    needs.suggestedPerms = '644';
  } else if (remotePath.includes('/nginx/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'root:root';
    needs.suggestedPerms = '644';
  } else if (remotePath.includes('/apache/') || remotePath.includes('/httpd/')) {
    needs.sudo = true;
    needs.suggestedOwner = 'www-data:www-data';
    needs.suggestedPerms = '644';
  } else if (remotePath.includes('/frappe-bench/')) {
    // For ERPNext/Frappe deployments
    needs.sudo = false;
    needs.suggestedOwner = null; // Will be handled by the app
    needs.suggestedPerms = '644';
  }

  return needs;
}
