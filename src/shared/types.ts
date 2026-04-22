export type RunConfigType = 'npm' | 'spring-boot';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export interface NpmTypeOptions {
  scriptName: string;
  packageManager: PackageManager;
}

// Maven by default. Gradle wrapper (./gradlew bootRun) is the other option.
export type JavaBuildTool = 'maven' | 'gradle';

export interface SpringBootTypeOptions {
  buildTool: JavaBuildTool;
  // Maven profiles (-P) or Gradle "-Pprofiles=..." — raw string, shell-split.
  profiles: string;
}

export type TypeOptions =
  | ({ kind?: 'npm' } & NpmTypeOptions)
  | ({ kind?: 'spring-boot' } & SpringBootTypeOptions);

// RunConfig is intentionally discriminated on `type` rather than on a nested
// `kind` — the on-disk schema keeps the top-level `type` as the discriminator
// and we cast `typeOptions` to the per-type shape inside adapters.
interface RunConfigBase {
  id: string;
  name: string;
  projectPath: string;
  workspaceFolder: string;
  env: Record<string, string>;
  programArgs: string;
  vmArgs: string;
  port?: number;
}

export type RunConfig =
  | (RunConfigBase & { type: 'npm'; typeOptions: NpmTypeOptions })
  | (RunConfigBase & { type: 'spring-boot'; typeOptions: SpringBootTypeOptions });

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
