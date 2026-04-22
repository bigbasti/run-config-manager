import type { ConfigStore } from './ConfigStore';
import type { RunConfig } from '../shared/types';
import { newId } from '../utils/uuid';

export interface ConfigRef {
  folderKey: string;
  config: RunConfig;
}

export class RunConfigService {
  constructor(private readonly store: ConfigStore) {}

  list(): ConfigRef[] {
    const out: ConfigRef[] = [];
    for (const key of this.store.folderKeys()) {
      for (const cfg of this.store.getForFolder(key).configurations) {
        out.push({ folderKey: key, config: cfg });
      }
    }
    return out;
  }

  getById(id: string): ConfigRef | undefined {
    return this.list().find(r => r.config.id === id);
  }

  async create(folderKey: string, data: Omit<RunConfig, 'id'>): Promise<RunConfig> {
    const cfg: RunConfig = { ...data, id: newId() };
    const file = this.store.getForFolder(folderKey);
    await this.store.write(folderKey, {
      ...file,
      configurations: [...file.configurations, cfg],
    });
    return cfg;
  }

  async update(folderKey: string, cfg: RunConfig): Promise<void> {
    const file = this.store.getForFolder(folderKey);
    const idx = file.configurations.findIndex(c => c.id === cfg.id);
    if (idx === -1) throw new Error(`Configuration not found: ${cfg.id}`);
    const next = [...file.configurations];
    next[idx] = cfg;
    await this.store.write(folderKey, { ...file, configurations: next });
  }

  async delete(folderKey: string, id: string): Promise<void> {
    const file = this.store.getForFolder(folderKey);
    const next = file.configurations.filter(c => c.id !== id);
    if (next.length === file.configurations.length) return; // no-op
    await this.store.write(folderKey, { ...file, configurations: next });
  }
}
