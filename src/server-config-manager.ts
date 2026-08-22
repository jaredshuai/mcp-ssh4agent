import fs from 'fs';
import { ConfigLoader, type ServerConfig } from './config-loader.ts';
import { logger } from './logger.ts';

export class ServerConfigManager {
  envPath?: string;
  tomlPath?: string;
  preferToml: boolean;
  configLoader: ConfigLoader;
  /**
   * Loaded servers keyed by normalized name. camelCase fields only — see the
   * ServerConfig interface in config-loader.ts.
   */
  servers: Record<string, ServerConfig>;
  fileSignature: string | null;

  constructor({
    envPath,
    tomlPath,
    preferToml = false,
    configLoader = new ConfigLoader(),
  }: {
    envPath?: string;
    tomlPath?: string;
    preferToml?: boolean;
    configLoader?: ConfigLoader;
  }) {
    this.envPath = envPath;
    this.tomlPath = tomlPath;
    this.preferToml = preferToml;
    this.configLoader = configLoader;
    this.servers = {};
    this.fileSignature = null;
  }

  async loadInitial(): Promise<Record<string, ServerConfig>> {
    await this.reload();
    return this.servers;
  }

  async getServers(): Promise<Record<string, ServerConfig>> {
    if (this.hasFileBackedConfigChanged()) {
      await this.reload();
    }

    return this.servers;
  }

  hasFileBackedConfigChanged() {
    const currentSignature = this.getFileSignature();
    return this.fileSignature !== currentSignature;
  }

  async reload() {
    const previousServers = this.servers;
    const previousSignature = this.fileSignature;

    try {
      const loadedServers = await this.configLoader.load({
        envPath: this.envPath,
        tomlPath: this.tomlPath,
        preferToml: this.preferToml,
      });

      const nextServers: Record<string, ServerConfig> = {};
      for (const [name, config] of loadedServers) {
        nextServers[name] = config;
      }

      this.servers = nextServers;
      this.fileSignature = this.getFileSignature();
      return this.servers;
    } catch (error) {
      this.servers = previousServers;
      this.fileSignature = previousSignature;
      logger.error('Failed to reload server configuration', { error: error.message });
      return this.servers;
    }
  }

  getFileSignature() {
    return [
      this.getSingleFileSignature(this.tomlPath),
      this.getSingleFileSignature(this.envPath),
    ].join('|');
  }

  getSingleFileSignature(filePath?: string) {
    if (!filePath || !fs.existsSync(filePath)) {
      return `${filePath || ''}:missing`;
    }

    const stats = fs.statSync(filePath);
    return `${filePath}:${stats.mtimeMs}:${stats.size}`;
  }
}
