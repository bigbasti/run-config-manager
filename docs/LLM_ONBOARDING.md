# Run Configuration Manager — LLM Onboarding

This document is written for a fresh LLM session taking over work on this repo. It is not a tutorial; it is an index. Read it end-to-end first, then use the file references as jumping-off points.

## What this is

A VS Code extension that gives the editor IntelliJ-style run configurations. Configs live in `.vscode/run.json`, rendered as a tree in the Activity Bar. Each config has a type (`npm`, `python`, `spring-boot`, `tomcat`, `quarkus`, `java`, `maven-goal`, `gradle-task`, `custom-command`, `docker`, `http-request`, `go`), and the extension spawns the right shell command for you, scanning the terminal output to show whether the app is starting, started, or failed. A webview-based editor lets the user create/edit configs with a schema-driven form.

Repo root: `/git/run-config-manager`. Main branch: `main`. Independent git repo (not a submodule).

Current version: see `package.json` (`"version"` field). Treat that as authoritative — the doc value will drift.

## Golden rules (read these first)

1. **Do not use `ShellExecution` for run commands.** We rely on observing stdout in real time to detect readiness/failure. `ShellExecution` hands the PTY to VS Code and we see nothing. `src/services/RunTerminal.ts` (a `vscode.Pseudoterminal`) exists for that reason. `ShellExecution` is OK for fire-and-forget tasks like the Gradle rebuild watcher, the npm/python pre-flight installers, and the interactive `custom-command` mode.
2. **Do not reintroduce port-polling for readiness.** It was removed deliberately — dev-server sockets (Vite, Angular) bind before the app is actually usable, so polling gave false greens. Use regex patterns only (`src/services/readyPatterns.ts`).
3. **Do not break the streaming-detection contract.** When a user clicks "Add", the editor must open instantly. Heavy probes (Gradle classpath, JDK scan, main-class walk, pip list, npm framework detection) run inside `adapter.detectStreaming(folder, emit)` and push `StreamingPatch` messages as they finish. Never move that work back into synchronous `detect()`.
4. **Do not rewrite unresolved variables on disk.** `resolveVars` returns a resolved copy for runtime; `.vscode/run.json` keeps the `${...}` tokens.
5. **`mergeBlanks` preserves user edits.** Streaming patches, fallback detection, and migration code all merge into existing config with "only fill if blank/undefined/empty". Respect that semantics when adding new fields.
6. **Save state correctness in EditorPanel.** New `typeOptions` fields are dropped on save unless `sanitize()` forwards them. Cover any new field end-to-end: schema → form → sanitize → store → resolveConfig → adapter.
7. **No auto-commits.** The session-wide directive is that the user reviews changes and commits manually. Do NOT run `git commit`. Plans explicitly state "DO NOT COMMIT" in their verification steps.
8. **Run `npm run typecheck && npm test && npm run build` before claiming done.** Jest runs 877+ tests with an in-memory `vscode` mock; the bar is green.
9. **Avoid the shell-init race.** Some user shells print banners (`* start-stop-daemon: wsl-vpnkit is already running`) when `createTerminal + sendText` is used; the banner intercepts the typed command. For one-shot installers and helper commands, prefer `vscode.tasks.executeTask` with a `ShellExecution` and a non-interactive `bash` (`-c`, no rc-file). See `src/services/runInTerminal.ts` and the npm/python pre-flight install paths.

## High-level layout

```
src/
  extension.ts                      # activate(): wires everything
  shared/                           # code shared with webview (runs in both)
    types.ts                        # RunConfig discriminated union
    schema.ts                       # Zod schemas
    formSchema.ts                   # FormField union consumed by webview
    protocol.ts                     # extension ↔ webview message shapes
    buildCommandPreview.ts          # pretty-printed command line for tree tooltips
  adapters/
    RuntimeAdapter.ts               # the interface every adapter implements
    AdapterRegistry.ts              # Map<RunConfigType, RuntimeAdapter>
    sharedFields.ts                 # envFiles, dependsOn, closeTerminalOnExit
    npm/                            # NpmAdapter + detectPackageJson + detectNpmFramework
    python/                         # PythonAdapter + detectPythons + detectFrameworks +
                                    #   findAsgiApps + buildPythonCommand + checkDependencies
    spring-boot/                    # SpringBootAdapter + detectJdks + recomputeClasspath
    tomcat/                         # TomcatAdapter + tomcatRuntime (CATALINA_BASE scaffold)
    quarkus/                        # QuarkusAdapter + detectQuarkus + findQuarkusProfiles
    java/                           # JavaAdapter + detectJavaApp
    java-shared/                    # findMainClasses (used by spring-boot + java)
    maven-goal/                     # MavenGoalAdapter + discoverMavenGoals
    gradle-task/                    # GradleTaskAdapter + discoverGradleTasks
    custom-command/                 # CustomCommandAdapter
    docker/                         # DockerAdapter (container start/stop)
    http-request/                   # HttpRequestAdapter (REST client invocation)
    go/                             # GoAdapter + detectGos + probeGoVersion +
                                    #   probeGosStreaming + findGoMains
  services/                         # runtime orchestration (no UI)
    ConfigStore.ts                  # .vscode/run.json loader + watcher, per workspace folder
    RunConfigService.ts             # thin CRUD wrapper on top of store
    ExecutionService.ts             # spawns + tracks run state (preparing/started/failed)
    DebugService.ts                 # attaches Java debugger; routes opts.monitor to ExecutionService
    DependencyOrchestrator.ts       # walks dependsOn graph, starts deps in order with delays
    DockerService.ts                # container lifecycle for type=docker
    GroupService.ts                 # tree-folder run/stop/debug all (sequential + parallel)
    NativeRunnerService.ts          # bridge to launch.json + tasks.json native entries
    HttpRequestRunner.ts            # invocation engine for http-request configs
    MonitoringService.ts            # JVM JMX agent lifecycle (sparkline + heap dump)
    PortScanner.ts                  # used by PortViewerPanel
    JdkInstallerService.ts          # cloud-icon JDK download
    MavenInstallerService.ts        # cloud-icon Maven download
    GradleInstallerService.ts       # cloud-icon Gradle download
    NodeInstallerService.ts         # standalone Node tarball install
    NvmInstallerService.ts          # routes Node install through `nvm install`
    TomcatInstallerService.ts       # cloud-icon Tomcat download
    BuildToolSettingsService.ts     # global settings (proxies, mirrors, pip index)
    EnvFileLoader.ts                # reads envFiles + merges
    RunTerminal.ts                  # Pseudoterminal — owns child process, feeds prettifier
    readyPatterns.ts                # regex patterns for started/failed detection
    prettyOutput.ts                 # line-buffered ANSI + OSC 8 hyperlink prettifier
    runInTerminal.ts                # shared Task-based one-shot runner (avoids shell-init race)
    buildActions.ts                 # right-click action resolution (build, npm:, pip:, go:)
    detectProjectPort.ts            # framework-aware default port discovery
    dependencyCandidates.ts         # parses ref strings (rcm:/launch:/task:)
    monitoring/                     # JMX agent helpers
      AgentMessage.ts               # NDJSON wire-format types
      buildMonitorJvmArgs.ts        # -Dcom.sun.management.jmxremote.* flag list
      freePort.ts                   # OS-allocated TCP port via listen(0)
      parseClassHistogram.ts        # package-prefix grouping for the table
    migrations.ts                   # row-level migration entry
    migrateSpringBoot.ts            # spring-boot specific migrations
    configHealth.ts                 # diagnostics summary
  recovery/
    buildRecoveredConfig.ts         # salvages fields from an InvalidConfigEntry
  ui/
    RunConfigTreeProvider.ts        # the visual states + sparkline live here
    EditorPanel.ts                  # singleton webview host + message router
    MonitorPanel.ts                 # JVM monitoring webview host
    PortViewerPanel.ts              # workspace port scanner panel
    NativeRunnerTreeProvider.ts     # tree of launch.json + tasks.json entries
    NativeLaunchContentProvider.ts  # virtual document provider for native entries
    iconForConfig.ts                # brand-SVG resolution + npm/python sub-type detection
  utils/
    resolveVars.ts                  # ${...} expansion — empty string on unresolved
    paths.ts                        # workspaceFolder-aware path helpers
    logger.ts                       # output channel sink
    uuid.ts
media/
  icons/                            # brand SVGs — all monochrome: dark=#CCCCCC, light=#3C3C3C.
                                    # Every brand has <name>.svg (dark) + <name>-light.svg.
                                    # Generated by scripts/generate-icons.mjs (simple-icons).
                                    # python.svg and http-request.svg are hand-crafted.
                                    # DO NOT use brand colors — the tree's state colors
                                    # (green=running, red=failed, yellow=rebuilding) must
                                    # not compete with icon hues.
  webview/                          # built webview bundle (gitignored output of vite)
  agent/
    rcm-monitor.jar                 # bundled JMX monitoring agent (built from monitor-agent/)
monitor-agent/                      # Java + Maven source for rcm-monitor.jar
  pom.xml
  src/main/java/com/runconfig/monitor/Monitor.java
  README.md                         # build + wire format docs
webview/src/                        # React app that renders inside webview panels
  main.tsx                          # routes to App or MonitorView based on root data attrs
  App.tsx                           # editor top-level state machine
  ConfigForm.tsx                    # renders common + typeSpecific + advanced sections
  MonitorView.tsx                   # JVM monitor webview (chart + analytics + histogram)
  HelpPanel.tsx                     # markdown-subset help renderer
  PortViewerPanel.tsx               # webview body for the port viewer
  BuildToolSettingsPanel.tsx        # global settings webview
  *DownloadDialog.tsx               # JDK/Maven/Gradle/Node/Tomcat installer UIs
  form/                             # Field, InspectDialog, SelectOrCustom, KvEditor, ...
  state.ts
test/                               # 83 jest test files, 877+ cases
__mocks__/vscode.ts                 # in-memory filesystem + event emitters
docs/superpowers/specs/             # design docs (one per major feature)
docs/superpowers/plans/             # implementation plans (one per design)
```

## Core types (src/shared/types.ts)

`RunConfig` is a discriminated union on `type`:

- `npm` — `scriptName`, `packageManager` (`npm|yarn|pnpm`), `nodePath` (selected Node interpreter).
- `python` — `pythonPath`, `launchMode` (`module|script|fastapi|flask|django|celery|run-as-script|custom`), `module` / `script` / `appTarget` / `target` / `manageScript` / `command` (depends on launchMode), `pipProxy?`. Five "smart" launch modes for frameworks; `run-as-script` runs a `.py` file directly; `custom` is free-form. Debug uses `debugpy`.
- `spring-boot` — `launchMode` (`maven|gradle|java-main`), `buildTool`, `gradleCommand` (`./gradlew|gradle`), `profiles`, `mainClass`, `classpath`, `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot`, `debugPort?`, `rebuildOnSave?`, `colorOutput?`, `recomputeClasspathOnRun?`.
- `tomcat` — `tomcatHome`, `jdkPath`, `httpPort`, `jmxPort?`, `buildProjectPath`, `buildRoot`, `buildTool`, `gradleCommand`, `gradlePath`, `mavenPath`, `artifactPath`, `artifactKind` (`war|exploded`), `applicationContext`, `vmOptions`, `reloadable`, `rebuildOnSave`, `colorOutput?`.
- `quarkus` — `launchMode` (`maven|gradle` — no java-main), `buildTool`, `gradleCommand`, `profile` (single, not CSV), `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot`, `debugPort?`, `colorOutput?`.
- `java` — plain Java app. `launchMode` (`maven|gradle|maven-custom|gradle-custom|java-main`), `buildTool`, `gradleCommand`, `mainClass`, `classpath`, `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot`, `debugPort?`, `colorOutput?`. The `*-custom` modes let the user supply a custom Maven goal / Gradle task instead of `exec:java` / `run`.
- `maven-goal` — `goal` (free-form, non-empty), `jdkPath`, `mavenPath`, `buildRoot`, `colorOutput?`. `supportsDebug=false`.
- `gradle-task` — `task` (free-form, non-empty), `gradleCommand`, `jdkPath`, `gradlePath`, `buildRoot`, `colorOutput?`. `supportsDebug=false`.
- `custom-command` — arbitrary shell command. `command` (required), `cwd?`, `shell` (`default|bash|sh|zsh|pwsh|cmd`), `interactive` (uses `ShellExecution` so stdin works), `colorOutput?`. `supportsDebug=false`.
- `docker` — `containerId`, `imageName?`. Lifecycle delegated to `DockerService`. No build command — runs `docker start <id>`.
- `http-request` — `url`, `method`, `headers`, `body`. Driven by `HttpRequestRunner`, not the spawn pipeline.
- `go` — `launchMode` (`run|test|build|install|custom`), `goPath` (selected Go installation root, empty = PATH), `packagePath` (package passed to `go run`/`go build`/`go install`), `testArgs` (free-form for `go test`), `outputPath` (`-o` flag for `go build`), `customArgs` (verbatim args for custom mode), `buildRoot` (module root if different from projectPath), `race?` (adds `-race`), `colorOutput?`. `supportsDebug=true` — uses Delve via the `golang.go` extension. `vmArgs` repurposed as "Go tool flags" (`-ldflags`, `-tags`, `-trimpath`).

Shared base fields: `id`, `name`, `projectPath`, `workspaceFolder`, `env`, `envFiles?`, `programArgs`, `vmArgs`, `port?`, `dependsOn?` (array of dependency refs with delaySeconds), `groupName?` (folder grouping in tree), `closeTerminalOnExit?`.

`InvalidConfigEntry` — entries that failed schema validation but are kept so the user can "Fix Invalid Configuration" from the tree.

Zod schemas in `src/shared/schema.ts` use `z.discriminatedUnion('type', ...)`.

## The adapter contract (src/adapters/RuntimeAdapter.ts)

Every runtime implements:

- **`type` / `label` / `supportsDebug`** — static metadata.
- **`detect(folder)`** — synchronous probe. Returns defaults + context for `getFormSchema`. Null = unrecognized.
- **`detectStreaming?(folder, emit)`** — optional async detection. Pushes `StreamingPatch` items as probes finish. Each patch: `contextPatch`, `defaultsPatch`, `resolved` (field keys to drop spinner on).
- **`getFormSchema(context)`** — builds the form schema. Runs on initial detect and every streaming patch.
- **`buildCommand(cfg, folder?)`** — the shell command ExecutionService runs.
- **`prepareLaunch?(cfg, folder, ctx)`** — pre-spawn hook. `ctx` shape:
  ```ts
  { debug: boolean; debugPort?: number; monitor?: boolean; monitorPort?: number }
  ```
  Returns `{ env?, cwd?, extraArgs?, cfg? }`. Used by Tomcat (CATALINA_BASE scaffold), Spring Boot (color flags + JDWP init script + monitor init script), Java (JDWP init script + monitor init script), Quarkus (`-Djvm.args=...`), npm/python (Node selection / pip pre-flight), Go (`GOROOT` + PATH prepend).
- **`getDebugConfig?(cfg, folder)`** — returns the launch config for `vscode.debug.startDebugging`.

Adapters register themselves in `extension.ts` on activation via `AdapterRegistry.register`.

Distinctive behaviors per adapter:

- **NpmAdapter** — reads `package.json` scripts. **Framework-aware**: `detectNpmFramework` recognizes Next.js, Nuxt, SvelteKit, Astro, Remix, Gatsby, Angular, Storybook, Svelte, Vue, React/CRA, Vite. Surfaces a "Detected: …" badge in the form, pre-fills the framework default port. **Node selection**: a dropdown lists detected Node interpreters from `$NODE_HOME` / `$NVM_DIR` / `nvm`/`volta`/`asdf`/`fnm`/`n` pools / standard install locations. The selected Node's `bin/` is prepended to `PATH` at launch. **Cloud-icon installer** downloads from `nodejs.org` directly OR routes through `nvm install` when nvm is detected. **node_modules pre-flight**: when `package.json` was modified after `node_modules`, the run pauses with an "Install all" toast that runs `npm/yarn/pnpm install` via a Task before the user re-clicks Run.
- **PythonAdapter** — five "smart" launch modes (`module|script|fastapi|flask|django|celery|run-as-script|custom`). `findAsgiApps` scans for `FastAPI()` / `Flask()` / `Starlette()` / `Celery()` instances and pre-fills `appTarget` / `target`. `findDjangoProject` looks for `manage.py`. `FRAMEWORK_M_TARGET` map routes fastapi/starlette through `uvicorn`. **pip pre-flight**: parses `pyproject.toml`/`requirements.txt` and compares against `pip list` output; missing deps trigger an "Install all" toast (executed via Task to dodge the shell-init race). Right-click `pip:` actions install/upgrade specific packages. Debug uses `debugpy`. Auto-detect `pipProxy` from `pip config get global.proxy` lives in `BuildToolSettingsPanel`.
- **SpringBootAdapter** — `findMainClasses`, `detectJdks`, `findProfiles`, `findBuildRoot`, `recomputeClasspath`, `readServerPort`. Multi-module Gradle handled by `gradleModulePrefix`. For `java-main`, `recomputeClasspath` invokes `./gradlew printRuntimeClasspath` via an init script. **JDWP injection**: `gradle` mode uses an init-script targeting `bootRun.jvmArgs` (avoids the daemon double-binding the port); `maven` mode wraps in `-Dspring-boot.run.jvmArguments`; `java-main` puts `-agentlib:jdwp=...` directly on the java command line. **Monitor flag injection** (see "JVM monitoring" below): `gradle` mode extends the same init script with `-Dcom.sun.management.jmxremote.*`; `maven` mode composes monitor flags into `cfg.vmArgs` so they land in `-Dspring-boot.run.jvmArguments`; `java-main` composes into vmArgs directly.
- **TomcatAdapter** — delegates to `tomcatRuntime.ts`: per-config `CATALINA_BASE` (conf/, logs/, temp/, webapps/, work/), rewrites `server.xml` with user ports + context + `reloadable`, deploys WAR or symlinks exploded dir, returns `CATALINA_BASE`, `CATALINA_OPTS` (JDWP via `-agentlib:jdwp=...` bound to `0.0.0.0` so VS Code can attach across WSL/containers), `JAVA_HOME`. Monitor flags appended to `CATALINA_OPTS` directly. **Caveat**: when the user has set `typeOptions.jmxPort`, that emits its own `-Dcom.sun.management.jmxremote.port=`, which collides with the monitor's port. Known v2 issue — needs precedence.
- **QuarkusAdapter** — two launch modes (`maven`/`gradle`). JDWP via `-Ddebug=<port>` (Quarkus's own flag, no juggling needed). Monitor flags compose into `cfg.vmArgs`, which `buildMaven`/`buildGradle` forward via `-Djvm.args=...` (the Quarkus plugin applies that to the forked dev JVM only). Reuses `findBuildRoot`, `detectJdks`, `gradleModulePrefix` from `spring-boot/`.
- **JavaAdapter** — five launch modes: `maven` (`mvn exec:java`), `gradle` (`./gradlew run`), `maven-custom` / `gradle-custom` (user-supplied goal/task), `java-main` (`java -cp …`). **vmArgs only work in `java-main`** in the `maven` mode (`exec:java` runs in the Maven JVM); in gradle modes they flow through the init script. **JDWP**: `maven`/`maven-custom` uses `MAVEN_OPTS`; `gradle`/`gradle-custom` uses an init script targeting `JavaExec` tasks; `java-main` adds the agent flag directly. **Monitor flags**: same channels as JDWP — gradle modes extend the JavaExec init script; maven modes use `JAVA_TOOL_OPTIONS` (no fork — Maven JVM IS the app JVM); java-main goes through vmArgs.
- **CustomCommandAdapter** — shell-interpreted arbitrary command. When `interactive: true`, ExecutionService routes through `ShellExecution`. Auto-create skips this type.
- **MavenGoalAdapter / GradleTaskAdapter** — saved one-click launchers. `supportsDebug=false`. Form has `Load tasks` / `Load phases & plugin prefixes` action button; results stored in EditorPanel context. Auto-create skips these.
- **DockerAdapter** — container start/stop via `DockerService`. Tree shows running containers; right-click runs/stops. Independent of the spawn pipeline.
- **HttpRequestAdapter** — single REST request invocation. `HttpRequestRunner` formats response into the output channel.
- **GoAdapter** — five launch modes (`run`, `test`, `build`, `install`, `custom`). **Go installation detection**: `detectGos` scans `$GOROOT`, `which go`, version managers (gvm, asdf, mise, goenv), Homebrew, and standard OS paths; `probeGosStreaming` runs a two-phase probe (paths first, versions via `go version` second). **Main package detection**: `findGoMains` walks the project tree (up to 4 levels, 500 files) for `package main` + `func main()`, populates the package dropdown. `buildCommand` constructs `go run|test|build|install|<custom>` argv via `splitArgs`. `prepareLaunch` sets `GOROOT` + prepends `<goPath>/bin` to PATH. `getDebugConfig` returns `{ type: 'go', request: 'launch', mode: 'auto', program: <absolute-pkg-path> }` for the Delve DAP adapter — **program must be absolute** (see tricky spot #13). `vmArgs` serves as "Go tool flags" (`-ldflags`, `-tags`). Right-click actions: `go mod tidy`, `go mod download`, `go build ./...`, `go test ./...`. The "golang.go extension missing" info banner is shown **only** when `vscode.extensions.getExtension('golang.go')` returns undefined (checked in `detectStreaming`, threaded through context as `goExtensionMissing`). Do NOT use `validateBuildPath` on the projectPath field — it checks for Maven/Gradle markers and is irrelevant for Go projects. Monitoring is not supported (Go is not a JVM).

  **Quarkus monitoring delay**: Quarkus uses `ShellExecution` (interactive PTY for its dev menu) which means the monitoring agent is spawned immediately but the forked JVM takes 15–60 s to start. `ExecutionService` delays `monitoring.attach` by `QUARKUS_MONITOR_ATTACH_DELAY_MS` (30 s) for Quarkus configs, guarded by a per-execution token to prevent stale attaches after stop+restart within the delay window.

## Services

**ConfigStore** — per-workspace-folder state: parsed `RunFile`, list of `InvalidConfigEntry`, file watcher, debounce. Migrations run row-by-row pre-Zod-validation. Atomic writes (write tmp, rename). API: `attach(folder)`, `getForFolder`, `invalidForFolder`, `save`, `replaceValid`, `removeInvalid`, `dispose`.

**RunConfigService** — thin CRUD over ConfigStore. `list()` returns `ConfigRef[]` (discriminated on `valid`).

**ExecutionService** — owns five state sets per config id: `preparing`, `running`, `started`, `failed`, `rebuilding`. `run(cfg, folder, opts?)` resolves variables, calls `prepareLaunch`, spawns a `RunTerminal` with prettifier + readiness/failure scanner. Fires `onRunningChanged(configId)` on every transition. **`opts` shape**: `{ debug?, debugPort?, monitor? }`. When `monitor: true`, allocates a free TCP port via `allocateFreePort()`, threads `monitor` + `monitorPort` into `prepareLaunch`'s ctx, then after launch calls `monitoringService.attach(cfg.id, pid, monitorPort)`. Detach on stop or natural task end. Constructor: `new ExecutionService(registry, monitoring?)` — `monitoring` is the optional last param. Pre-flight installers (npm, python) run before `prepareLaunch` and can abort the run with an "Install all" toast.

**DebugService** — two flavors:
- **Launch** (npm, spring-boot/java-main, java/java-main, python, go): `vscode.debug.startDebugging(folder, getDebugConfig(cfg))`.
- **Attach** (spring-boot/maven|gradle, tomcat, quarkus, java/maven|gradle): runs the config first (with the appropriate JDWP injection per adapter), waits for the JDWP socket via `waitForPort`, then `startDebugging` with an `attach` config. Kills the run task if attach fails.

Go debug requires the `golang.go` extension (checked via `vscode.extensions.getExtension('golang.go')` — same guard pattern as `JAVA_DEBUG_EXTENSION_ID` for Java). The Go debug config uses `type: 'go', request: 'launch', mode: 'auto'`; Delve resolves whether `program` is a source package or binary.

`debug(cfg, folder, opts?)` accepts `opts.monitor`; forwards to `exec.run({ debug: true, debugPort, monitor })`.

**DependencyOrchestrator** — walks `dependsOn` graph, starts deps in order with per-edge `delaySeconds` (skipped when the dep was already running before orchestration started). Cycle-aware. Resolves three ref kinds: `rcm:<id>` (other RCM config), `launch:<name>` (launch.json), `task:<source>::<name>` (tasks.json). `NativeRunnerService` resolves the native ones.

**GroupService** — folder/group level commands: Run All Sequentially, Run All Parallel, Debug All Sequentially / Parallel, Stop All. Recursive — descends into sub-groups.

**DockerService** — tracks container running state via `docker ps`, fires events used by the tree to update icon state. `onChanged` is **edge-triggered** (fires only when `summariesChanged` sees an id/state/status/name difference), not a 3s heartbeat — a dropped event is never redelivered. `docker.start()` is deliberately called *after* the heal subscription is registered in `activate()` so the first `[] -> [containers]` transition is not lost.

**Docker config self-heal** — a re-created container gets a new id, so `typeOptions.containerId` goes stale and the config dies. Three modules: `containerMatch.ts` (`containerIdMatches`, the bidirectional short/long id prefix rule, shared with `DockerService.find`); `dockerConfigHealer.ts` (**pure** `planDockerHeal` → `relink` | `backfillName` actions, plus `healActionKey`); `dockerHealRunner.ts` (`createDockerHealRunner(deps)` — owns the attempted-guard `Set`, the drain-not-drop re-entrancy loop, and the write loop; all vscode access injected). `extension.ts` only builds the deps and subscribes — to **both** `docker.onChanged` and `store.onChange`. The second trigger matters: `onChanged` is edge-triggered on the container list, so saving a new docker config fires nothing, and the backfill that makes it heal-capable would otherwise wait for an unrelated container transition (for a long-lived container, Docker's humanised `status` string means that can be a day away). `containerName` is the **durable identity** and `containerId` a cache of the current instance; the name is backfilled on those two triggers whenever the stored id still resolves, which is what makes pre-existing configs healable (nothing else has ever written that field). The backfill write re-fires `onChange`, and that follow-up pass plans nothing because the name now matches — so it converges in one extra pass rather than looping. Writes re-validate the planned precondition (`oldContainerId` still stored) so a concurrent user edit is never clobbered. Gated by `runConfigManager.docker.autoRelink` (default true). Spec/plan: `docs/superpowers/*/2026-08-14-docker-config-self-heal*`.

**MonitoringService** — JVM JMX monitoring lifecycle. Spawns the bundled `media/agent/rcm-monitor.jar` Java agent, parses NDJSON stdout into a 60-tick ring buffer, fires `onChanged(configId)` on every tick. API: `attach(configId, pid, jmxPort)`, `detach(configId)`, `state(configId)`, `saveHeapDump(configId, path)`, `setHistogramPaused(configId, paused)`, `dispose()`. Identity-checks entries on `child.on('error'/'close')` to avoid stomping a successor entry after fast detach+reattach. Pending heap-dump promises are rejected on detach/close so callers don't hang.

**NativeRunnerService** — bridge to `launch.json` + `tasks.json`. Lists native entries, runs them via the VS Code APIs, tracks running state.

**HttpRequestRunner** — invocation engine for `type=http-request` configs.

**RunTerminal** — `vscode.Pseudoterminal`. On `open()` spawns the child via `cp.spawn(shell, [-c|/c, cmdLine], { cwd, env })` so shell metachars work. Stdout/stderr → prettifier; raw chunks → `onOutput` so the scanner's regexes match unstyled text. `childPid` getter exposes the spawned shell's pid (held by `MonitoringService` for liveness signals — agent connects via JMX). On exit, flushes prettifier. Ctrl+C/Ctrl+D → `kill()` (SIGTERM → SIGKILL after 3s).

**runInTerminal** — shared helper for one-shot installers (`npm install`, `pip install`, etc.) using `vscode.tasks.executeTask` + `ShellExecution` with non-interactive `bash -c`. Avoids the shell-init banner race that breaks `createTerminal + sendText`.

**Installer services** (Jdk, Maven, Gradle, Node, Nvm, Tomcat) — share `archiveInstall.ts` (download + extract) but each handles its own version listing and post-install path computation. NodeInstaller routes through NvmInstaller when nvm is detected on the system.

**BuildToolSettingsService** — global settings (Maven mirror, Gradle proxy, pip proxy) shared across configs; persisted in extension storage.

**EnvFileLoader** — reads dotenv-style files declared in `cfg.envFiles` and merges them into the env passed to `prepareLaunch`. User `cfg.env` takes precedence.

**RunStateStore + reattachOnStartup + configPorts** — auto-reattach after a window / extension-host reload. `RunStateStore` persists `{ports, pid, name, type, startedAt}` per started config in `workspaceState` (`rcm.runState.v1`). `resolveExpectedPorts(cfg, folder)` (configPorts.ts) = `inferConfigPortsDetailed(cfg).explicit` ∪ `detectProjectPort` (spring-boot/quarkus/npm). `reattachOnStartup` scans listening ports on activation and, for each persisted entry whose recorded port is still listening (and pid matches when known), calls `exec.reattach(id, livePid, ports)`; stale / deleted-config entries are pruned. Reattached configs are tracked in `ExecutionService.external` (no TaskExecution): they count as `isRunning`/`isReattached` but **not** `isStarted` (we observed a socket, not a readiness signal); `stop()` kills the live pid. `ExecutionService.dispose()` deliberately does NOT terminate main run tasks (so survivors can be reattached). `run()` calls `resolvePortConflict()` before launch: if the expected port is already in use it prompts modal **Kill & Restart** / **Reattach** / cancel. All of this is gated on `runState` being wired — omit it (as existing tests do) and the feature (and its port scans) are disabled.

**readyPatterns** — `readyPatternsFor(cfg)`, `failurePatternsFor(cfg)`, `chunkSignalsReady`, `chunkSignalsFailure`. Patterns biased toward false negatives.

**prettyOutput** — line-buffered ANSI + OSC 8 hyperlinker. Per-line precedence: failure → bold-red `✗`; ready → bold-green `✓`; already-styled → leave alone; plain → dim timestamp + colored log level. URLs and file paths get OSC 8 hyperlinks (paths resolve against cwd).

**buildActions** — right-click action triad pattern: `BuildAction` (maven/gradle: clean/build/test), `NpmAction` (install/update/prune), `PythonAction` (installEditable/installRequirements/upgrade/freeze/list), `GoAction` (modTidy/modDownload/build/test). Each triad has a type, a label function, a context interface, a resolver (`resolveBuildContext` / `resolveNpmContext` / `resolvePythonContext` / `resolveGoContext`), and a command builder. The `:go` tool suffix drives Go-specific menu entries in `package.json`; the corresponding commands (`runConfig.goAction.*`) are registered in `extension.ts` via `runGoActionFor`.

## JVM monitoring (added 2026-05-12)

A bundled Java agent (`media/agent/rcm-monitor.jar`, ~10 KB, source in `monitor-agent/`) connects to a target JVM via JMX and emits NDJSON metrics + class histogram + heap dumps on stdout. The extension spawns it after launch and surfaces the data in the tree row (sparkline + heap MB + CPU%) and in a dedicated `MonitorPanel` webview.

**Right-click entries** on idle JVM configs (Spring Boot/Quarkus/Java/Tomcat with `:maven` or `:gradle` build tool):
- `runConfig.runMonitored` — Run with Monitoring
- `runConfig.debugMonitored` — Debug with Monitoring
- `runConfig.openMonitor` — Open Monitor View (visible only when `:monitored` contextValue is present)

**Data flow** (happy path):
1. Command → `ExecutionService.run({ monitor: true })` (or via `DebugService.debug({ monitor: true })`).
2. `allocateFreePort()` (`src/services/monitoring/freePort.ts`) asks the OS for a TCP port via `listen(0)`.
3. `prepareLaunch` is called with `ctx.monitor=true, ctx.monitorPort=<port>`. Each adapter routes the JMX flags through the channel that reaches **only the forked app JVM** (NOT the build-tool daemon — see "Known tricky spots" #1). `buildMonitorJvmArgs(port)` produces the standard `-Dcom.sun.management.jmxremote.*` flag list.
4. After the task starts, `MonitoringService.attach(cfg.id, pid, port)` spawns `java -jar media/agent/rcm-monitor.jar <port>`.
5. The agent retries the JMX connect for 10 s (covers the gap between launch and JMX-server bind), then emits one `metrics` JSON line per second (`MemoryMXBean`/`OperatingSystemMXBean`/`ThreadMXBean`/`GarbageCollectorMXBean`) and one `histogram` line every 10 s (parsed from `gcClassHistogram`).
6. `MonitoringService` parses each line, appends to a 60-tick ring buffer, fires `onChanged(configId)`.
7. `RunConfigTreeProvider` renders a 16-character sparkline (4-second buckets, anchored to newest tick so freshest data is rightmost) + heap MB + CPU% in `TreeItem.description`. Adds `:monitored` suffix to `contextValue`.
8. `MonitorPanel` (singleton per cfg.id) listens to the same `onChanged` and posts the latest tick + histogram to its webview. The webview (`webview/src/MonitorView.tsx`) renders an SVG chart, analytics grid, and a package-prefix histogram tree (filterable, sortable, expandable; pause/resume sends `histogram-pause`/`histogram-resume` to the agent's stdin).

**Heap dumps**: Save Heap Dump button → save dialog → `MonitoringService.saveHeapDump(id, path)` writes `dump <path>\n` to the agent's stdin. Agent calls `HotSpotDiagnosticMXBean.dumpHeap(path, true)`. On completion, agent emits `dumpComplete` JSON; the panel offers "Reveal in Explorer".

**Wire format** — one JSON document per line on agent stdout. Types: `metrics`, `histogram`, `dumpComplete`, `error`. Defined in `src/services/monitoring/AgentMessage.ts`; mirrored in `monitor-agent/.../Monitor.java`. Changes must be reflected in both.

**CSP**: `MonitorPanel.html()` uses a per-load nonce on the bundle script tag; values flow to the webview via `data-*` attributes on `#root` (no inline script). Matches `EditorPanel`. Do NOT introduce `'unsafe-inline'`.

**ContextValue suffix gotcha**: When `:monitored` is appended to a tree row's contextValue (e.g. `configRunning:gradle:grouped:monitored`), every existing `view/item/context` `when`-clause regex must tolerate `(:monitored)?` before the `$` anchor. When adding a new config type with its own tool suffix, add `|<suffix>` to every alternation `(maven|gradle|npm|python|go)` in `package.json` (15 patterns total as of v0.7.6). If you add a new menu entry on a config row, end your regex with `(:(maven|gradle|npm|python|go))?(:grouped)?(:monitored)?$`.

**Rebuilding the agent jar**: `cd monitor-agent && mvn package -q && cp target/rcm-monitor.jar ../media/agent/rcm-monitor.jar`. The committed jar is what ships; rebuild only when `Monitor.java` changes.

**Node (npm) monitoring** (2026-06-26): Separate, parallel stack to the JVM/JMX one (the JVM path is untouched). An in-process agent `media/agent/rcm-node-agent.cjs` (dependency-free, Node builtins only) is injected via `NODE_OPTIONS=--require` and streams NDJSON (`src/services/monitoring/NodeAgentMessage.ts`) over a localhost TCP socket the extension listens on. `NodeMonitoringService` owns the shared server + per-config ring buffer (mirrors `MonitoringService`'s API: `onChanged`/`state`/`detach`/`dispose`, plus `listenPort()`/`agentPath`/`expect()`/`saveHeapSnapshot()`). Routing: `ExecutionService.run` branches npm→nodeMonitoring (env injected by `NpmAdapter.prepareLaunch` via `buildNodeMonitorEnv`); npm debug-launch injects the same env in `DebugService.getDebugConfig` path. Menus gated on `:npm` (offered on ALL npm, no `:monitorable` token). Webview: `MonitorPanel` sends `data-runtime`; `main.tsx` renders `NodeMonitorView.tsx` (tabs: Memory / Event loop / Runtime — no Java metrics). Tree row shows `<rss> MB · <cpu>%` text (no sparkline). Multi-process: first-connection-wins by `RCM_MONITOR_ID`. The `.cjs` ships as-is (no build).

## Recovery

`src/recovery/buildRecoveredConfig.ts` — best-effort extractor that turns an `InvalidConfigEntry.rawText` into a `Partial<RunConfig>` for editor pre-population. Never throws.

## UI

**RunConfigTreeProvider** — renders 5 kinds of nodes: `folder`, `typeGroup` (only when >1 config of a type in a folder), `config`, `invalid`, plus dependency rows beneath orchestrated configs. A config has 6 visual states, precedence top-to-bottom:
- `preparing` — blue `sync~spin`, description `Preparing…`.
- `rebuilding` — yellow `sync~spin`, description `Rebuilding…`. Dev servers (Angular, Vite, CRA, webpack, Next.js) trigger this on file-watch.
- `failed` — red `error` icon.
- `running && !started` — `loading~spin`, description `Starting…`.
- `started` — green `pass-filled`. **When monitoring**, description appends sparkline + heap MB + CPU%.
- else — **brand SVG** from `media/icons/` via `iconForConfig`. npm sub-types sniff `angular.json` / `vite.config` / `next.config` / `svelte.config` / dependencies / `ng serve` / `next dev` / `vite` / etc. Python sub-types similarly (django/flask/fastapi).

Tree emits `runConfig.edit` on item click → single-click opens the editor. Tooltip uses `buildCommandPreview`. **`contextValue` shape**: `${baseContextValue}${toolSuffix}${groupSuffix}${monitoredSuffix}` — e.g. `configIdle:maven:grouped:monitored`. Tool suffixes: `:maven`, `:gradle` (JVM build tools), `:npm`, `:python`, `:go`. Menu when-clauses must tolerate the `:monitored` tail (see JVM monitoring section). When adding a new menu entry on a config row, end your regex with `(:(maven|gradle|npm|python|go))?(:grouped)?(:monitored)?$`.

**EditorPanel** — singleton webview. `retainContextWhenHidden: true`. Streaming detection runs inside `openForCreate`; each `StreamingPatch` produces a `schemaUpdate` + `configPatch` pair. Edit mode also runs streaming detection (so framework/Node detection refreshes on edit).

**MonitorPanel** — singleton per config id. CSP uses nonce + data attributes (no inline script). Subscription to `monitoring.onChanged` is disposed on `panel.onDidDispose`.

**PortViewerPanel** — separate webview that scans workspace for binding sockets and lists them.

**NativeRunnerTreeProvider** — secondary tree showing `launch.json` + `tasks.json` entries. Used for `dependsOn` cross-references.

## Webview

**App.tsx** — owns form state, talks to extension via `acquireVsCodeApi().postMessage`. `mergeBlanks` merges patches only into undefined/null/"" fields. `classpathLooksLikeHint()` triggers spring-boot recompute when the field still holds the placeholder.

**ConfigForm.tsx** — renders `common`, `typeSpecific`, `advanced` sections. Command preview at top via shared `buildCommandPreview`.

**MonitorView.tsx** — JVM monitor body. Time-window selector (60s/5min/30min) drives a webview-side ring buffer (the agent only buffers 60 s server-side; longer windows are extension-fed). Histogram tree groups via `groupByPackage` (also pure, also imported from `src/services/monitoring/`).

**HelpPanel.tsx** — markdown-subset renderer used by inline help. Note: the form's "info banner" field kind (used for the npm framework "Detected: …" badge) renders **plain text only** (no markdown). Don't put `**bold**` there.

**formSchema.ts** — `FormField` kinds: `text`, `textarea`, `number`, `select`, `selectOrCustom`, `csvChecklist`, `boolean`, `kv`, `folderPath`, `info` (banner). Each may have `help`, `examples`, `dependsOn` (visibility), `action` (button), `inspectable`.

**main.tsx** — routes mount: reads `root.dataset.view`. `'monitor'` → `<MonitorView>`; otherwise `<App>` (editor). Other panels (HelpPanel, BuildToolSettingsPanel, PortViewerPanel) currently each have their own panel host; check before assuming a single router.

## Variable resolution (`src/utils/resolveVars.ts`)

Tokens: `${VAR}`, `${env:VAR}`, `${workspaceFolder}`, `${userHome}`, `${cwd}`, `${projectPath}`. Unresolved → empty string at runtime; on-disk config never rewritten. `makeRunContext({ workspaceFolder, cwd })` builds the context.

## Testing

**`__mocks__/vscode.ts`** — minimal mock: `Uri`, `EventEmitter`, `workspace.fs` (in-memory `Map<string, Uint8Array>`), file watchers, `tasks.executeTask` with start/end emitters, `debug.startDebugging` with session emitters, `window.show*` as `jest.fn()`. Tests seed via `__writeFs(path, data)` and fire watcher events via `__watchers`.

**jest.config.js** — `ts-jest` preset; `moduleNameMapper` maps `vscode` → mock. `src/extension.ts` excluded from coverage (activation wiring).

**Test count**: 930+ across 85 files. Includes `MonitoringService` lifecycle, `buildMonitorJvmArgs`, `freePort`, `parseClassHistogram`, `ExecutionService` Quarkus monitoring delay (3 tests), plus per-adapter tests. Start with `ExecutionService.test.ts` or `RunConfigService.test.ts` as templates. Keep fixtures inline.

**`child_process` mocking**: `jest.mock('child_process')` and `cp.spawn as unknown as jest.MockedFunction<typeof cp.spawn>` in `MonitoringService.test.ts` is the canonical pattern for any service that spawns subprocesses.

## Build pipeline

- **`esbuild.config.mjs`** — bundles `src/extension.ts` to `out/extension.js` (CommonJS, Node 18, vscode external, sourcemaps on).
- **`vite.config.ts`** — bundles the webview under `media/webview/`. Output `media/webview/assets/main.js` + `main.css`.
- **tsconfig split**: `tsconfig.extension.json` for extension code, `tsconfig.webview.json` for React + DOM. `npm run typecheck` runs both with `--noEmit`.
- **Maven**: `monitor-agent/` is built once with `mvn package`; the resulting jar is committed to `media/agent/rcm-monitor.jar`. CI does NOT rebuild it (out of scope for v1).
- **Scripts**: `build` = clean + webview + extension; `watch` runs both in parallel; `package` wraps `vsce package --no-dependencies`.

## Conventions to match existing code

- **No emojis in code or commit messages** unless the user asks.
- **Comments explain *why*, not *what*** — call out hidden constraints, invariants, non-obvious tradeoffs (the port-poll removal comment is a good example).
- **Commit style**: `feat|fix|refactor(scope): one-line summary` in subject; body explains motivation. Sign with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **No auto-commits**: the user reviews and commits manually. Never run `git commit` unless explicitly asked.
- **Prefer `Edit` over `Write` for existing files.** `Write` is for new files only.
- **Constructor compatibility**: services that gain new dependencies (e.g., `ExecutionService` got `monitoring?: MonitoringService`) add the new param as the LAST optional param so existing call sites in tests + extension.ts keep compiling.
- **Plans live in `docs/superpowers/plans/`, specs in `docs/superpowers/specs/`.** Major features go through brainstorm → spec → plan → execute.

## Known tricky spots

1. **JMX port collision in build-tool modes** — `JAVA_TOOL_OPTIONS` is inherited by the build-tool daemon (Gradle/Maven JVM) AND the forked app JVM. Both try to bind the JMX port; the second one fails. Fixed for monitor flags by routing through:
   - **Spring Boot Gradle**: init script (`writeBootRunInitScript`) targeting `bootRun.jvmArgs` only.
   - **Spring Boot Maven**: `cfg.vmArgs` → `-Dspring-boot.run.jvmArguments=` (forked JVM only).
   - **Java Gradle/gradle-custom**: init script (`writeJavaExecInitScript`) targeting `JavaExec` tasks.
   - **Java Maven/maven-custom**: `JAVA_TOOL_OPTIONS` — `mvn exec:java` runs IN the Maven JVM (no fork), so it's safe.
   - **Quarkus**: `cfg.vmArgs` → `-Djvm.args=` (Quarkus plugin forwards to the forked dev JVM only).
   - **Tomcat**: `CATALINA_OPTS` — Tomcat doesn't have a separate "build" JVM.
   The same pattern applies to JDWP (debug). Don't reintroduce `JAVA_TOOL_OPTIONS` for JMX/JDWP in fork-mode build tools.
2. **Tomcat user `jmxPort` conflicts with monitor port** — when user has `typeOptions.jmxPort` set, it emits its own `-Dcom.sun.management.jmxremote.port=`. With "Run with Monitoring", both compete. Known v2 issue; needs precedence.
3. **`JAVA_TOOL_OPTIONS` escape semantics** — spaces inside Logback patterns are tokenized by the JVM as option separators. Spring Boot's `prepareLaunch` uses U+00A0 (non-breaking space) as internal whitespace, real spaces only between JVM options.
4. **Gradle multi-module** — config's `projectPath` may not equal the Gradle root. `findBuildRoot` walks up to `settings.gradle[.kts]`; `gradleModulePrefix` computes `:api`, `:tardis-api`, etc. for task scoping. Never assume `projectPath === buildRoot`.
5. **Java debugger's "Resolving main class" hang** — fixed by `projectName: ''`, `modulePaths: []`, `sourcePaths: []`, `shortenCommandLine: 'auto'` in the debug config.
6. **Tomcat JDWP bind address** — must be `0.0.0.0:<port>`, not `localhost`, or VS Code can't attach from host when Tomcat runs in WSL/containers.
7. **`EditorPanel.sanitize()` drops unknown fields** — new `typeOptions` fields not persisting on save almost always means sanitize wasn't updated.
8. **Invalid entries** — show wrench (not gear). `Fix` opens editor with `buildRecoveredConfig` output. Deleting removes from store's invalid list; file updated on next `save()`.
9. **Shell-init banner race** — `createTerminal + sendText` is interceptable by shell startup banners (`* start-stop-daemon: wsl-vpnkit is already running`). Use `runInTerminal.ts` (Task + non-interactive `bash -c`) for one-shot helper commands.
10. **Info banner kind doesn't render markdown** — only `HelpPanel` does. `**bold**` in an `info` field would show literal `**`.
11. **DependencyOrchestrator delay-skip** — when a dependency is already running before orchestration starts, the configured `delaySeconds` is skipped (the timer is meant to give a freshly-started service time to come up; it's pointless for already-up services). See `isStepAlreadyRunning(step)`.
12. **Pid is best-effort for monitoring** — `RunTerminal.childPid` returns `undefined` for ShellExecution paths (Quarkus interactive shell, custom-command interactive). MonitoringService stores 0 in that case. Agent connects via JMX so this is non-fatal; just don't treat the stored pid as authoritative for liveness.
13. **Go debug: `program` must be an absolute path** — `getDebugConfig` for Go must resolve `program` to an absolute filesystem path (not a relative path like `./cmd/server` and never `${workspaceFolder}`). `${workspaceFolder}` is a VS Code variable that resolves to the workspace root, not the project subdirectory. Delve then invokes `go build .` in the wrong directory and produces "no Go files in …". Use `path.resolve(projectRoot, packagePath)` instead.
14. **`validateBuildPath` is Maven/Gradle only** — the `folderPath` field kind has an optional `validateBuildPath: 'maven'|'gradle'|'either'` property that triggers a `pom.xml`/`build.gradle` existence check on blur. Never set this on a Go (or any non-JVM) `projectPath` field — the check fires and produces a confusing "No Maven or Gradle project found" error.
15. **Go extension detection is synchronous** — `vscode.extensions.getExtension('golang.go')` can be called synchronously inside `detectStreaming` (which runs in the extension host). Thread the boolean through context as `goExtensionMissing` and use it in `getFormSchema` to conditionally spread the info banner field. This pattern — detect in streaming, render in schema — is the right place for any extension-presence check.
16. **Quarkus monitoring delay** — `ExecutionService` has a `QUARKUS_MONITOR_ATTACH_DELAY_MS = 30_000` constant. Quarkus uses `ShellExecution` (interactive PTY), so the forked JVM (where JMX flags land via `-Djvm.args=`) starts 15–60 s after `executeTask`. The delay is guarded by an execution token (`currentEntry?.execution === execToken`) so a rapid stop+restart within the window doesn't attach the old monitoring entry to the new run.
17. **`STREAMING_PENDING_FIELDS` is shared across all adapter types** — `extension.ts` maintains a single list of field keys that show spinners on first form paint. This list contains JVM-specific keys (`typeOptions.buildRoot`, `typeOptions.jdkPath`, etc.). When adding a new adapter, emit `resolved: ['typeOptions.buildRoot']` (and any other JVM keys that appear in your form) immediately in `detectStreaming` — even if the field has no detected value — so the spinner clears. For Go, `typeOptions.buildRoot` is cleared with an immediate emit at the start of `detectStreaming`.

## Recent architectural decisions (for context, not to undo)

- **JVM memory monitoring** (2026-05-12) — bundled JMX agent jar, sparkline in tree, MonitorPanel webview with chart + histogram + heap dump. JMX flags routed through fork-only channels per adapter (init scripts for Gradle, `-Dspring-boot.run.jvmArguments` for Spring Boot Maven, `-Djvm.args=` for Quarkus). See "JVM monitoring" section.
- **Python adapter** — sixth runtime type. Five smart launch modes with framework awareness (FastAPI/Flask/Django/Celery/Starlette). debugpy-based debug. pip pre-flight install offer.
- **npm framework awareness** — 12 frameworks detected (Next.js, Nuxt, SvelteKit, Astro, Remix, Gatsby, Angular, Storybook, Svelte, Vue, React/CRA, Vite). "Detected: X" form badge, framework-default port pre-fill. node_modules pre-flight install.
- **Node selection** — interpreter dropdown like JDK selection. Auto-detects `nvm`/`volta`/`asdf`/`fnm`/`n` pools and standard install locations. Cloud-icon installer routes through `nvm install` when nvm is present.
- **Group commands** — Run All Sequentially / Parallel, Debug All Sequentially / Parallel, Stop All on tree folders. Recursive. `GroupService` owns the orchestration.
- **DependencyOrchestrator** — `dependsOn` graph walking with per-edge delays. Cycle detection. Three ref kinds: `rcm:`, `launch:`, `task:`. Skip delay when dep was already running.
- **Docker + http-request types** — both bypass the spawn pipeline; Docker delegates to `DockerService`, http-request to `HttpRequestRunner`.
- **Maven/Gradle Goal/Task adapters** — saved one-click launchers. `supportsDebug=false`. Auto-create skips them.
- **Java Application adapter** — five launch modes (`maven`, `gradle`, `maven-custom`, `gradle-custom`, `java-main`). vmArgs only work in `java-main` and gradle modes (via init script). `findMainClasses` shared with Spring Boot via `java-shared/`.
- **Quarkus adapter** — two launch modes; `-Ddebug=<port>` for JDWP; single profile via `-Dquarkus.profile`. No rebuild watcher (Live Coding built in).
- **Streaming detection** — replaces blocking detect for any probe >100ms. Editor opens instantly; form patches as probes finish. Edit-mode also runs streaming so framework detection refreshes.
- **Port-poll readiness removed** — regex-only. Don't re-add port polling.
- **Prettifier** — ANSI + OSC 8 hyperlinks. Raw text feeds the scanner.
- **Auto Create + Stop All** — title-bar buttons. Auto-create priority: `spring-boot > quarkus > tomcat > java > python > npm`. Go is not in auto-create (requires go.mod detection but no universal entry-point — user picks the package).
- **Go adapter** (2026-05-21) — five launch modes, streaming Go install detection (gvm/asdf/mise/goenv/Homebrew/PATH), main-package scanning, Delve DAP debug via `golang.go` extension, `go mod tidy/download` right-click actions, race detector toggle, tool flags via vmArgs. All icons converted to monochrome (`#CCCCCC` dark / `#3C3C3C` light) via updated `scripts/generate-icons.mjs`. Monitoring tooltip descriptions added across all MonitorView sub-components. Quarkus monitoring timing bug fixed (30 s delayed attach).
- **Monitor UI tooltips** (2026-05-21) — all metric labels in `MonitorView.tsx` and sub-components (`PoolsBars`, `StateDonut`, `MemoryTab`, `JvmInternalsTab`, `ThreadsTab`, `AppTab`, `GcTimeline`) now carry `title` attributes explaining what each metric means, including pool categories, thread states, latency percentiles, JIT/OS fields, and GC timeline bars.
- **MCP server for AI agents** (2026-07-15) — the extension registers an MCP server (`vscode.lm.registerMcpServerDefinitionProvider` + `contributes.mcpServerDefinitionProviders`, id `runConfigManager`) so Copilot auto-lists it. Requires `engines.vscode ^1.101.0` (the API's minimum). The server is a **separate stdio process** (`src/mcp/server.ts` → second esbuild bundle `out/mcp-server.js`, SDK bundled in; spawned via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`). It has NO `vscode` access — every tool/resource forwards over a **loopback TCP socket** (token-authed, `127.0.0.1:0`) to `McpBridgeServer` in the ext host, which dispatches to `RunConfigService`/`ExecutionService`/`DebugService` via `createBridgeServices` (`src/mcp/bridgeServices.ts`). Same transport shape as `NodeMonitoringService`. **Resources**: `runconfig://schema` (JSON Schema from Zod via `zod-to-json-schema`), `runconfig://guide` (hand-authored `media/mcp/run-config-guide.md` — ships under `media/`, NOT `docs/`, which `.vscodeignore` excludes), `runconfig://current`. **Tools**: read-only `list/get/validate_run_config` (`readOnlyHint`, no confirm); mutating/lifecycle `create/update/delete_run_config` + `run/debug/stop_config` (VS Code prompts to confirm). Multi-root: `create_run_config` needs `workspaceFolder` when >1 folder. Gated by setting `runConfigManager.mcp.enabled` (default true). `McpStdioServerDefinition` ctor is **positional** `(label, command, args, env, version)`. Spec/plan in `docs/superpowers/{specs,plans}/2026-07-15-mcp-server*`.

## When you start a new task

1. Read the user's request carefully; if it's a bug report, use `superpowers:systematic-debugging` rather than guessing.
2. Check `git log --oneline -20` for recent context.
3. Reproduce the issue in a test if possible — Jest is fast (~3s for 930 tests).
4. Make changes; run `npm run typecheck && npm test` before claiming done; run `npm run build` before declaring shippable.
5. Keep diffs minimal. No drive-by refactors unless asked.
6. **Never commit unless asked.** Plans say "DO NOT COMMIT"; this is a session-wide directive from the user.
7. For new features: brainstorm → spec (`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) → execute via `subagent-driven-development` (recommended) or inline. Plans should be self-contained: any task in the plan must be doable by a fresh subagent that hasn't seen the conversation.
