# MCP Profiling Support — Design

**Date:** 2026-07-15
**Status:** Approved (design)
**Builds on:** `2026-07-15-mcp-server-design.md` (the base MCP server)

## Problem

The extension already collects rich runtime telemetry for monitored runs — JVM via
the bundled JMX agent (`MonitoringService`) and Node via the in-process agent
(`NodeMonitoringService`) — but that data is only surfaced to webviews
(`MonitorPanel`). The MCP server exposes config CRUD + run/debug/stop, yet an AI
agent connected over MCP cannot:

1. Start a run **with monitoring attached**.
2. Learn whether a run has **started / failed / is still coming up**.
3. **Read** any of the collected telemetry.
4. **Drill into** a specific hot thread.

Goal: let an AI agent profile an application autonomously — run it with monitoring,
watch for critical behaviour over time, and identify spots of interest — by exposing
the *raw* telemetry through MCP and letting the agent do the analysis.

## Key decisions

- **Extension exposes raw data; the agent analyzes.** No server-side anomaly
  detection. MCP tools project the raw monitoring state; the LLM reasons over it.
- **Stateless snapshot tool, agent polls.** No timed/accumulating session. The agent
  calls a snapshot tool repeatedly and decides its own cadence and stopping point.
- **`monitor` flag on the existing run/debug tools.** No separate monitored-run
  tools. Mirrors the internal `exec.run({ monitor })` / `dbg.debug({ monitor })` opts,
  both of which already exist.
- **Both JVM and Node from the start.** One snapshot tool; the payload is
  **runtime-tagged raw passthrough** (`{ runtime: 'jvm' | 'node', ... }`) — no
  normalization, full fidelity.
- **Section selector with a cheap default.** The snapshot returns only the latest
  tick + status by default; the agent opts into expensive sections (histogram,
  threads, actuator, …) explicitly.
- **Thread dump is the only active drill-in command** (JVM only). No heap dumps, no
  log-level control over MCP in this iteration.
- **Add `get_run_status`** so the agent knows when the app is up before profiling.

## Intended agent workflow

Documented in the guide resource (`media/mcp/run-config-guide.md`) so the agent
discovers the sequence:

1. `list_run_configs` → find a monitorable config.
   - JVM: `spring-boot` / `quarkus` / `java` / `tomcat` with a `maven` | `gradle`
     build tool.
   - Node: `npm`.
2. `run_config(id, monitor: true)` — or `debug_config(id, monitor: true)`.
3. Poll `get_run_status(id)` until `started: true` (or `failed: true`).
4. Poll `get_monitoring_snapshot(id)` (cheap default) to watch trends; request
   `sections` to drill in when something looks off.
5. From the `threads` section, pick a hot thread id and call
   `get_thread_dump(id, tid)` for its full stack.
6. `stop_config(id)` when done.

## Tool surface

### Changed tools

| Tool | Change |
|------|--------|
| `run_config` | add optional `monitor: boolean` (default `false`). Still mutating (confirm prompt). |
| `debug_config` | add optional `monitor: boolean` (default `false`). Still mutating (confirm prompt). |

The `monitor` flag rides on the existing tools and is threaded straight through to
`exec.run(cfg, folder, { monitor })` / `dbg.debug(cfg, folder, { monitor })`. Both
underlying services already accept an optional `{ monitor?: boolean }` opts object,
so no service signature changes are required.

### New tools (all `readOnlyHint: true` — no confirm prompt)

**`get_run_status(id)`** → the run state from `ExecutionService`:

```jsonc
{
  "running":   boolean,   // isRunning(id)
  "started":   boolean,   // isStarted(id)  — readiness signal observed
  "failed":    boolean,   // isFailed(id)
  "preparing": boolean,   // isPreparing(id)
  "monitored": boolean,   // monitoring.state(id) || nodeMonitoring.state(id) present
  "runtime":   "jvm" | "node" | null   // derived from cfg.type; null if neither
}
```

**`get_monitoring_snapshot(id, sections?)`** → runtime-tagged raw passthrough:

```jsonc
{
  "runtime": "jvm" | "node",
  "status":  "connecting" | "live" | "lost",
  "latest":  <most-recent metrics tick> | null,   // null before first tick
  // ...only the sections the caller requested, verbatim from the service state
}
```

- `sections?: string[]` — optional.
  - **JVM sections:** `metrics` | `histogram` | `threads` | `gc` | `actuator` | `runtime`
  - **Node sections:** `metrics` | `heapSpaces` | `gc` | `hello`
- **Default (no sections):** `{ runtime, status, latest }` only — cheap, safe to poll.
- **`metrics` section:** returns the full ring buffer (up to 60 ticks / ~60 s).
- **Other sections:** returned verbatim from the corresponding `MonitoringState` /
  `NodeMonitoringState` field (`histogram`, `threadsDetail`, `gcEvents`, `actuator`,
  `runtime`; Node: `heapSpaces`, `gcEvents`, `hello`).
- Unknown / cross-runtime section names are ignored (e.g. asking for `histogram` on a
  Node config yields nothing for that key rather than an error).

**`get_thread_dump(id, tid)`** → JVM only:

- Delegates to `MonitoringService.requestThreadDump(id, tid)`, returning the
  `ThreadDump` (full stack). JVM-only because Node has no thread model.

## Internal wiring

### `src/mcp/protocol.ts`

- Add `BridgeMethod`s: `runStatus`, `monitoringSnapshot`, `threadDump`.
- `run` / `debug` params gain an optional `monitor` boolean (`{ id, monitor? }`).

### `src/mcp/bridgeServices.ts`

- Extend `BridgeDeps`:
  - `exec` gains the run-state getters already on `ExecutionService`:
    `isRunning`, `isStarted`, `isFailed`, `isPreparing`. `run` widens to accept the
    optional `{ monitor?: boolean }` opts (its real signature already does).
  - `dbg.debug` widens to accept the optional `{ monitor?: boolean }` opts (already
    does).
  - Add optional `monitoring` dep with a narrow structural view:
    `state(id)`, `requestThreadDump(id, tid)`.
  - Add optional `nodeMonitoring` dep with a narrow structural view: `state(id)`.
- Extend `BridgeServices` with: `runStatus(id)`, `monitoringSnapshot(id, sections?)`,
  `threadDump(id, tid)`, and thread `monitor` through `runConfig` / `debugConfig`.
- **Runtime selection:** derive from `cfg.type`. `npm` → Node; `spring-boot` |
  `quarkus` | `java` | `tomcat` → JVM. Anything else → not monitorable.

### `src/extension.ts`

- Pass the already-constructed monitoring services into the bridge:
  `createBridgeServices({ svc, store, exec, dbg, monitoring, nodeMonitoring })`.

### `src/mcp/server.ts`

- Add `monitor` to the `run_config` / `debug_config` input schemas.
- Register `get_run_status`, `get_monitoring_snapshot`, `get_thread_dump` with
  `annotations: { readOnlyHint: true }`.

## Error handling / edge cases

All errors surface as clear MCP text errors; nothing hangs.

- **`monitor: true` on an unsupported type** (`python` / `go` / `docker` /
  `http-request` / `custom-command` / `maven-goal` / `gradle-task`): the run proceeds
  normally; the response notes monitoring was not attached (unsupported runtime).
- **`get_monitoring_snapshot` when not monitored / agent not yet connected:** error
  `"No monitoring data for <id> (not running with monitoring, or agent still connecting)"`.
- **Snapshot on a live but pre-first-tick run:** `status: "connecting"`,
  `latest: null`.
- **`get_thread_dump` on a Node config:** error `"Thread dumps are JVM-only"`.
- **`get_thread_dump` with an unknown `tid` or after the agent exits:** the existing
  `requestThreadDump` promise rejects on detach/close; surfaced as an MCP error.

## Testing (Jest, in-memory `vscode` mock)

- **`test/bridgeServices.test.ts`** — extend fakes with `monitoring` /
  `nodeMonitoring` + `exec` state getters. Cover:
  - `monitor` flag threads through `run` / `debug`.
  - `runStatus` shape + `monitored` / `runtime` derivation.
  - snapshot default vs sections, for both JVM and Node.
  - JVM-only thread-dump guard (error on Node).
  - unsupported-type `monitor` note.
  - not-monitored snapshot error.
- **`test/McpBridgeServer.test.ts`** — round-trip `runStatus`,
  `monitoringSnapshot`, `threadDump` over the loopback socket.
- **`media/mcp/run-config-guide.md`** — add the profiling workflow section (so the
  agent discovers the run→status→snapshot→thread-dump sequence).

## Non-goals (YAGNI)

- No server-side anomaly detection / analysis / ranked findings.
- No heap dumps or log-level control over MCP.
- No console-output / error-line streaming over MCP.
- No timed-collect / accumulating profiling-session tool.
- No normalized cross-runtime metric shape.
