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
