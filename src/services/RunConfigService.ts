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
    // Preserve user-given order — folders were sorted alphabetically
    // in early versions; once drag-and-drop landed, the array is the
    // user's order, not a derived sort.
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const p of groups) {
      if (!seen.has(p)) { seen.add(p); dedup.push(p); }
    }
    await this.store.write(folderKey, { ...file, groups: dedup });
  }

  // Move one config to a target index in the configurations array,
  // optionally also reassigning its `group` field. Used by the
  // tree's drag-and-drop reorder flow. Single write — no race
  // between the move and the group reassign.
  async moveConfigToIndex(
    folderKey: string,
    configId: string,
    targetIndex: number,
    newGroup: string | undefined,
  ): Promise<void> {
    const file = this.store.getForFolder(folderKey);
    const fromIdx = file.configurations.findIndex(c => c.id === configId);
    if (fromIdx === -1) throw new Error(`Config not found: ${configId}`);
    const cfg = file.configurations[fromIdx];

    // Apply the group reassignment to a copy of the config first.
    let nextCfg: RunConfig;
    if (newGroup === undefined || newGroup === '') {
      const { group: _drop, ...rest } = cfg;
      void _drop;
      nextCfg = rest as RunConfig;
    } else {
      nextCfg = { ...cfg, group: newGroup };
    }

    // Remove from old position, splice into the new one. Adjust the
    // target when removing from before it (the array shifts left by
    // one in that case).
    const without = [
      ...file.configurations.slice(0, fromIdx),
      ...file.configurations.slice(fromIdx + 1),
    ];
    let idx = targetIndex;
    if (fromIdx < idx) idx -= 1;
    if (idx < 0) idx = 0;
    if (idx > without.length) idx = without.length;
    const next = [...without.slice(0, idx), nextCfg, ...without.slice(idx)];

    await this.store.write(folderKey, { ...file, configurations: next });
  }
}
