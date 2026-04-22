# Java Application Adapter — Design

## Summary

Add a fifth runtime type `'java'` to the Run Configuration Manager for plain Java applications. Three launch modes mirror Spring Boot's shape — `maven` (runs `mvn exec:java`), `gradle` (runs `./gradlew run`), and `java-main` (`java -cp … MainClass`) — minus Spring-specific fields (`profiles`, `rebuildOnSave`) and minus Spring's `-Dspring-boot.run.*` flags. All three modes are debuggable via the existing DebugService attach infrastructure.

## Motivation

Users working on plain Java projects currently have no adapter that fits. The Spring Boot adapter's `java-main` mode works but carries Spring-specific fields and semantics that are irrelevant (profile UI, rocket emoji on main classes, `-Dspring.profiles.active`). Users configure around these fields and leave them empty — a smell indicating the wrong abstraction.

## Constraints & decisions

Decisions confirmed during brainstorming (questions Q1–Q4):

- **Q1 — Scope:** Three launch modes (`maven`, `gradle`, `java-main`). Not "java-main only" (too narrow) and not a build-then-run pre-launch model (too far from what users asked for).
- **Q2 — Main-class detection:** Move `findMainClasses` out of `src/adapters/spring-boot/` into a shared location. Both adapters consume it; the `isSpringBoot` tag stays on the returned candidates and Spring Boot's adapter keeps using it for the rocket emoji while the Java adapter ignores it.
- **Q3 — Maven goal:** `exec:java` only. `exec:exec` is more flexible but much more fiddly (user must write the full `java` command line). The tradeoff is that Maven mode can't apply `vmArgs` — `exec:java` runs in the Maven JVM. Users who need VM args in Maven mode should switch to `java-main` mode. Field help documents this explicitly.
- **Q4 — Debug:** All three modes debuggable. Gradle reuses the existing `JAVA_TOOL_OPTIONS` injection pattern that Spring Boot Gradle mode uses. Maven injects JDWP via `MAVEN_OPTS` instead (since `exec:java` runs in the Maven JVM itself). java-main uses the Java debugger's `request: 'launch'` mode — no env-var work needed.

## Architecture

### 1. Shared types (`src/shared/types.ts`)

Add `'java'` to `RunConfigType`:

```ts
export type RunConfigType = 'npm' | 'spring-boot' | 'tomcat' | 'quarkus' | 'java';
```

New type options:

```ts
export type JavaLaunchMode = 'maven' | 'gradle' | 'java-main';

export interface JavaTypeOptions {
  launchMode: JavaLaunchMode;
  buildTool: JavaBuildTool;           // echoes launchMode in maven/gradle modes; informational in java-main
  gradleCommand: GradleCommand;
  mainClass: string;                  // required when launchMode !== 'gradle'
  classpath: string;                  // required when launchMode === 'java-main'
  jdkPath: string;
  module: string;                     // multi-module Gradle scoping
  gradlePath: string;
  mavenPath: string;
  buildRoot: string;
  debugPort?: number;                 // default 5005
  colorOutput?: boolean;              // FORCE_COLOR=1 + CLICOLOR_FORCE=1
}
```

Extend `RunConfig` discriminated union with `{ type: 'java'; typeOptions: JavaTypeOptions }`.

Deliberately omitted vs `SpringBootTypeOptions`:

- `profiles` — not a Java concept.
- `rebuildOnSave` — no framework-side hot reload; restart is the only option.

### 2. Schema (`src/shared/schema.ts`)

Add a discriminated-union case `z.object({ type: z.literal('java'), ..., typeOptions: JavaTypeOptionsSchema })`. `JavaTypeOptionsSchema` shape mirrors `SpringBootTypeOptionsSchema` minus `profiles` and `rebuildOnSave`, with a `superRefine`:

- `mainClass` required when `launchMode === 'java-main'` OR `launchMode === 'maven'` (Maven's `exec:java` takes `-Dexec.mainClass=<FQN>`; Gradle's `run` task reads the main class from the `application` plugin block in `build.gradle` instead, so it's not needed there).
- `classpath` required when `launchMode === 'java-main'`.
- `debugPort` (when present) in `[1, 65535]`.

### 3. Shared helper relocation

Move `src/adapters/spring-boot/findMainClasses.ts` → `src/adapters/java-shared/findMainClasses.ts`. Move `test/findMainClasses.test.ts` unchanged (imports update). Update `src/adapters/spring-boot/SpringBootAdapter.ts` to import from the new location. No behavior change.

Rationale: once two adapters depend on a helper, it doesn't belong inside one of them.

### 4. Detection helper (`src/adapters/java/detectJavaApp.ts`)

Returns `{ buildTool: JavaBuildTool | null, hasApplicationPlugin: boolean, hasMainClass: boolean }` or null when nothing Java-ish is found.

Detection rules:

- If `pom.xml` / `build.gradle[.kts]` exists AND
- Build file does NOT contain Spring Boot / Quarkus / embedded Tomcat markers (those adapters take priority) AND
- At least one `public static void main` found under `src/main/java` or `src/main/kotlin` via `findMainClasses`,
- Return with buildTool = `'maven'` / `'gradle'` and `hasApplicationPlugin = true` when the build file applies `org.gradle.application` or has an `application { }` block.

Edge case: a bare Java source tree with a `main` but no build file. Detection still returns truthy but with `buildTool = null` and `hasApplicationPlugin = false`. The adapter's detect defaults to `java-main` launch mode in that case.

### 5. Adapter (`src/adapters/java/JavaAdapter.ts`)

Implements `RuntimeAdapter` with `type = 'java'`, `label = 'Java Application'`, `supportsDebug = true`.

`detect(folder)` — calls `detectJavaApp`; returns null when absent. Populates defaults and context with results from `findMainClasses`, `detectJdks`, `detectBuildTools`, `findGradleRoot` / `findMavenRoot`, `suggestClasspath` (only when buildTool detected).

`detectStreaming(folder, emit)` — same parallel fan-out as Spring Boot:
1. Fast build-tool verdict.
2. Parallel probes: build root, main classes, JDKs, gradle/maven installs, classpath (via Spring Boot's existing `suggestClasspath`), Gradle `application` plugin presence.
3. Each probe emits a `StreamingPatch` with `mergeBlanks` semantics.

`getFormSchema(context)` — see the form schema table in the brainstorming transcript. Notable conditional visibility rules:

- `gradleCommand`, `module` → `launchMode === 'gradle'`.
- `mavenPath` → `launchMode === 'maven'`.
- `gradlePath` → `launchMode === 'gradle' && gradleCommand === 'gradle'`.
- `mainClass` → `launchMode !== 'gradle'`.
- `classpath` (textarea with `Recompute` action) → `launchMode === 'java-main'`.
- `debugPort`, `jdkPath`, `buildRoot` always visible.

`vmArgs` help text spells out per-mode semantics: applied directly in java-main mode; ignored in Maven `exec:java` (runs in the Maven JVM) and Gradle `run` (the `application` plugin reads JVM args from `applicationDefaultJvmArgs`, not the CLI). java-main mode is the only way to pass VM args reliably.

`buildCommand(cfg, folder?)`:

- **`maven`:**
  - Binary: `${mavenPath}/bin/mvn` if set, else `./mvnw` if wrapper exists, else `mvn`.
  - Args: `['exec:java']`, followed by `-Dexec.mainClass=<FQN>`. Program args via `-Dexec.args=<shellQuote(joined)>`. VM args NOT passed (see Q3).
- **`gradle`:**
  - Binary: `./gradlew` or `${gradlePath}/bin/gradle` or `gradle` (same precedence as Spring Boot).
  - Task: `gradleModulePrefix(buildRoot, projectAbs) ? ':<module>:run' : 'run'`.
  - Args: `['--console=plain', <task>]` + `--args=<shellQuote(programArgs joined)>` when program args are non-empty. Main class is NOT passed — Gradle reads it from `application { mainClass }`. **VM args are NOT passed** — Gradle's `run` task reads JVM args from `application { applicationDefaultJvmArgs }` in `build.gradle`; there's no `-DjvmArgs=` equivalent on the CLI that survives the `application` plugin's JavaExec fork. Same limitation as Maven mode; the help text tells users to switch to java-main mode for full VM-arg control.
- **`java-main`:**
  - Binary: `${jdkPath}/bin/java` or `java`.
  - Args: `[vmArgs…, '-cp', classpath, mainClass, programArgs…]`. Matches Spring Boot's java-main command layout minus the `-Dspring.profiles.active` injection.

`prepareLaunch(cfg, folder, { debug, debugPort })`:

- `colorOutput` ⇒ `FORCE_COLOR=1`, `CLICOLOR_FORCE=1` in env.
- `jdkPath` ⇒ `JAVA_HOME=<jdkPath>`.
- `debug === true`:
  - `launchMode === 'maven'`: inject JDWP via `MAVEN_OPTS=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:<port>` (NOT `JAVA_TOOL_OPTIONS` — Maven forks the plugin JVM and `JAVA_TOOL_OPTIONS` would try to start a second debugger in it).
  - `launchMode === 'gradle'`: inject JDWP via `JAVA_TOOL_OPTIONS=<…>` (same as Spring Boot Gradle flow — `run` forks a JVM that inherits the var).
  - `launchMode === 'java-main'`: no env work; Java debugger's `request: 'launch'` drives JDWP.
- Returns `cwd` = `buildRoot` if non-empty, else resolved `projectPath`.

`getDebugConfig(cfg, folder)`:

- `launchMode === 'java-main'`: returns a `request: 'launch'` Java debug config with `mainClass`, `classPaths` (split from `cfg.typeOptions.classpath`), `vmArgs`, `args`, `javaExec` (when `jdkPath` set), `env`, and the redhat-java workarounds (`projectName: ''`, `modulePaths: []`, `sourcePaths: []`, `shortenCommandLine: 'auto'`, `console: 'integratedTerminal'`).
- `launchMode === 'maven'` or `'gradle'`: returns a `request: 'attach'` config targeting `localhost:<debugPort>` with `sourcePaths: [projectUri.fsPath]`, `timeout: 60_000`, and the same redhat-java workarounds.

### 6. DebugService (`src/services/DebugService.ts`)

New branch in `debug()`:

```ts
if (conf.type === 'java' && conf.request === 'attach' && resolvedCfg.type === 'java') {
  return await this.startJavaAttachFlow(resolvedCfg, folder, conf);
}
```

`startJavaAttachFlow(cfg, folder, attachConf)`:

1. Compute `port = attachConf.port ?? cfg.typeOptions.debugPort ?? 5005`.
2. Delegate JDWP injection to the adapter's `prepareLaunch` by calling `exec.run(cfg, folder, { debug: true, debugPort: port })`. That's where Maven gets `MAVEN_OPTS` and Gradle gets `JAVA_TOOL_OPTIONS` — no duplication here.
3. `waitForPort('localhost', port, 5 * 60_000)`.
4. On socket-open: `vscode.debug.startDebugging(folder, attachConf)`.
5. On attach failure: `exec.stop(cfg.id)`.

`debugCwd()` and `ExecutionService.buildCwd()` each gain a Java branch honoring `buildRoot` for maven/gradle modes (mirrors the Quarkus cwd branch).

### 7. Readiness & failure patterns (`src/services/readyPatterns.ts`)

**Ready patterns for `'java'`: empty list.** A plain Java app has no universal startup marker — the tree intentionally stays in the spinner for the life of the process. Correct-by-pessimism: we'd rather stay spinning than fake-green on `System.out.println("started")` from user code.

**Failure patterns for `'java'`:**

```
/Exception in thread "[^"]+" /
/Error: Could not find or load main class/
/Error: Main method not found/
/java\.lang\.NoClassDefFoundError/
...SHARED_BUILD_TOOL_FAILURES   // BUILD FAILED / BUILD FAILURE
```

### 8. Tree / UI plumbing

- `RunConfigTreeProvider.labelForType('java') → 'Java Application'`.
- `RunConfigTreeProvider.iconForType('java') → 'symbol-class'` (the codicon for a Java-style class symbol; visually distinct from `rocket` / `zap` / `server-environment`).
- No changes to `EditorPanel.ts` structure — but the `sendInit` union cast gains `'java'`, and `sanitize` (now `sanitizeConfig`) gains a `'java'` branch. The exhaustiveness guard added in the Quarkus-save fix catches regressions if we forget.

### 9. Registration + auto-create (`src/extension.ts`)

- Register adapter: `registry.register(new JavaAdapter())`.
- Update auto-create priority: `['spring-boot', 'quarkus', 'tomcat', 'java', 'npm']`. Java between Tomcat and npm — any Maven/Gradle project without the more specific markers is Java-ish, but we shouldn't beat out a real framework match.
- `deriveConfigName` suffix `'Java'` for the new type.
- `mergeAutoCreateDefaults` Java branch mirroring the Spring Boot one, with empty path fields, `launchMode = buildTool` (falling back to `'java-main'` when no build tool detected), `debugPort = 5005`, `colorOutput = true`.
- Streaming `pending` list gains Java-specific keys where they aren't already covered (`typeOptions.classpath` / `typeOptions.mainClass` / `typeOptions.jdkPath` / `typeOptions.gradleCommand` / `typeOptions.buildRoot` / `typeOptions.gradlePath` / `typeOptions.mavenPath` — all already shared with Spring Boot's list).

### 10. EditorPanel updates

- `sendInit`: extend type union to include `'java'`; add a `typeDefaults` branch for Java that leaves `buildTool` unset in streaming mode (same mergeBlanks rationale as Spring Boot).
- `sanitizeConfig`: add a `'java'` branch mirroring the `'spring-boot'` shape minus `profiles` / `rebuildOnSave`. The exhaustiveness guard stays.

## Test plan

New test files:

- **`test/JavaAdapter.build.test.ts`** — buildCommand matrix: {maven, gradle, java-main} × {program args empty / set} × {vm args empty / set} × {single-module / multi-module Gradle}. Specific assertions:
  - Maven: `-Dexec.mainClass=` present, `-Dexec.args='…'` when programArgs set, no VM-args flag (documented Q3 behavior).
  - Gradle: `--console=plain` + `run` task (or `:mod:run`), `--args=…` for programArgs, no `-Dexec.mainClass` (Gradle reads from `application{}`).
  - java-main: correct `java -cp <cp> <FQN>` order, `vmArgs` inlined before `-cp`.
- **`test/JavaAdapter.detect.test.ts`** — detects a pure Java Maven project, pure Java Gradle project with `application` plugin, returns null when Spring Boot markers present, returns null on empty folder.
- **`test/detectJavaApp.test.ts`** (optional) — unit tests for the detector separate from the adapter dispatch.

Extensions to existing tests:

- **`test/readyPatterns.test.ts`** — Java failure patterns (exception-in-thread, NoClassDefFoundError, could-not-find-main, shared BUILD FAILED). No ready tests (empty set).
- **`test/schema.test.ts`** — accept a valid Java config; reject Java with `launchMode: 'java-main'` but empty `mainClass` / `classpath`.
- **`test/sanitizeConfig.test.ts`** — Java round-trip + Zod validation (regression guard, extending the set that caught the Quarkus-as-npm bug).
- **`test/findMainClasses.test.ts`** — import path update to `src/adapters/java-shared/`.

## Documentation

Update `docs/LLM_ONBOARDING.md`:

- `RunConfigType` list: `'npm' | 'spring-boot' | 'tomcat' | 'quarkus' | 'java'`.
- High-level layout: replace `spring-boot/ ← findMainClasses` note with `java-shared/ ← findMainClasses` (shared helper).
- New bullet under "Distinctive behaviors per adapter" for JavaAdapter: three modes, Maven `exec:java` limitation around VM args, Gradle `run` requires the `application` plugin, debug via attach or launch depending on mode.
- Auto-create priority list: `spring-boot > quarkus > tomcat > java > npm`.
- Recent decisions: note the shared-helper relocation and the Maven `exec:java` tradeoff.

## Out of scope

- Maven `exec:exec` goal — ruled out in Q3.
- IntelliJ-style "pre-launch build task" configuration — out of scope for v1.
- Kotlin-specific tagging (`@JvmStatic main`, etc.). `findMainClasses` already walks `.kt`; plain Java adapter works for Kotlin mains without extra code.
- Auto-detection of executable JARs (`-jar` mode). Users who need this can use java-main with `classpath = path/to/app.jar`.

## Risks and tradeoffs

- **Shared-helper move:** Changes one import in `SpringBootAdapter.ts` and moves a test file. Low risk, high clarity win.
- **Maven mode can't pass vmArgs:** Documented in help text. Alternative (Maven `exec:exec`) was ruled out in Q3. Users hitting this will see the note and switch to java-main mode.
- **`MAVEN_OPTS` vs `JAVA_TOOL_OPTIONS` for Maven debug:** `JAVA_TOOL_OPTIONS` would be picked up by both the Maven JVM AND any forked plugin JVM, causing "Address already in use" when Maven tries to bind a second JDWP agent. `MAVEN_OPTS` only affects the Maven JVM itself, which is what we want for `exec:java` (same JVM).
- **No "ready" signal for Java apps:** The tree never flips green — that's correct; we have no reliable marker. Users see the spinner for the life of the process. Failure patterns still turn it red if the app crashes.
- **Gradle `run` requires the `application` plugin:** If the user's `build.gradle` doesn't apply it, `./gradlew run` fails with an unhelpful error. The form schema detects and warns in the `launchMode` help text when `hasApplicationPlugin === false`.

## Estimated size

- ~400 lines of new adapter code across three files.
- ~50 lines of schema/type additions.
- ~100 lines of DebugService + ExecutionService additions (new attach flow + cwd branches).
- ~20 lines of sanitize + sendInit additions.
- ~250 lines of new tests.
- ~30 lines of doc updates.

Total: ~850 LOC net new, plus a one-file shared-helper relocation.
