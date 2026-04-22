export type RunConfigType = 'npm';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export interface NpmTypeOptions {
  scriptName: string;
  packageManager: PackageManager;
}

export interface RunConfig {
  id: string;
  name: string;
  type: RunConfigType;
  projectPath: string;
  workspaceFolder: string;
  env: Record<string, string>;
  programArgs: string;
  vmArgs: string;
  port?: number;
  typeOptions: NpmTypeOptions;
}

export interface RunFile {
  version: 1;
  configurations: RunConfig[];
}

// Result helper used across services.
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// An entry that was present in run.json but failed schema validation.
// We recover id + name so the user can still see and fix it.
export interface InvalidConfigEntry {
  id: string;
  name: string;
  rawText: string;   // pretty-printed JSON of the original item
  error: string;     // human-readable reason (Zod first-issue message)
}
