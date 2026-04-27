export type RunConfigType =
  | 'npm'
  | 'spring-boot'
  | 'tomcat'
  | 'quarkus'
  | 'java'
  | 'maven-goal'
  | 'gradle-task'
  | 'custom-command'
  | 'docker';

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
  // When true, forces colored output in the integrated terminal:
  //   - spring.output.ansi.enabled=ALWAYS
  //   - FORCE_COLOR=1, CLICOLOR_FORCE=1
  colorOutput?: boolean;
}

export type TypeOptions =
  | ({ kind?: 'npm' } & NpmTypeOptions)
  | ({ kind?: 'spring-boot' } & SpringBootTypeOptions);

// RunConfig is intentionally discriminated on `type` rather than on a nested
// `kind` — the on-disk schema keeps the top-level `type` as the discriminator
// and we cast `typeOptions` to the per-type shape inside adapters.
// One dependency entry: what to start first, plus how long to wait after it
// reaches "running" before we launch the parent. The ref is a stable
// identifier that survives renames — see `parseDependencyRef` for the
// supported schemes.
export interface DependencyEntry {
  // Stable identifier:
  //   - `rcm:<configId>`         — another run configuration in the same folder.
  //     We use the config id rather than its name so renames don't break deps.
  //   - `launch:<name>`          — a VS Code launch.json config (compound or single).
  //   - `task:<source>::<name>`  — a VS Code task (source identifies workspace vs
  //     auto-detected providers like npm/gradle).
  ref: string;
  // Seconds to wait AFTER the dependency reaches a running / completed state
  // before starting the next step. 0 means "start immediately once the dep
  // is up". Clamped to [0, 600] in the orchestrator.
  delaySeconds?: number;
}

interface RunConfigBase {
  id: string;
  name: string;
  projectPath: string;
  workspaceFolder: string;
  env: Record<string, string>;
  programArgs: string;
  vmArgs: string;
  port?: number;
  // Other configurations that must be started (and reach running state)
  // before this one. Ordered as the user arranged them in the form; the
  // orchestrator walks them in the given order. Cycles are detected at run
  // time and surfaced to the user — storing a cycle is not rejected at save
  // time so partial edits don't block Save.
  dependsOn?: DependencyEntry[];
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
  // Spring profiles to activate when the deployed webapp is Spring-based.
  // Comma-separated, same convention as SpringBootTypeOptions.profiles. When
  // non-empty, prepareTomcatLaunch appends `-Dspring.profiles.active=<csv>`
  // to CATALINA_OPTS. Detection scans the build project's resources/ for
  // profile files and populates the dropdown.
  profiles: string;
  // Extra -D / -X options appended to CATALINA_OPTS.
  vmOptions: string;
  // Tomcat <Context reloadable="true"/> — reloads webapp on class changes.
  reloadable: boolean;
  // Same as Spring Boot: spawn a `gradle -t :module:classes` side task.
  rebuildOnSave: boolean;
  // Force-enable ANSI colors in terminal output (FORCE_COLOR + ANSI props).
  colorOutput?: boolean;
}

// Quarkus has two launch modes: Maven's `quarkus:dev` and Gradle's `quarkusDev`.
// No java-main mode — Quarkus's framework owns the main; users run the runner
// jar only for production, and we don't cover that path in v1.
export type QuarkusLaunchMode = 'maven' | 'gradle';

export interface QuarkusTypeOptions {
  launchMode: QuarkusLaunchMode;
  // Kept for parity with Spring Boot so the form can surface a build-tool
  // verdict independent of launchMode; usually echoes launchMode.
  buildTool: JavaBuildTool;
  gradleCommand: GradleCommand;
  // Single active profile (Quarkus honors only one). Empty = don't pass
  // -Dquarkus.profile at all.
  profile: string;
  jdkPath: string;
  module: string;
  gradlePath: string;
  mavenPath: string;
  buildRoot: string;
  // JDWP port. Quarkus dev mode opens debug on 5005 by default; we pass
  // `-Ddebug=<port>` unconditionally (see Q2 decision in the spec). When
  // undefined the adapter falls back to 5005.
  debugPort?: number;
  // FORCE_COLOR=1 + CLICOLOR_FORCE=1 in env. No Spring-Boot-ansi system
  // property needed — Quarkus's console does its own color detection.
  colorOutput?: boolean;
}

// Plain Java application. Launch modes:
//   - maven         mvn exec:java -Dexec.mainClass=<FQN>
//   - gradle        ./gradlew run (application plugin)
//   - java-main     java -cp <classpath> <MainClass>
//   - maven-custom  mvn <raw tail the user typed in customArgs>
//   - gradle-custom ./gradlew <raw tail the user typed in customArgs>
// The two *-custom modes are the escape hatch for ad-hoc invocations — e.g.
// running a single Gradle test task with --tests filters — where the standard
// mainClass/programArgs split doesn't fit.
export type JavaLaunchMode = 'maven' | 'gradle' | 'java-main' | 'maven-custom' | 'gradle-custom';

export interface JavaTypeOptions {
  launchMode: JavaLaunchMode;
  // Echoes launchMode in maven/gradle modes; informational in java-main.
  buildTool: JavaBuildTool;
  gradleCommand: GradleCommand;
  // Required when launchMode is 'maven' or 'java-main'. Gradle's `run` task
  // reads the main class from application{} in build.gradle; custom modes
  // ignore this field entirely.
  mainClass: string;
  // Required when launchMode === 'java-main'. Blank otherwise.
  classpath: string;
  // Raw command tail for launchMode 'maven-custom' / 'gradle-custom'. Split
  // with the same shell-aware splitter used for programArgs, so quoted values
  // like --tests "…" survive intact.
  customArgs: string;
  jdkPath: string;
  module: string;
  gradlePath: string;
  mavenPath: string;
  buildRoot: string;
  debugPort?: number;
  colorOutput?: boolean;
}

// Maven Goal — one-click execution of a phase + optional plugin goal chain,
// e.g. "clean install", "liquibase:dropAll -Durl=…". supportsDebug=false.
export interface MavenGoalTypeOptions {
  goal: string;
  jdkPath: string;
  mavenPath: string;
  buildRoot: string;
  colorOutput?: boolean;
}

// Gradle Task — e.g. "dropAll", ":api:test --tests \"pkg.*\"". No
// automatic multi-module scoping; user types the fully-qualified task
// name if they need it.
export interface GradleTaskTypeOptions {
  task: string;
  gradleCommand: GradleCommand;
  jdkPath: string;
  gradlePath: string;
  buildRoot: string;
  colorOutput?: boolean;
}

// Custom Command — paste any shell command and one-click it. Whole
// command string is shell-interpreted so &&, pipes, globs, redirects
// all work. supportsDebug=false. No framework detection.
export type CustomShell = 'default' | 'bash' | 'sh' | 'zsh' | 'pwsh' | 'cmd';

export interface CustomCommandTypeOptions {
  command: string;
  // Optional working-directory override. Empty = resolved projectPath.
  cwd: string;
  shell: CustomShell;
  // When true, run via ShellExecution (VS Code owns the PTY — stdin works,
  // Ctrl+C forwards, `read` prompts, etc.). When false, run through our
  // pseudoterminal + prettifier (output logging, hyperlinks, no stdin).
  interactive: boolean;
  colorOutput?: boolean;
}

// Docker — quick-launch a named container. Unlike other types, Docker doesn't
// compile / build / fork anything — it just delegates to `docker start` /
// `docker stop`. Click-to-logs and running-state detection go through
// DockerService (not ExecutionService).
export interface DockerTypeOptions {
  // The container id (short or long). We key on id rather than name because
  // users rename containers and we don't want saved configs to break silently.
  containerId: string;
  // Human-readable name snapshot captured when the user picked the container.
  // Used only for the form's info panel / tooltip when the container has been
  // removed — we can still show "was X" instead of a bare id.
  containerName?: string;
}

export type RunConfig =
  | (RunConfigBase & { type: 'npm'; typeOptions: NpmTypeOptions })
  | (RunConfigBase & { type: 'spring-boot'; typeOptions: SpringBootTypeOptions })
  | (RunConfigBase & { type: 'tomcat'; typeOptions: TomcatTypeOptions })
  | (RunConfigBase & { type: 'quarkus'; typeOptions: QuarkusTypeOptions })
  | (RunConfigBase & { type: 'java'; typeOptions: JavaTypeOptions })
  | (RunConfigBase & { type: 'maven-goal'; typeOptions: MavenGoalTypeOptions })
  | (RunConfigBase & { type: 'gradle-task'; typeOptions: GradleTaskTypeOptions })
  | (RunConfigBase & { type: 'custom-command'; typeOptions: CustomCommandTypeOptions })
  | (RunConfigBase & { type: 'docker'; typeOptions: DockerTypeOptions });

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
