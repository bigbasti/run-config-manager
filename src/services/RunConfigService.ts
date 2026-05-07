import type { ConfigStore } from './ConfigStore';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';
import { newId } from '../utils/uuid';

export type ConfigRef =
  | { folderKey: string; config: RunConfig; valid: true }
  | { folderKey: string; config: InvalidConfigEntry; valid: false };

export class RunConfigService {
  constructor(private readonly store: ConfigStore) {}

  list(): ConfigRef[] {
    const out: ConfigRef[] = [];
    for (const key of this.store.folderKeys()) {
      for (const cfg of this.store.getForFolder(key).configurations) {
        out.push({ folderKey: key, config: cfg, valid: true });
      }
      for (const bad of this.store.invalidForFolder(key)) {
        out.push({ folderKey: key, config: bad, valid: false });
      }
    }
    return out;
  }

  getById(id: string): ConfigRef | undefined {
    return this.list().find(r => r.config.id === id);
  }

  async create(folderKey: string, data: Omit<RunConfig, 'id'>): Promise<RunConfig> {
    // Spread across a discriminated union loses the discriminant in TS;
    // the runtime shape is correct because `data` already matched one variant.
    const cfg = { ...data, id: newId() } as RunConfig;
    const file = this.store.getForFolder(folderKey);
    await this.store.write(folderKey, {
      ...file,
      configurations: [...file.configurations, cfg],
    });
    return cfg;
  }

  async update(folderKey: string, cfg: RunConfig): Promise<void> {
    const file = this.store.getForFolder(folderKey);
    const invalid = this.store.invalidForFolder(folderKey);

    const validIdx = file.configurations.findIndex(c => c.id === cfg.id);
    const wasInvalid = invalid.some(e => e.id === cfg.id);

    if (validIdx === -1 && !wasInvalid) {
      throw new Error(`Configuration not found: ${cfg.id}`);
    }

    const nextConfigs =
      validIdx === -1
        ? [...file.configurations, cfg]
        : file.configurations.map((c, i) => (i === validIdx ? cfg : c));

    await this.store.write(
      folderKey,
      { ...file, configurations: nextConfigs },
      { removeInvalidIds: [cfg.id] },
    );
  }

  async delete(folderKey: string, id: string): Promise<void> {
    const file = this.store.getForFolder(folderKey);
    const invalid = this.store.invalidForFolder(folderKey);

    const inValid = file.configurations.some(c => c.id === id);
    const inInvalid = invalid.some(e => e.id === id);
    if (!inValid && !inInvalid) return;

    const next = file.configurations.filter(c => c.id !== id);
    await this.store.write(
      folderKey,
      { ...file, configurations: next },
      { removeInvalidIds: [id] },
    );
  }

  // ---------------------------------------------------------------
  // Folder (group) CRUD — operates on the `groups` array of run.json.
  // GroupService consumes these; we keep the persistence here so all
  // writes go through ConfigStore's debounced save path.
  // ---------------------------------------------------------------

  knownFolders(folderKey: string): string[] {
    return this.store.getForFolder(folderKey).groups ?? [];
  }

  async setKnownFolders(folderKey: string, groups: string[]): Promise<void> {
    const file = this.store.getForFolder(folderKey);
    // Stable order on disk so diffs stay readable.
    const sorted = Array.from(new Set(groups)).sort();
    await this.store.write(folderKey, { ...file, groups: sorted });
  }
}
