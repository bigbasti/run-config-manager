export type RunConfigType = 'npm' | 'spring-boot' | 'tomcat';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export interface NpmTypeOptions {
  scriptName: string;
  packageManager: PackageManager;
}

// Maven by default. Gradle wrapper (./gradlew bootRun) is the other option.
export type JavaBuildTool = 'maven' | 'gradle';

export type SpringBootLaunchMode = 'maven' | 'gradle' | 'java-main';
export type GradleCommand = './gradlew' | 'gradle';

export interface SpringBootTypeOptions {
  launchMode: SpringBootLaunchMode;
  buildTool: JavaBuildTool;
  gradleCommand: GradleCommand;
  profiles: string;
  // Used only when launchMode === 'java-main'. Safe to have as empty strings otherwise.
  mainClass: string;
  classpath: string;
  jdkPath: string;
  module: string;
  // New in 1c.1: path to the build tool's executable. Empty means "use the
  // gradleCommand / 'mvn' off PATH" (legacy behavior).
  gradlePath: string;
  mavenPath: string;
  // Path to the Gradle/Maven project root (where settings.gradle[.kts] / pom.xml
  // with <modules> lives). Empty means "same as projectPath". The walker fills
  // this on detect; user can override.
  buildRoot: string;
  // JDWP port used when launching in debug mode. 0 / undefined means the
  // default (5005). Only relevant to maven/gradle launch modes; java-main
  // mode lets the Java debugger pick the port itself.
  debugPort?: number;
  // When true, starting this config also spawns `./gradlew -t :<module>:classes`
  // in the background so edits recompile automatically. Relies on
  // spring-boot-devtools on the classpath to pick up the recompiled classes.
  rebuildOnSave?: boolean;
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

export type ArtifactKind = 'war' | 'exploded';

export interface TomcatTypeOptions {
  tomcatHome: string;          // /opt/apache-tomcat-10.1.18 — empty = required to pick
  jdkPath: string;             // same semantics as Spring Boot: empty = PATH
  httpPort: number;
  httpsPort?: number;
  ajpPort?: number;
  jmxPort?: number;
  debugPort?: number;          // default 8000 when launched in debug mode
  // Path to the Gradle/Maven project whose artifact we deploy. Relative to
  // workspaceFolder. Empty = workspace root.
  buildProjectPath: string;
  // Where the build lives (for multi-module). Empty = same as buildProjectPath.
  buildRoot: string;
  // Whether to invoke Gradle/Maven before deploy, and what command to run.
  buildTool: 'gradle' | 'maven' | 'none';
  gradleCommand: './gradlew' | 'gradle';
  gradlePath: string;
  mavenPath: string;
  // What to deploy: absolute path to a .war file OR an exploded directory.
  artifactPath: string;
  artifactKind: ArtifactKind;
  // Context under which Tomcat mounts the deployment. "" / "/" = root context.
  applicationContext: string;
  // Extra -D / -X options appended to CATALINA_OPTS.
  vmOptions: string;
  // Tomcat <Context reloadable="true"/> — reloads webapp on class changes.
  reloadable: boolean;
  // Same as Spring Boot: spawn a `gradle -t :module:classes` side task.
  rebuildOnSave: boolean;
}

export type RunConfig =
  | (RunConfigBase & { type: 'npm'; typeOptions: NpmTypeOptions })
  | (RunConfigBase & { type: 'spring-boot'; typeOptions: SpringBootTypeOptions })
  | (RunConfigBase & { type: 'tomcat'; typeOptions: TomcatTypeOptions });

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
