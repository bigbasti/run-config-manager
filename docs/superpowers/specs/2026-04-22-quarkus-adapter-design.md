# Quarkus Run-Config Adapter — Design

## Summary

Add a fourth runtime type `'quarkus'` to the Run Configuration Manager, alongside the existing `'npm'`, `'spring-boot'`, and `'tomcat'` types. The adapter mirrors Spring Boot's shape (Maven + Gradle launch modes with full build-tool / JDK / profile pickers) but simplifies wherever Quarkus itself is simpler than Spring Boot — notably in debug setup (`-Ddebug=<port>` replaces the `JAVA_TOOL_OPTIONS` JDWP juggling) and hot-reload (Quarkus dev mode has Live Coding, so no rebuild watcher is needed).

## Motivation

Users working on Quarkus projects currently have no way to create a run configuration for them. The existing Spring Boot adapter is close in shape but semantically wrong (different CLI verbs, different debug flags, different profile format).

## Constraints & decisions

Decisions confirmed during brainstorming (see questions Q1–Q4 in the brainstorming transcript):

- **Q1 — Launch modes:** Two modes only (`maven`, `gradle`). No `java-main` mode. Rationale: Quarkus's own docs steer users toward `quarkus:dev` / `quarkusDev` for local running; the runner-jar (`java -jar target/quarkus-app/quarkus-run.jar`) is a production artifact path that rarely needs a run-config UI.
- **Q2 — Debug:** Always debug, port configurable. Quarkus dev mode opens JDWP on 5005 by default; the listener is harmless when nothing attaches. Single field `debugPort: number` (default 5005). Both Run and Debug pass `-Ddebug=<port>`; Debug additionally invokes `vscode.debug.startDebugging` with an attach config.
- **Q3 — Profiles:** Single-profile model via `SelectOrCustom`. Quarkus honors only one active profile (`-Dquarkus.profile=<name>`). Options populated by parsing `%<profile>.` prefixes from `application.properties` and `application-*.yml` filenames. Empty value = don't pass the flag at all. No port auto-discovery from `application.properties` (we dropped port polling entirely for readiness).
- **Q4 — Readiness/failure patterns:** Conservative set, one phrase per startup. See the "Readiness and failure patterns" section below for the exact regexes.

## Architecture

### 1. Shared types (`src/shared/types.ts`)

Add `'quarkus'` to `RunConfigType`:

```ts
export type RunConfigType = 'npm' | 'spring-boot' | 'tomcat' | 'quarkus';
```

New type options:

```ts
export type QuarkusLaunchMode = 'maven' | 'gradle';

export interface QuarkusTypeOptions {
  launchMode: QuarkusLaunchMode;
  buildTool: JavaBuildTool;             // echo of launchMode, kept for UI parity with spring-boot
  gradleCommand: GradleCommand;         // './gradlew' | 'gradle'
  profile: string;                      // single profile; empty = no flag
  jdkPath: string;
  module: string;                       // gradle module name for multi-module scoping
  gradlePath: string;                   // folder with bin/gradle; empty = use gradleCommand from PATH
  mavenPath: string;                    // folder with bin/mvn; empty = 'mvn' from PATH
  buildRoot: string;                    // settings.gradle / pom.xml root, may differ from projectPath
  debugPort?: number;                   // default 5005; always passed as -Ddebug=<port>
  colorOutput?: boolean;                // FORCE_COLOR=1 + CLICOLOR_FORCE=1
}
```

Extend `RunConfig` discriminated union with `{ type: 'quarkus'; typeOptions: QuarkusTypeOptions }`.

Deliberately omitted vs `SpringBootTypeOptions`:

- `mainClass`, `classpath` — no java-main mode.
- `rebuildOnSave` — dev mode has Live Coding.

### 2. Schema (`src/shared/schema.ts`)

Add a discriminated-union case `z.object({ type: z.literal('quarkus'), ..., typeOptions: QuarkusTypeOptionsSchema })`. `QuarkusTypeOptionsSchema` mirrors `SpringBootTypeOptionsSchema`'s structure minus the omitted fields, with a `superRefine` that requires:

- `gradleCommand` to be one of `'./gradlew'` / `'gradle'` when `launchMode === 'gradle'`.
- `debugPort`, when set, in `[1, 65535]`.

### 3. Form schema (`src/shared/formSchema.ts` integration via `QuarkusAdapter.getFormSchema`)

**Type-specific section:**

| Field         | Widget            | Visibility                                                          | Notes |
|---------------|-------------------|---------------------------------------------------------------------|-------|
| `launchMode`  | select            | always                                                              | options: `maven`, `gradle` |
| `buildTool`   | select            | only when mismatched with `launchMode` (e.g. dev switched it)       | `maven`/`gradle` |
| `gradleCommand` | select          | `launchMode === 'gradle'`                                           | `./gradlew`/`gradle` |
| `mavenPath`   | folderPath        | `launchMode === 'maven'`                                            | help: "Maven root. Blank = use `mvn` from PATH." |
| `gradlePath`  | folderPath        | `launchMode === 'gradle' && gradleCommand === 'gradle'`             | help: "Gradle root. Blank = use `gradle` from PATH." |
| `buildRoot`   | folderPath        | always                                                              | inspectable; help mentions multi-module |
| `module`      | selectOrCustom    | `launchMode === 'gradle'` and multi-module detected                 | options from detection context |
| `jdkPath`     | selectOrCustom    | always                                                              | options from `detectJdks` |
| `profile`     | selectOrCustom    | always                                                              | options from `findQuarkusProfiles` |
| `debugPort`   | number            | always                                                              | default 5005; help: "`-Ddebug=<port>` in dev mode." |

**Advanced section:**

| Field         | Widget            |
|---------------|-------------------|
| `colorOutput` | boolean (default true) |
| `vmArgs`      | textarea (inherited, inspectable) |
| `programArgs` | textarea (inherited, inspectable) |
| `env`         | kv (inherited) |

### 4. Adapter (`src/adapters/quarkus/`)

Three files:

- **`QuarkusAdapter.ts`** — implements `RuntimeAdapter`.
- **`detectQuarkus.ts`** — synchronous detector returning truthy when:
  - `pom.xml` contains `<artifactId>quarkus-maven-plugin</artifactId>` or a dependency groupId `io.quarkus`.
  - `build.gradle[.kts]` applies the `io.quarkus` plugin or imports `io.quarkus:quarkus-bom`.
  - `application.properties` at project root contains any `quarkus.` key (fallback signal).
- **`findQuarkusProfiles.ts`** — returns deduped profile names scraped from:
  - Prefix keys `%<profile>.*` in `application.properties`.
  - Filenames `application-<profile>.{yml,yaml,properties}`.
  - Prefix keys `"%<profile>":` in YAML files (Quarkus accepts this syntax too).

Reused from `spring-boot/`:

- `findBuildRoot` (walks up for `settings.gradle[.kts]` / `pom.xml`)
- `detectJdks` (JDK scan)
- `detectBuildTools` (gradle/maven/wrapper scan)
- `gradleModulePrefix` (task scoping math)

No reuse of `findMainClasses`, `recomputeClasspath`, `suggestClasspath`, `readServerPort` — all specific to Spring Boot's shape.

#### `detect(folder)`

Fast synchronous probe:

1. Call `detectQuarkus(folder)` — return null if not Quarkus.
2. Compute `buildRoot` via `findBuildRoot`.
3. Return defaults: `launchMode` inferred from the build tool (`./gradlew` present → `gradle`, else `maven`), `gradleCommand = './gradlew'` when the wrapper exists else `'gradle'`, `buildTool` echoing `launchMode`, other fields empty strings. Context: `{ buildRoot, hasGradleWrapper, detectedBuildTool, gradleModules: [], jdks: [], profiles: [] }`.

#### `detectStreaming(folder, emit)`

Same parallel fan-out as `SpringBootAdapter`:

1. Emit tools verdict from `detectBuildTools` as soon as available.
2. In parallel, emit patches for:
   - `detectJdks` → fills `jdkPath` default if still blank, resolves `jdkPath`.
   - `findQuarkusProfiles` → updates `profile` options, resolves `profile`.
   - Gradle module list (if multi-module) → updates `module` options, resolves `module`.
3. All patches use `mergeBlanks` semantics; user edits never get overwritten.

#### `buildCommand(cfg, folder)`

Maven:
- Binary: `${mavenPath}/bin/mvn` if `mavenPath` set, else `./mvnw` if wrapper exists, else `mvn`.
- Args: `['quarkus:dev']`, followed by `-Dquarkus.profile=<profile>` when non-empty, `-Ddebug=<debugPort>` (default 5005).
- No module scoping — Maven runs from the module directory (cwd).

Gradle:
- Binary: `./gradlew` if `gradleCommand === './gradlew'` else `${gradlePath}/bin/gradle` if set else `gradle`.
- Task: `gradleModulePrefix(buildRoot, projectPath) ? ':<module>:quarkusDev' : 'quarkusDev'`.
- Args: `['--console=plain', <task>]`, followed by `-Dquarkus.profile=<profile>` when non-empty, `-Ddebug=<debugPort>`, `-DdebugHost=0.0.0.0` (so WSL/containerized Quarkus can be attached from the host — same rationale as the Tomcat adapter's JDWP bind choice).

#### `prepareLaunch(cfg, folder, { debug })`

- If `colorOutput`: inject `FORCE_COLOR=1`, `CLICOLOR_FORCE=1` into env.
- If `jdkPath`: set `JAVA_HOME` env var.
- Return `cwd` = `buildRoot` if non-empty, else the resolved `projectPath`.
- `debug` is ignored — the `-Ddebug=<port>` flag already lives in `buildCommand`, so both Run and Debug flows produce the same command. This is the simplification we chose in Q2.

#### `getDebugConfig(cfg, folder)`

Returns a Java attach config targeting `localhost:<debugPort ?? 5005>` with `sourcePaths: [projectPath]` and the same redhat.java-indexing workarounds already in `SpringBootAdapter`:

```ts
{
  type: 'java',
  request: 'attach',
  name: `Attach to ${cfg.name}`,
  hostName: 'localhost',
  port: debugPort ?? 5005,
  projectName: '',
  modulePaths: [],
  sourcePaths: [projectUri.fsPath],
  shortenCommandLine: 'auto',
}
```

### 5. DebugService flow

Quarkus's debug flow is strictly simpler than Spring Boot's:

1. User clicks Debug.
2. `exec.run(cfg, folder, { debug: true, debugPort })` — unchanged command; Quarkus opens JDWP itself.
3. `waitForPort('localhost', debugPort, 30_000)`.
4. `vscode.debug.startDebugging(folder, adapter.getDebugConfig(cfg, folder))`.
5. If attach fails: `exec.stop(cfg.id)` to avoid an orphan runner.

No `JAVA_TOOL_OPTIONS` injection, no `CATALINA_OPTS` rewrite. The existing `DebugService.ts` dispatcher grows a new case that matches the Spring Boot attach flow minus the flag injection. Target state: Quarkus + Spring Boot attach + Tomcat attach all share a single `attachAfterRun` helper in `DebugService`.

### 6. Readiness and failure patterns (`src/services/readyPatterns.ts`)

Add a `quarkus` case to both `readyPatternsFor` and `failurePatternsFor`:

```ts
case 'quarkus': return [
  /Listening on:\s*https?:\/\//,
  /Profile \w+ activated\. Live Coding activated/,
];

// failure
case 'quarkus': return [
  /Failed to start (?:application|quarkus)/i,
  /Port \d+ is already in use/,
  ...SHARED_BUILD_TOOL_FAILURES,   // existing BUILD FAILED / BUILD FAILURE
];
```

Hoist `/^BUILD FAILED\b/m` and `/^BUILD FAILURE\b/m` into a module-level `SHARED_BUILD_TOOL_FAILURES` constant and reuse in `spring-boot`, `tomcat`, and `quarkus` failure pattern arrays (refactor of existing code, no behavior change).

### 7. Tree / UI plumbing

- `RunConfigTreeProvider.iconForType('quarkus') → 'zap'` (lightning codicon; visually distinct from Spring Boot's `'rocket'` and Tomcat's `'server-environment'`).
- `RunConfigTreeProvider.labelForType('quarkus') → 'Quarkus'`.
- No changes to `EditorPanel.ts`, `webview/`, or the protocol — discriminated-union-agnostic already.

### 8. Registration (`src/extension.ts`)

- Register adapter: `registry.register(new QuarkusAdapter())`.
- Update auto-create priority order: `['spring-boot', 'quarkus', 'tomcat', 'npm']`. Spring Boot first because a hybrid project (unusual but possible) with both plugins should pick Spring Boot; Quarkus second because it's more specific than the generic npm/tomcat detectors.
- Update `autoCreateConfigs.mergeAutoCreateDefaults` to handle the `'quarkus'` type. Defaults: `launchMode` from detection context (falls back to `'maven'`), `buildTool` echoing `launchMode`, `gradleCommand = './gradlew'` if the wrapper exists else `'gradle'`, `profile = ''`, `jdkPath = ''`, `module = ''`, `gradlePath = ''`, `mavenPath = ''`, `buildRoot = ''` (adapter's `detect` will fill it), `debugPort = 5005`, `colorOutput = true`. Base fields follow the existing pattern (empty strings, empty env object).

## Test plan

New test files:

- **`test/QuarkusAdapter.build.test.ts`** — buildCommand matrix (10 cases): `{maven, gradle}` × `{profile blank, profile set}` × `{default debugPort, custom debugPort}` × `{single-module, multi-module Gradle}`. Verify args include expected `-Dquarkus.profile=`, `-Ddebug=`, `-DdebugHost=` flags in the right launch mode.
- **`test/QuarkusAdapter.detect.test.ts`** — detects from `pom.xml` with `quarkus-maven-plugin`; from `build.gradle` with Quarkus plugin; from `application.properties` with a `quarkus.` key; returns null for a pure Spring Boot project (only `spring-boot-starter-web`).
- **`test/findQuarkusProfiles.test.ts`** — parses `%dev.foo=1`, `%prod.bar=2` from `application.properties`; collects `application-stage.yml` / `application-local.properties`; dedupes; handles missing files gracefully.

Extensions to existing tests:

- **`test/readyPatterns.test.ts`** — two new `describe` blocks (~6 cases): Quarkus ready (`Listening on: http://...`, `Profile dev activated. Live Coding activated`) and Quarkus failure (`Failed to start application`, `Port 8080 is already in use`, `BUILD FAILED in 2s`).
- **`test/schema.test.ts`** — round-trips a Quarkus config through parse + serialize; rejects Quarkus configs missing required fields.

No changes to `test/DebugService.test.ts` unless the attach flow is refactored into a shared helper — if so, add a case for Quarkus attach there.

## Documentation

Update `docs/LLM_ONBOARDING.md`:

- `RunConfigType` bullet in the Core Types section: `'npm' | 'spring-boot' | 'tomcat' | 'quarkus'`.
- New bullet under "Distinctive behaviors per adapter" for Quarkus: two launch modes, `-Ddebug=<port>` simplification, no `rebuildOnSave`, single-profile semantics.
- Add Quarkus to the Auto Create priority-order note.

## Out of scope

- Runner-jar launch mode (`java -jar target/quarkus-app/quarkus-run.jar`). Ruled out in Q1.
- `rebuildOnSave` — Quarkus dev mode has Live Coding; no watcher needed.
- Port auto-discovery from `application.properties`. Ruled out in Q3.
- Multi-profile support (`-Dquarkus.profile=a,b`). Quarkus only honors one active profile.
- Quinoa/frontend companion integration.

## Risks and tradeoffs

- **Shared build-tool failure patterns:** Hoisting `BUILD FAILED` / `BUILD FAILURE` into a shared constant is a behavior-preserving refactor of a small, well-tested file. Risk low.
- **`-Ddebug=<port>` always-on in Run mode:** The JDWP listener binds even when the user didn't click Debug. Users on shared machines may dislike the open port. Mitigation: the `debugPort` field lives in the editor, easy to set to 0 or a less-known port. If it becomes a real complaint we can add `debugInDevMode: boolean` later without schema breakage (optional boolean defaults to true).
- **Auto Create priority with hybrid projects:** A project applying both Spring Boot and Quarkus plugins would produce two configs (one per adapter) since Auto Create de-dupes by `(folder, type)`. Not common; acceptable.
- **Gradle `-DdebugHost=0.0.0.0` exposure:** Binds JDWP on all interfaces. Same tradeoff as Tomcat — accepted there for container/WSL attach to work; accepting it here for the same reason. Dev-mode JDWP on a dev machine is not a security boundary.

## Estimated size

- ~300 lines of new adapter code across three files.
- ~50 lines of schema/type additions.
- ~200 lines of new tests.
- ~30 lines of doc updates.

Total: roughly 600 LOC net new, plus one shared-constant refactor to `readyPatterns.ts`.
