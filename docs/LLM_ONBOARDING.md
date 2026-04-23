# Run Configuration Manager — LLM Onboarding

This document is written for a fresh LLM session taking over work on this repo. It is not a tutorial; it is an index. Read it end-to-end first, then use the file references as jumping-off points.

## What this is

A VS Code extension that gives the editor IntelliJ-style run configurations. Configs live in `.vscode/run.json`, rendered as a tree in the Activity Bar. Each config has a type (`npm`, `spring-boot`, `tomcat`, `quarkus`, `java`), and the extension spawns the right shell command for you, scanning the terminal output to show whether the app is starting, started, or failed. A webview-based editor lets the user create/edit configs with a schema-driven form.

Repo root: `/git/run-config-manager`. Main branch: `main`. It is an independent git repo (not a submodule of `/git/zebra`).

## Golden rules (read these first)

1. **Do not use `ShellExecution` for run commands.** We rely on observing stdout in real time to detect readiness/failure. `ShellExecution` hands the PTY to VS Code and we see nothing. `src/services/RunTerminal.ts` (a `vscode.Pseudoterminal`) exists for that reason. `ShellExecution` is OK for fire-and-forget tasks like the Gradle rebuild watcher.
2. **Do not reintroduce port-polling for readiness.** It was removed deliberately — dev-server sockets (Vite, Angular) bind before the app is actually usable, so polling gave false greens. Use regex patterns only (`src/services/readyPatterns.ts`). If a new type needs coverage, add patterns there.
3. **Do not break the streaming-detection contract.** When a user clicks "Add", the editor must open instantly. Heavy probes (Gradle classpath, JDK scan, main-class walk) run inside `adapter.detectStreaming(folder, emit)` and push `StreamingPatch` messages as they finish. Never move that work back into synchronous `detect()`.
4. **Do not rewrite unresolved variables on disk.** `resolveVars` returns a resolved copy for runtime; `.vscode/run.json` keeps the `${...}` tokens. The rule is: what the user typed, we keep.
5. **`mergeBlanks` preserves user edits.** Streaming patches, fallback detection, and migration code all merge into existing config with "only fill if blank/undefined/empty". Respect that semantics when adding new fields.
6. **Save state correctness in EditorPanel.** There is a historical class of bugs where new boolean/number fields were dropped on save because `sanitize()` didn't forward them. Any new `typeOptions` field must be covered end-to-end: schema → form → sanitize → store → resolveConfig → adapter.
7. **Run `npm run typecheck && npm test && npm run build` before committing.** The project treats green as the bar. Jest runs 189+ tests with an in-memory `vscode` mock; they are fast (~2s) and catch the common breakage modes.

## High-level layout

```
src/
  extension.ts                     # activate(): wires everything
  shared/                          # code shared with webview (runs in both)
    types.ts                       # RunConfig discriminated union
    schema.ts                      # Zod schemas + migrations entry
    formSchema.ts                  # FormField union consumed by webview
    protocol.ts                    # extension ↔ webview message shapes
    buildCommandPreview.ts         # pretty-printed command line for tree tooltips
  adapters/
    RuntimeAdapter.ts              # the interface every adapter implements
    AdapterRegistry.ts             # Map<RunConfigType, RuntimeAdapter>
    npm/                           # NpmAdapter + detectPackageJson + splitArgs
    spring-boot/                   # SpringBootAdapter + detect/resolve helpers (detectJdks,
                                   #   detectBuildTools, findBuildRoot, recomputeClasspath, etc.)
    tomcat/                        # TomcatAdapter + detectTomcat + tomcatRuntime (CATALINA_BASE scaffold)
    quarkus/                       # QuarkusAdapter + detectQuarkus + findQuarkusProfiles
    java/                          # JavaAdapter + detectJavaApp
    java-shared/                   # findMainClasses (used by both spring-boot and java)
  services/                        # runtime orchestration (no UI)
    ConfigStore.ts                 # .vscode/run.json loader + watcher, per workspace folder
    RunConfigService.ts            # thin CRUD wrapper on top of store
    ExecutionService.ts            # spawns + tracks run state (preparing/started/failed)
    DebugService.ts                # attaches Java debugger; runs npm in pwa-node launch mode
    RunTerminal.ts                 # Pseudoterminal — owns child process, feeds prettifier
    readyPatterns.ts               # regex patterns for started/failed detection
    prettyOutput.ts                # line-buffered ANSI + OSC 8 hyperlink prettifier
    ProjectScanner.ts              # thin diagnostics wrapper over adapter.detect
    migrateSpringBoot.ts           # row-level migration before schema validation
  recovery/
    buildRecoveredConfig.ts        # salvages as many fields as possible from an InvalidConfigEntry
  ui/
    RunConfigTreeProvider.ts       # the 5 visual states live here
    EditorPanel.ts                 # singleton webview host + message router
  utils/
    resolveVars.ts                 # ${...} expansion — empty string on unresolved
    paths.ts                       # workspaceFolder-aware path helpers
    logger.ts                      # output channel sink
    uuid.ts
webview/src/                       # React app that renders inside the EditorPanel
  App.tsx                          # top-level state machine
  ConfigForm.tsx                   # renders common + typeSpecific + advanced sections
  form/                            # Field, InspectDialog, SelectOrCustom, KvEditor, CsvChecklist, FolderPathInput
  state.ts                         # local state helpers
test/                              # jest tests (31 files, ~280 cases)
__mocks__/vscode.ts                # in-memory filesystem + event emitters
```

## Core types (src/shared/types.ts)

`RunConfig` is a discriminated union on `type`:

- `{ type: 'npm', typeOptions: NpmTypeOptions }` — `scriptName`, `packageManager` (`npm|yarn|pnpm`).
- `{ type: 'spring-boot', typeOptions: SpringBootTypeOptions }` — `launchMode` (`maven|gradle|java-main`), `buildTool`, `gradleCommand` (`./gradlew|gradle`), `profiles`, `mainClass`, `classpath`, `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot`, `debugPort?`, `rebuildOnSave?`, `colorOutput?`.
- `{ type: 'tomcat', typeOptions: TomcatTypeOptions }` — `tomcatHome`, `jdkPath`, `httpPort`, `buildProjectPath`, `buildRoot`, `buildTool`, `gradleCommand`, `gradlePath`, `mavenPath`, `artifactPath`, `artifactKind` (`war|exploded`), `applicationContext`, `vmOptions`, `reloadable`, `rebuildOnSave`, `colorOutput?`.
- `{ type: 'quarkus', typeOptions: QuarkusTypeOptions }` — `launchMode` (`maven|gradle` — no java-main), `buildTool`, `gradleCommand`, `profile` (single, not CSV), `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot`, `debugPort?`, `colorOutput?`. No `rebuildOnSave` (Quarkus has built-in Live Coding).
- `{ type: 'java', typeOptions: JavaTypeOptions }` — plain Java app. `launchMode` (`maven|gradle|java-main`), `buildTool`, `gradleCommand`, `mainClass`, `classpath`, `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot`, `debugPort?`, `colorOutput?`. No `profiles` / `rebuildOnSave`. Schema refines: `mainClass` required unless launchMode is `gradle`; `classpath` required when `java-main`.

Shared base fields: `id`, `name`, `projectPath`, `workspaceFolder`, `env`, `programArgs`, `vmArgs`, `port?`.

`InvalidConfigEntry` — entries that failed schema validation but are kept so the user can "Fix Invalid Configuration" from the tree. Shape: `{ id, name, rawText, error }`.

Zod schemas in `src/shared/schema.ts` use `z.discriminatedUnion('type', ...)` and `superRefine` for the cross-field Tomcat constraints (e.g. both `tomcatHome` and `artifactPath` required).

## The adapter contract (src/adapters/RuntimeAdapter.ts)

Every runtime (npm, spring-boot, tomcat, quarkus, java) implements:

- **`type` / `label` / `supportsDebug`** — static metadata.
- **`detect(folder): DetectionResult | null`** — synchronous probe of the project. Returns defaults (partial `RunConfig`) plus a context object consumed by `getFormSchema`. Null = this adapter doesn't recognize the folder.
- **`detectStreaming?(folder, emit): Promise<void>`** — optional async detection that pushes `StreamingPatch` items as probes finish. Use this whenever the probe might take >100ms. Each patch can merge into the detection context (`contextPatch`), pre-fill blank form fields (`defaultsPatch`), and mark `resolved` field keys so the webview can drop their busy spinners.
- **`getFormSchema(context): FormSchema`** — builds the form schema with select options, conditional visibility, help strings. Runs on both initial detect and every streaming patch.
- **`buildCommand(cfg, folder?): { command, args[] }`** — the shell command ExecutionService runs.
- **`prepareLaunch?(cfg, folder, ctx): Promise<{ env?, cwd? }>`** — optional pre-spawn hook. This is where Tomcat writes its CATALINA_BASE scaffold and injects JDWP env vars, and where Spring Boot injects `JAVA_TOOL_OPTIONS` for colored logs and JDWP. It may also override `cwd`. Called with `{ debug, debugPort }`.
- **`getDebugConfig?(cfg, folder): vscode.DebugConfiguration`** — returns the launch config for `vscode.debug.startDebugging`. Spring Boot's java-main mode returns a `java` launch config; maven/gradle modes + Tomcat return an `attach` config and the DebugService runs the app first, then attaches.

Adapters register themselves in `extension.ts` on activation via `AdapterRegistry.register`.

Distinctive behaviors per adapter:
- **NpmAdapter** — reads `package.json` scripts, simple. Debug uses `pwa-node` via `spawn` so breakpoints bind.
- **SpringBootAdapter** — `findMainClasses`, `detectJdks`, `findProfiles`, `findBuildRoot`, `recomputeClasspath`, `readServerPort` are all called from here. Multi-module Gradle is handled by `gradleModulePrefix` scoping tasks as `:module:classes` / `:module:bootRun`. For `java-main` launch mode, `suggestClasspath` computes a runtime classpath via `./gradlew printRuntimeClasspath` (a custom task injected through `-I init.gradle`).
- **TomcatAdapter** — delegates most prepare work to `tomcatRuntime.ts`. That file builds a per-config `CATALINA_BASE` (conf/, logs/, temp/, webapps/, work/), rewrites `server.xml` with user ports + context + `reloadable`, deploys the artifact (copies the WAR or symlinks the exploded dir), and returns `CATALINA_BASE`, `CATALINA_OPTS` (JDWP via `-agentlib:jdwp=...`), and `JAVA_HOME` as env.
- **QuarkusAdapter** — two launch modes only (`maven` + `gradle`), no java-main mode (Quarkus owns the main). Dev mode is the only launch path: `mvn quarkus:dev` or `./gradlew --console=plain quarkusDev`. JDWP is opened by Quarkus itself via `-Ddebug=<port>` (default 5005) — no `JAVA_TOOL_OPTIONS` juggling. Single profile via `-Dquarkus.profile=<name>` (Quarkus accepts only one active profile). No rebuild watcher (Live Coding is built in). Reuses `findBuildRoot`, `detectJdks`, `detectBuildTools`, `gradleModulePrefix` from `spring-boot/`. Debug flow is the simplest of the attach adapters: run + `waitForPort` + attach.
- **JavaAdapter** — plain Java app with three launch modes: `maven` (runs `mvn exec:java -Dexec.mainClass=…`), `gradle` (runs `./gradlew run` via the `application` plugin), `java-main` (runs `java -cp … MainClass`). **Maven and Gradle modes ignore `vmArgs`** — `exec:java` runs in the Maven JVM, and Gradle's `run` task reads JVM args from `application { applicationDefaultJvmArgs }` in `build.gradle`. Only `java-main` mode forwards `vmArgs`. Debug attach uses `MAVEN_OPTS` for Maven (not `JAVA_TOOL_OPTIONS` — that would double-bind JDWP on the forked plugin JVM) and `JAVA_TOOL_OPTIONS` for Gradle. `detectJavaApp` bails when Spring Boot / Quarkus / Tomcat markers are present so those adapters keep priority. Shares `findMainClasses` with Spring Boot (moved to `src/adapters/java-shared/`). Ready patterns intentionally empty — a plain Java app has no universal startup marker, so the tree stays in the spinner for the life of the process.

## Services

**ConfigStore** — per-workspace-folder state: parsed `RunFile`, list of `InvalidConfigEntry`, file watcher, debounce timer. Load path runs migrations row-by-row (`migrateRaw`, `migrateSpringBootConfig`) before Zod validation so legacy files validate against the current schema. Writes are atomic (write tmp, rename). Emits `onChange`. API: `attach(folder)`, `getForFolder`, `invalidForFolder`, `save`, `replaceValid`, `removeInvalid`, `dispose`.

**RunConfigService** — thin CRUD over ConfigStore. `list()` returns `ConfigRef[]` (discriminated on `valid`). `create/update/delete` handle both valid and invalid entries.

**ExecutionService** — owns five state sets per config id: `preparing`, `running` (a `Map<id, Entry>`), `started`, `failed`, `rebuilding`. `run(cfg, folder, opts?)` resolves variables, calls `prepareLaunch` (setting preparing), spawns a `RunTerminal` with a `prettifier` and the readiness/failure/rebuild scanner as `onOutput`. Fires `onRunningChanged(configId)` on every transition. The rebuild scanner only runs for npm configs — JVM runtimes have their own reload semantics that map cleanly to ready patterns. Stop clears all state for the id. The Gradle rebuild watcher is a separate secondary task tracked in `Entry.watcher`; it's killed when the main task ends but its own death doesn't affect the main task's state.

**DebugService** — debugging has two flavors:
- **Launch** (npm, spring-boot/java-main, java/java-main): calls `vscode.debug.startDebugging(folder, getDebugConfig(cfg))`. That's it.
- **Attach** (spring-boot/maven or gradle, tomcat, quarkus, java/maven or gradle): runs the config first (injecting JDWP via `JAVA_TOOL_OPTIONS` for Spring Boot Gradle and java/gradle, `MAVEN_OPTS` for java/maven, `CATALINA_OPTS` for Tomcat, or relying on Quarkus's own `-Ddebug=<port>` flag), waits for the JDWP socket to open (`waitForPort`), then `startDebugging` with an `attach` config. If attach fails the run task is killed.

Tracks `running` sessions and fires `onRunningChanged` the same way ExecutionService does. The tree listens to both.

**RunTerminal** — a `vscode.Pseudoterminal`. On `open()` it spawns the child via `cp.spawn(shell, [-c|-/c, cmdLine], { cwd, env })` so shell metachars in adapter-emitted commands still work. Forwards stdout/stderr; each chunk goes through `prettifier.process()` before being written, and the raw chunk (not the transformed text) is handed to `onOutput` so the scanner's regexes still match. On exit it flushes the prettifier. Ctrl+C/Ctrl+D trigger `kill()` (SIGTERM → SIGKILL after 3s).

**readyPatterns** — `readyPatternsFor(cfg)`, `failurePatternsFor(cfg)`, `chunkSignalsReady`, `chunkSignalsFailure`. Patterns are biased toward false negatives: "it's better to stay in the spinner than flip green early." When adding a new runtime or fixing a missed signal, add a test in `test/readyPatterns.test.ts` in the same shape as the existing ones.

**prettyOutput** — `makePrettifier(cfg, { cwd })` returns a `Prettifier` with `process(chunk)` + `flush()`. Line-buffered (trailing partial lines carry). Per line, in order of precedence:
1. Failure-pattern match → bold-red `✗ ` prefix.
2. Ready-pattern match → bold-green `✓ ` prefix.
3. Already-styled line (contains SGR escapes) → left alone except hyperlinks compose onto it.
4. Plain line → dim timestamp, color the log level (`ERROR` red, `WARN` yellow, `INFO` blue, `DEBUG`/`TRACE` gray).
5. All lines get URLs (http/https) and file paths (with optional `:line[:col]`) wrapped in OSC 8 hyperlinks; relative paths resolve against the run's cwd.

**ProjectScanner** — wraps `adapter.detect` and logs a compact summary (scripts=[...], jdks=[N detected], etc.) to the output channel. Used by the "Add" flow.

**migrateSpringBoot** — pure function. Adds missing fields with safe defaults (e.g., legacy configs without `launchMode` get `launchMode = buildTool`). Applied pre-Zod-validation in ConfigStore.

## Recovery

`src/recovery/buildRecoveredConfig.ts` — best-effort extractor that turns an `InvalidConfigEntry.rawText` into a `Partial<RunConfig>` the editor can pre-populate. Never throws. Pulls id/name/type/projectPath/env (string-valued entries only)/programArgs/vmArgs/port. For spring-boot, salvages buildTool + profiles; otherwise defaults to npm-shaped typeOptions.

## UI

**RunConfigTreeProvider** — renders 4 kinds of tree nodes: `folder`, `typeGroup` (only when >1 config of a type in a folder), `config`, `invalid`. A config has 6 possible visual states, precedence top-to-bottom:
- `preparing` — blue `sync~spin`, description `Preparing…` (`exec.isPreparing`).
- `rebuilding` — yellow `sync~spin`, description `Rebuilding…` (`exec.isRebuilding`). Dev servers (Angular, Vite, CRA, webpack, Next.js) set this on file-watch. Next ready pattern → green; next failure pattern → red.
- `failed` — red `error` icon, description `Failed` (`exec.isFailed`).
- `running && !started` — `loading~spin`, description `Starting…`.
- `started` — green `pass-filled`.
- else — type icon (`package` / `rocket` / `server-environment`).

The tree emits `runConfig.edit` on item click so single-click opens the editor. Tooltip shows command preview + state summary via `buildCommandPreview`.

**EditorPanel** — singleton `vscode.WebviewPanel` with `retainContextWhenHidden: true`. Messages it handles (`src/shared/protocol.ts`): `save`, `cancel`, `pickFolder`, `recomputeClasspath`, `testVariables`. Messages it posts: `init`, `schemaUpdate`, `configPatch`, `folderPicked`, `classpathComputed`, `variablesTested`, `error`. Streaming detection runs inside `openForCreate`; each `StreamingPatch` produces a `schemaUpdate` + `configPatch` pair.

## Webview

**App.tsx** owns form state (values, schema, pending-field keys for busy spinners). It uses `acquireVsCodeApi().postMessage` to talk to the extension. `classpathLooksLikeHint()` detects when a spring-boot classpath is still the hint text and triggers a recompute. `mergeBlanks` merges patches only into undefined/null/"" fields.

**ConfigForm.tsx** renders 3 sections (`common`, `typeSpecific`, `advanced`) from the FormSchema. Command preview at the top uses the shared `buildCommandPreview`.

**formSchema.ts** (`src/shared/`) — `FormField` kinds: `text`, `textarea`, `number`, `select`, `selectOrCustom`, `csvChecklist`, `boolean`, `kv`, `folderPath`. Each field may have `help`, `examples`, `dependsOn` (visibility), `action` (button with a message type), `inspectable` (adds eye icon opening `InspectDialog`).

**Widgets**: `Field.tsx` is the router; `InspectDialog.tsx` tokenizes long values (vmArgs, classpath) row-by-row; `SelectOrCustom.tsx` is a dropdown that also accepts free text; `KvEditor.tsx` is the env-var table; `CsvChecklist.tsx` is multi-select + custom text (used for Spring Boot profiles); `FolderPathInput.tsx` is the folder picker.

## Variable resolution (`src/utils/resolveVars.ts`)

Supported tokens: `${VAR}`, `${env:VAR}`, `${workspaceFolder}`, `${userHome}`, `${cwd}`, `${projectPath}`. `resolveConfig(cfg, ctx)` recurses into every string field and returns `{ value, unresolved[] }`. Unresolved variables become empty strings at runtime (the extension logs a warning); the on-disk config is never rewritten. `makeRunContext({ workspaceFolder, cwd })` builds the context; `ExecutionService` calls it before handing the config to the adapter.

## Testing

**`__mocks__/vscode.ts`** — minimal mock providing: `Uri` class, `EventEmitter`, `workspace.fs` (backed by an in-memory `Map<string, Uint8Array>`), file watchers, `tasks.executeTask` with start/end emitters, `debug.startDebugging` with session emitters, `window.show*` as `jest.fn()`. Tests seed the FS via `__writeFs(path, data)` and can fire watcher events via `__watchers`.

**jest.config.js** — `ts-jest` preset; `moduleNameMapper` maps `vscode` → the mock. Coverage excludes `src/extension.ts` (hard to meaningfully test — it's all activation wiring).

**Test style**: each service + adapter has a `.test.ts` in `test/`. Start with `ExecutionService.test.ts` or `RunConfigService.test.ts` as templates for new tests. Keep fixtures inline — no test fixtures directory.

## Build pipeline

- **`esbuild.config.mjs`** — bundles `src/extension.ts` to `out/extension.js` (CommonJS, Node 18, vscode external, sourcemaps on).
- **`vite.config.ts`** — bundles the webview under `media/webview/`.
- **tsconfig split**: `tsconfig.extension.json` for extension code, `tsconfig.webview.json` for React + DOM. `npm run typecheck` runs both with `--noEmit`.
- **package.json scripts**: `build` = clean + webview + extension, `watch` runs both in parallel via `npm-run-all`, `package` wraps `vsce package --no-dependencies`.

## Conventions to match existing code

- **No emojis in code or commit messages** unless the user asks.
- **Comments explain *why*, not *what*** — see existing files for tone. Don't narrate what the next line does; call out hidden constraints, invariants, and non-obvious tradeoffs (the port-poll removal comment is a good example).
- **Commit style**: `feat|fix|refactor(scope): one-line summary` in the subject; body explains motivation and tradeoffs. Sign with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **When in doubt about UI state machines**, re-read `RunConfigTreeProvider.getTreeItem` — it's the authoritative reference for state precedence.
- **Prefer `Edit` over `Write` for existing files.** `Write` is used here only for new files.

## Known tricky spots

- **`JAVA_TOOL_OPTIONS` escape semantics**: spaces inside the Logback pattern are tokenized by the JVM as option separators. We pass pattern fragments using U+00A0 (non-breaking space) as internal whitespace, and real spaces only between JVM options. Handled in `SpringBootAdapter.prepareLaunch`.
- **Gradle multi-module projects**: a config's `projectPath` may point at a module that isn't the Gradle root. `findBuildRoot.ts` walks up to find `settings.gradle[.kts]`; `gradleModulePrefix` then computes `:api`, `:tardis-api`, etc. for task scoping. Never assume `projectPath === buildRoot`.
- **Java debugger's "Resolving main class" hang**: fixed by setting `projectName: ''`, `modulePaths: []`, `sourcePaths: []`, `shortenCommandLine: 'auto'` in the debug config. Don't drop those defaults.
- **Tomcat JDWP bind address**: must be `0.0.0.0:<port>` (not `localhost`) or VS Code can't attach from the host when Tomcat runs inside WSL/containers.
- **`EditorPanel.sanitize()` drops unknown fields.** If a new `typeOptions` field isn't persisting on save, that's almost certainly why — sanitize must be updated to forward it.
- **Invalid entries show a wrench, not a gear**, and clicking `Fix` opens the editor with `buildRecoveredConfig` output pre-filled. Deleting an invalid entry removes it from the store's invalid list; the file on disk is updated on the next `save()`.

## Recent architectural decisions (for context, not to undo)

- **Port-poll readiness removed** (commit `6e17451`) — regex-only readiness + failure detection. Don't add port polling back.
- **Prettifier added** (commit `80fe3ed`) — ANSI + OSC 8 hyperlinks in the pseudoterminal. Raw text still feeds the scanner.
- **Auto Create + Stop All** (commit `d2da331`) — title-bar buttons. `rcm.anyRunning` context key gates Stop All visibility. Auto-create priority: `spring-boot > quarkus > tomcat > java > npm`.
- **Quarkus adapter** — fourth runtime type. Mirrors Spring Boot's shape but simplifies: only two launch modes (`maven`/`gradle`, no java-main), debug opens itself via `-Ddebug=<port>` instead of `JAVA_TOOL_OPTIONS` injection, single profile via `-Dquarkus.profile`. No rebuild watcher — Live Coding is built in.
- **Java Application adapter** — fifth runtime type. Three launch modes (`maven exec:java` / `gradle run` / `java-main`) for plain (non-framework) Java apps. **vmArgs only work in `java-main` mode** — Maven's `exec:java` runs in the Maven JVM and Gradle's `run` task reads JVM args from `application { }` in the build file. Debug attach uses `MAVEN_OPTS` for Maven to avoid double-binding JDWP on the forked plugin JVM. `findMainClasses` moved out of `spring-boot/` into `java-shared/` — shared between Spring Boot and Java adapters.
- **Streaming detection** — Tomcat/Gradle probes used to block editor open for 30+s. Now `detectStreaming` runs them in parallel and patches the form as results arrive.

## When you start a new task

1. Read the user's request carefully; if it's a bug report, use `superpowers:systematic-debugging` rather than guessing.
2. Check `git log --oneline -20` for context on what was touched recently.
3. Reproduce the issue in a test if possible — the Jest suite is fast enough that TDD is the default mode.
4. Make changes; run `npm run typecheck && npm test` before committing; run `npm run build` before declaring "done".
5. Keep diffs minimal. No drive-by refactors unless the user asked.
