# Run Configuration Manager — Guide for AI Agents

Run configurations live in `.vscode/run.json`. Each configuration is an object
with common base fields plus a `type` discriminator and a `typeOptions` object
whose shape depends on `type`.

**Workflow:** call `validate_run_config` on your candidate object *before*
`create_run_config` or `update_run_config`. Read `runconfig://schema` for the
exact machine-readable contract and `runconfig://current` for what already
exists. This guide adds the "why/when" that the schema cannot express.

Variable tokens usable in string fields: `${workspaceFolder}`, `${userHome}`,
`${cwd}`, `${projectPath}`, `${env:VAR}`, `${VAR}`. Unresolved tokens expand to
an empty string at run time; the on-disk file keeps the tokens.

## Common base fields (every type)

- `name` (string, required, non-empty) — display name in the tree.
- `projectPath` (string) — the directory the command runs in.
- `workspaceFolder` (string) — the workspace folder path this config belongs to
  (usually `${workspaceFolder}`).
- `env` (object string→string, required, may be `{}`) — extra environment vars.
- `programArgs` (string, required, may be `""`) — arguments passed to the program.
- `vmArgs` (string, required, may be `""`) — JVM/tool flags; repurposed per type
  (e.g. Go tool flags like `-ldflags`).
- `port` (number, optional) — primary port the app serves on.
- `envFiles` (string[], optional) — dotenv files loaded fresh on each run.
- `dependsOn` (array, optional) — each item `{ ref, delaySeconds? }`. `ref` is
  `rcm:<id>` (another config), `launch:<name>` (launch.json), or
  `task:<source>::<name>` (tasks.json). `delaySeconds` ≤ 600.
- `group` (string, optional) — slash-separated tree folder, e.g. `Backend/API`.
  No leading/trailing/double slash; segments non-empty.

`id` is a UUID assigned by `create_run_config`. **Do not supply `id` on create.**
For `update_run_config`, include the existing `id`.

`programArgs`, `vmArgs`, and `env` are required by the schema — always include
them (use `""` / `{}` when empty).

---

## Type: npm

Runs a `package.json` script. Use for Node backends and frontend dev servers.

`typeOptions`:
- `scriptName` (string, required, non-empty) — the script key in `package.json`.
- `packageManager` (`npm` | `yarn` | `pnpm`, required).
- `nodePath` (string, default `""`) — selected Node install root; `""` = node
  from PATH.

```json
{
  "name": "Web Dev Server",
  "projectPath": "${workspaceFolder}/web",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "npm",
  "typeOptions": { "scriptName": "dev", "packageManager": "npm", "nodePath": "" }
}
```

---

## Type: python

Runs Python in one of several modes.

`typeOptions`:
- `launchMode` (`script` | `module` | `framework` | `pytest` | `custom`, required).
- `pythonPath` (string, default `""`) — interpreter; `""` = python from PATH.
- `scriptPath` (string) — used when `launchMode = script` (path to `.py`).
- `moduleName` (string) — used when `launchMode = module` (`python -m <module>`).
- `framework` (one of `""`, `django`, `fastapi`, `flask`, `uvicorn`, `gunicorn`,
  `celery`, `typer`, `starlette`, `click`) — used when `launchMode = framework`.
- `frameworkCommand` (string) — the concrete command/target for the framework.
- `pytestArgs` (string) — used when `launchMode = pytest`.
- `customArgs` (string) — used when `launchMode = custom`.
- `buildRoot` (string, default `""`).

```json
{
  "name": "API (uvicorn)",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "python",
  "typeOptions": {
    "launchMode": "framework", "framework": "fastapi",
    "frameworkCommand": "app.main:app", "pythonPath": "",
    "scriptPath": "", "moduleName": "", "pytestArgs": "",
    "customArgs": "", "buildRoot": ""
  }
}
```

---

## Type: spring-boot

A Spring Boot application.

`typeOptions`:
- `launchMode` (`maven` | `gradle` | `java-main`, required).
- `buildTool` (`maven` | `gradle`, required).
- `gradleCommand` (`./gradlew` | `gradle`, required).
- `profiles` (string) — comma-separated Spring profiles.
- `mainClass` (string) — **required for `java-main`**.
- `classpath` (string) — **required for `java-main`**.
- `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot` (strings).
- `debugPort` (number 1–65535, optional).
- `rebuildOnSave`, `colorOutput`, `recomputeClasspathOnRun` (boolean, optional).

```json
{
  "name": "Spring API",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "spring-boot",
  "typeOptions": {
    "launchMode": "maven", "buildTool": "maven", "gradleCommand": "./gradlew",
    "profiles": "dev", "mainClass": "", "classpath": "",
    "jdkPath": "", "module": "", "gradlePath": "", "mavenPath": "", "buildRoot": ""
  }
}
```

---

## Type: java

A plain Java application.

`typeOptions`:
- `launchMode` (`maven` | `gradle` | `java-main` | `maven-custom` | `gradle-custom`, required).
- `buildTool` (`maven` | `gradle`, required).
- `gradleCommand` (`./gradlew` | `gradle`, required).
- `mainClass` (string) — **required for `maven` and `java-main`**.
- `classpath` (string) — **required for `java-main`**.
- `customArgs` (string) — **required for `maven-custom` and `gradle-custom`** (the
  custom goal/task).
- `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot` (strings).
- `debugPort` (number, optional), `colorOutput` (boolean, optional).

```json
{
  "name": "Java Main",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "java",
  "typeOptions": {
    "launchMode": "java-main", "buildTool": "maven", "gradleCommand": "./gradlew",
    "mainClass": "com.example.Main", "classpath": "target/classes",
    "customArgs": "", "jdkPath": "", "module": "",
    "gradlePath": "", "mavenPath": "", "buildRoot": ""
  }
}
```

---

## Type: quarkus

A Quarkus application (dev mode). No `java-main` mode.

`typeOptions`:
- `launchMode` (`maven` | `gradle`, required).
- `buildTool` (`maven` | `gradle`, required).
- `gradleCommand` (`./gradlew` | `gradle`, required).
- `profile` (string) — a single Quarkus profile (not comma-separated).
- `jdkPath`, `module`, `gradlePath`, `mavenPath`, `buildRoot` (strings).
- `debugPort` (number, optional), `colorOutput` (boolean, optional).

```json
{
  "name": "Quarkus Dev",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "quarkus",
  "typeOptions": {
    "launchMode": "maven", "buildTool": "maven", "gradleCommand": "./gradlew",
    "profile": "dev", "jdkPath": "", "module": "",
    "gradlePath": "", "mavenPath": "", "buildRoot": ""
  }
}
```

---

## Type: tomcat

Deploys a WAR (or exploded dir) into a per-config Tomcat instance.

`typeOptions`:
- `tomcatHome` (string, **required**) — Tomcat installation directory.
- `jdkPath` (string).
- `httpPort` (number 1–65535, **required**).
- `httpsPort`, `ajpPort`, `jmxPort`, `debugPort` (number, optional).
- `buildProjectPath`, `buildRoot` (strings).
- `buildTool` (`gradle` | `maven` | `none`, required).
- `gradleCommand` (`./gradlew` | `gradle`, required).
- `gradlePath`, `mavenPath` (strings).
- `artifactPath` (string, **required**) — WAR file or exploded directory.
- `artifactKind` (`war` | `exploded`, required).
- `applicationContext`, `profiles`, `vmOptions` (strings).
- `reloadable`, `rebuildOnSave` (boolean, required); `colorOutput` (boolean, optional).

```json
{
  "name": "Tomcat App",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "tomcat",
  "typeOptions": {
    "tomcatHome": "/opt/tomcat", "jdkPath": "", "httpPort": 8080,
    "buildProjectPath": "", "buildRoot": "", "buildTool": "maven",
    "gradleCommand": "./gradlew", "gradlePath": "", "mavenPath": "",
    "artifactPath": "target/app.war", "artifactKind": "war",
    "applicationContext": "/app", "profiles": "", "vmOptions": "",
    "reloadable": true, "rebuildOnSave": false
  }
}
```

---

## Type: maven-goal

A saved one-click Maven launcher. `supportsDebug = false`.

`typeOptions`:
- `goal` (string, **required**, non-empty) — free-form phases/goals, e.g.
  `clean install -DskipTests`.
- `jdkPath`, `mavenPath`, `buildRoot` (strings); `colorOutput` (boolean, optional).

```json
{
  "name": "Maven Install",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "maven-goal",
  "typeOptions": { "goal": "clean install -DskipTests", "jdkPath": "", "mavenPath": "", "buildRoot": "" }
}
```

---

## Type: gradle-task

A saved one-click Gradle launcher. `supportsDebug = false`.

`typeOptions`:
- `task` (string, **required**, non-empty) — free-form task names, e.g. `build`.
- `gradleCommand` (`./gradlew` | `gradle`, required).
- `jdkPath`, `gradlePath`, `buildRoot` (strings); `colorOutput` (boolean, optional).

```json
{
  "name": "Gradle Build",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "gradle-task",
  "typeOptions": { "task": "build", "gradleCommand": "./gradlew", "jdkPath": "", "gradlePath": "", "buildRoot": "" }
}
```

---

## Type: go

A Go program. `supportsDebug = true` (needs the `golang.go` extension). `vmArgs`
holds Go tool flags (`-ldflags`, `-tags`, `-trimpath`).

`typeOptions`:
- `launchMode` (`run` | `test` | `build` | `install` | `custom`, required).
- `goPath` (string, default `""`) — Go install root; `""` = go from PATH.
- `packagePath` (string) — package for `run`/`build`/`install`.
- `testArgs` (string) — for `test`.
- `outputPath` (string) — `-o` for `build`.
- `customArgs` (string) — verbatim args for `custom`.
- `buildRoot` (string) — module root if different from `projectPath`.
- `race`, `colorOutput` (boolean, optional).

```json
{
  "name": "Go Server",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "go",
  "typeOptions": {
    "launchMode": "run", "goPath": "", "packagePath": "./cmd/server",
    "testArgs": "", "outputPath": "", "customArgs": "", "buildRoot": ""
  }
}
```

---

## Type: docker

Starts an existing Docker container. Runs `docker start <id>`.

`typeOptions`:
- `containerId` (string, **required**, non-empty).
- `containerName` (string, optional).

```json
{
  "name": "Postgres",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "docker",
  "typeOptions": { "containerId": "abc123", "containerName": "postgres" }
}
```

---

## Type: custom-command

An arbitrary shell command. `supportsDebug = false`.

`typeOptions`:
- `command` (string, **required**, non-empty).
- `cwd` (string).
- `shell` (`default` | `bash` | `sh` | `zsh` | `pwsh` | `cmd`, required).
- `interactive` (boolean, required) — `true` gives the process working stdin.
- `colorOutput` (boolean, optional).

```json
{
  "name": "Run Migrations",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "custom-command",
  "typeOptions": { "command": "./scripts/migrate.sh", "cwd": "", "shell": "bash", "interactive": false }
}
```

---

## Type: http-request

A single HTTP request (driven by an in-process runner, not a spawned process).

`typeOptions` (key fields; see `runconfig://schema` for the full shape):
- `url` (string, **required**, non-empty).
- `method` (`GET` | `POST` | `PUT` | `PATCH` | `DELETE` | `HEAD` | `OPTIONS` | `CUSTOM`, required).
  `customMethod` required when `method = CUSTOM`.
- `queryParams`, `headers`, `bodyForm` — arrays of `{ key, value, enabled }`.
- `bodyKind` (`none` | `json` | `form-urlencoded` | `raw` | `xml`), `bodyRaw` (string).
- `authKind` (`none` | `basic` | `bearer` | `apiKey` | `oauth-client-credentials`)
  plus the matching auth object.
- `timeoutMs` (number 1–600000), `followRedirects`, `verifyTls` (boolean),
  `assertScript` (string), `responseSink` (`output` | `panel`).

```json
{
  "name": "Health Check",
  "projectPath": "${workspaceFolder}",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "http-request",
  "typeOptions": {
    "url": "http://localhost:8080/health", "method": "GET",
    "queryParams": [], "headers": [], "bodyKind": "none", "bodyRaw": "",
    "bodyForm": [], "authKind": "none",
    "authBasic": { "username": "", "password": "" },
    "authBearer": { "token": "" },
    "authApiKey": { "name": "", "value": "", "location": "header" },
    "authOAuthClientCredentials": { "tokenUrl": "", "clientId": "", "clientSecret": "", "scope": "", "clientAuth": "header" },
    "timeoutMs": 30000, "followRedirects": true, "verifyTls": true,
    "assertScript": "", "responseSink": "output"
  }
}
```

## Profiling a running application

The extension can attach runtime monitoring to a run and expose the raw
telemetry. Monitorable types: **JVM** — `spring-boot`, `quarkus`, `java`,
`tomcat`; **Node** — `npm`. Other types ignore the `monitor` flag.

Workflow:

1. `list_run_configs` — pick a monitorable config.
2. `run_config` with `monitor: true` (or `debug_config` with `monitor: true`).
   The response's `monitoring` field is `requested` when the runtime supports
   monitoring, or `unsupported` otherwise.
3. Poll `get_run_status(id)` until `started: true` (or `failed: true`). Fields:
   `running`, `started`, `failed`, `preparing`, `monitored`, `runtime`.
4. Poll `get_monitoring_snapshot(id)` to watch the app over time. With no
   `sections` it returns just `{ runtime, status, latest }` (the newest metrics
   tick) — cheap to poll. Add `sections` to drill in:
   - JVM: `metrics` (full ~60s ring buffer), `histogram` (top classes by retained
     bytes), `threads` (state counts, hottest threads with stack snippets,
     deadlock info), `gc` (recent GC events), `actuator` (Spring Boot
     health / HTTP p50-p99 / top endpoints / loggers), `runtime` (JVM/vendor/args;
     returned under key `runtimeInfo`).
   - Node: `metrics` (ring buffer incl. event-loop lag p50/p99), `heapSpaces`,
     `gc`, `hello` (process/version info).
   The payload is raw, runtime-tagged data. Interpret trends yourself: rising
   `heapUsed`/`rss` across ticks suggests a leak; sustained high `cpuLoad`/
   `cpuPercent` or `loopLagP99` suggests a hot path; growing `gc` time suggests
   memory pressure; a non-null `threads.deadlock` is critical.
5. For a JVM hot thread, take its `id` from the `threads` section and call
   `get_thread_dump(id, tid)` for the full stack. Thread dumps are JVM-only.
6. `stop_config(id)` when finished.

If `get_monitoring_snapshot` errors with "No monitoring data", either the run
was not started with `monitor: true`, the type is not monitorable, or the agent
has not connected yet — poll `get_run_status` and retry.
