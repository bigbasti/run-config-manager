import type * as vscode from 'vscode';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';
import { RunConfigSchema } from '../shared/schema';

export interface ConfigSummary {
  id: string;
  name: string;
  type: string;
  folderKey: string;
  valid: boolean;
}

export interface ValidateResult {
  ok: boolean;
  errors?: { path: string; message: string }[];
}

export interface BridgeServices {
  listConfigs(): ConfigSummary[];
  getConfig(id: string): RunConfig | InvalidConfigEntry | undefined;
  currentConfigs(): { folderKey: string; configurations: RunConfig[] }[];
  validateConfig(candidate: unknown): ValidateResult;
  createConfig(params: { config: unknown; workspaceFolder?: string }): Promise<{ id: string }>;
  updateConfig(config: unknown): Promise<void>;
  deleteConfig(id: string): Promise<void>;
  runConfig(id: string): Promise<void>;
  debugConfig(id: string): Promise<void>;
  stopConfig(id: string): Promise<void>;
}

// Narrow structural views of the real services — keeps this module unit-testable
// with plain fakes and free of concrete service imports.
export interface BridgeDeps {
  svc: {
    list(): { folderKey: string; config: RunConfig | InvalidConfigEntry; valid: boolean }[];
    getById(id: string):
      | { folderKey: string; config: RunConfig | InvalidConfigEntry; valid: boolean }
      | undefined;
    create(folderKey: string, data: Omit<RunConfig, 'id'>): Promise<RunConfig>;
    update(folderKey: string, cfg: RunConfig): Promise<void>;
    delete(folderKey: string, id: string): Promise<void>;
  };
  store: {
    folderKeys(): string[];
    getFolder(key: string): vscode.WorkspaceFolder | undefined;
    getForFolder(key: string): { configurations: RunConfig[] };
  };
  exec: {
    run(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<unknown>;
    stop(id: string): Promise<void>;
  };
  dbg: { debug(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<boolean> };
}

// A syntactically valid UUID used only to satisfy the schema's `id` field when
// validating a candidate that has not been assigned an id yet.
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

function issuesToErrors(issues: { path: (string | number)[]; message: string }[]) {
  return issues.map(i => ({ path: i.path.join('.'), message: i.message }));
}

export function createBridgeServices(deps: BridgeDeps): BridgeServices {
  const { svc, store, exec, dbg } = deps;

  const resolveValid = (id: string): { folderKey: string; config: RunConfig } => {
    const ref = svc.getById(id);
    if (!ref) throw new Error(`Configuration not found: ${id}`);
    if (!ref.valid) throw new Error(`Configuration is invalid: ${id}`);
    return ref as { folderKey: string; config: RunConfig };
  };

  const folderOrThrow = (key: string): vscode.WorkspaceFolder => {
    const f = store.getFolder(key);
    if (!f) throw new Error(`Unknown workspace folder: ${key}`);
    return f;
  };

  return {
    listConfigs: () =>
      svc.list().map(r => ({
        id: r.config.id,
        name: (r.config as { name?: string }).name ?? '(invalid)',
        type: (r.config as { type?: string }).type ?? 'invalid',
        folderKey: r.folderKey,
        valid: r.valid,
      })),

    getConfig: id => svc.getById(id)?.config,

    currentConfigs: () =>
      store.folderKeys().map(k => ({
        folderKey: k,
        configurations: store.getForFolder(k).configurations,
      })),

    validateConfig: candidate => {
      const res = RunConfigSchema.safeParse(candidate);
      if (res.success) return { ok: true };
      return { ok: false, errors: issuesToErrors(res.error.issues) };
    },

    createConfig: async ({ config, workspaceFolder }) => {
      const keys = store.folderKeys();
      let key = workspaceFolder;
      if (!key) {
        if (keys.length === 1) key = keys[0];
        else throw new Error(`workspaceFolder is required; choose one of: ${keys.join(', ')}`);
      }
      if (!keys.includes(key)) throw new Error(`Unknown workspace folder: ${key}`);

      const src = config as Record<string, unknown>;
      const parsed = RunConfigSchema.safeParse({ ...src, id: PLACEHOLDER_ID });
      if (!parsed.success) {
        throw new Error(
          `Invalid configuration: ${issuesToErrors(parsed.error.issues)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ')}`,
        );
      }
      const { id: _dropId, ...rest } = src;
      void _dropId;
      const created = await svc.create(key, rest as unknown as Omit<RunConfig, 'id'>);
      return { id: created.id };
    },

    updateConfig: async config => {
      const parsed = RunConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(
          `Invalid configuration: ${issuesToErrors(parsed.error.issues)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ')}`,
        );
      }
      const cfg = parsed.data as RunConfig;
      const ref = svc.getById(cfg.id);
      if (!ref) throw new Error(`Configuration not found: ${cfg.id}`);
      await svc.update(ref.folderKey, cfg);
    },

    deleteConfig: async id => {
      const ref = svc.getById(id);
      if (!ref) return;
      await svc.delete(ref.folderKey, id);
    },

    runConfig: async id => {
      const ref = resolveValid(id);
      await exec.run(ref.config, folderOrThrow(ref.folderKey));
    },

    debugConfig: async id => {
      const ref = resolveValid(id);
      await dbg.debug(ref.config, folderOrThrow(ref.folderKey));
    },

    stopConfig: async id => {
      await exec.stop(id);
    },
  };
}
