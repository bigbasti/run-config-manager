# Node (npm) Monitoring — Design

Date: 2026-06-26
Status: Approved (pending written-spec review)
Scope: Add live monitoring for `npm`/Node run configurations, as a Node-native
counterpart to the existing JVM (JMX) monitoring. Node only for now.

## Goal

Bring the Monitor view to Node apps with as much runtime insight as Node can
provide, and **adapt the view to the technology** — a monitored Node config
must never show Java-specific metrics, labels, or empty placeholders.

## Decisions (from brainstorming)

- **Data collection:** in-process agent injected via `NODE_OPTIONS=--require`,
  streaming NDJSON back to the extension over a localhost TCP socket. (Richest
  option; closest parity with the JVM JMX agent.)
- **Architecture:** Approach A — a **parallel `NodeMonitoringService`**. The
  existing JVM `MonitoringService` and its JMX wire format are left untouched.
- **In v1:** heap snapshot download; Debug-with-Monitoring; tree-row heap+CPU
  **text** (no sparkline); monitoring offered **only on server-like npm
  scripts**.
- **Out of v1:** sidebar sparkline for Node; Go/Python monitoring; fork-aware
  "pick the real worker process" heuristics; an "App"/actuator tab; class
  histogram.

## Existing architecture (the seam we build against)

- `MonitoringService.attach()` spawns `java -jar media/agent/rcm-monitor.jar
  <jmxPort>` and reads NDJSON from its stdout into a per-config ring buffer,
  firing `onChanged` (src/services/MonitoringService.ts). The ring-buffer +
  events + `MonitorPanel` webview transport is runtime-agnostic; only the data
  **source** (JMX jar) and **shape** (`MetricsTick`, pools, GC beans, class
  histogram) are JVM-specific.
- `ExecutionService.run(cfg, folder, opts)` (src/services/ExecutionService.ts):
  when `opts.monitor`, allocates `monitorPort` via `allocateFreePort()`, threads
  `monitor`/`monitorPort` into `adapter.prepareLaunch(...ctx)`, then after launch
  calls `monitoring.attach(cfg.id, pid, monitorPort, appPort)` (line ~807). JVM
  adapters inject JMX flags inside `prepareLaunch`.
- `DebugService`: npm/python/go/java-main are **launch-type** debug —
  `vscode.debug.startDebugging(folder, adapter.getDebugConfig(cfg))` — and do
  **not** flow through `ExecutionService.run`.
- `RunConfigTreeProvider` builds `contextValue` as
  `${base}${toolSuffix}${groupSuffix}${monitoredSuffix}` and, when monitoring
  state exists, appends `"<heapMb> MB  <cpu>%"` **text** to the row description
  (no sparkline graphic). `:monitored` is appended when `monitoring.state(id)`
  exists.
- Monitoring commands already exist and are runtime-neutral at the command
  layer: `runConfig.runMonitored` → `exec.run({monitor:true})`,
  `runConfig.debugMonitored` → `dbg.debug({monitor:true})`, `runConfig.openMonitor`
  → `MonitorPanel.open(config, extensionUri, monitoring)`.
- `MonitorView.tsx` hardcodes four JVM tabs (Memory / Threads / JVM internals /
  App) and consumes the JVM `MetricsTick` shape.

## Components

### 1. Node agent — `media/agent/rcm-node-agent.cjs`

- Bundled, committed, **dependency-free** CommonJS (Node builtins only: `v8`,
  `perf_hooks`, `net`, `process`). No build step.
- Loaded via `NODE_OPTIONS=--require <agent>`. No-ops unless both
  `RCM_MONITOR_PORT` and `RCM_MONITOR_ID` are present in env.
- On load: connect a `net.Socket` to `127.0.0.1:<RCM_MONITOR_PORT>` and stream
  NDJSON (one JSON document per line). The extension is the listener.
- Reads commands from the same socket (newline-delimited): `snapshot <path>`.
- Robustness: never throw into the host app. Wrap all sampling in try/catch;
  if the socket errors/closes, stop sampling silently. Use `socket.unref()` and
  `monitorEventLoopDelay` / timers with `.unref()` so the agent never keeps the
  app process alive.

**Sampling:**

- `hello` (once, on connect): `nodeVersion`, `v8Version`, `pid`, `ppid`,
  `platform`, `arch`, `execPath`, `cwd`, `argv`, `env`, `startTime`.
- `metrics` (every 1 s): `rss`, `heapTotal`, `heapUsed`, `heapLimit`
  (`v8.getHeapStatistics().heap_size_limit`), `external`, `arrayBuffers`,
  `cpuPercent` (from `process.cpuUsage()` deltas over the interval), `uptime`,
  `activeHandles`, `activeRequests`, `eventLoopLagMean/P50/P99/Max`
  (`perf_hooks.monitorEventLoopDelay`, in ms).
- `heapSpaces` (every ~5 s): `v8.getHeapSpaceStatistics()` →
  `[{ name, size, used, available }]`.
- `gc` (per event): `PerformanceObserver` on `'gc'` entries →
  `{ kind: 'minor'|'major'|'incremental'|'weakcb', durationMs }`.
- `snapshotComplete` (on request): after `v8.writeHeapSnapshot(path)`.
- `error`: best-effort error string.

**Multi-process handling (v1):** `NODE_OPTIONS=--require` propagates to child
Node processes. The extension binds the **first** connection announcing the
matching `RCM_MONITOR_ID` and politely closes later ones. Known limitation
(documented, deferred): for dev servers that fork a worker (Next.js, Vite,
Angular CLI) we may attach to the launcher rather than the worker.

### 2. Wire format — `src/services/monitoring/NodeAgentMessage.ts`

New file, parallel to `AgentMessage.ts`, shared by extension + agent + webview.
Does **not** reuse the JVM `MetricsTick` (keeps Java semantics out of Node).

```ts
export interface NodeHello { type:'hello'; t:number; id:string; pid:number; ppid:number;
  nodeVersion:string; v8Version:string; platform:string; arch:string;
  execPath:string; cwd:string; argv:string[]; env:Record<string,string>; startTime:number; }
export interface NodeMetricsTick { type:'metrics'; t:number;
  rss:number; heapTotal:number; heapUsed:number; heapLimit:number;
  external:number; arrayBuffers:number; cpuPercent:number; uptime:number;
  activeHandles:number; activeRequests:number;
  loopLagMean:number; loopLagP50:number; loopLagP99:number; loopLagMax:number; }
export interface NodeHeapSpace { name:string; size:number; used:number; available:number; }
export interface NodeHeapSpaces { type:'heapSpaces'; t:number; spaces:NodeHeapSpace[]; }
export interface NodeGcEvent { type:'gc'; t:number; kind:string; durationMs:number; }
export interface NodeSnapshotComplete { type:'snapshotComplete'; path:string; }
export interface NodeAgentError { type:'error'; message:string; }
export type NodeAgentMessage = NodeHello | NodeMetricsTick | NodeHeapSpaces
  | NodeGcEvent | NodeSnapshotComplete | NodeAgentError;
```

### 3. `NodeMonitoringService` — `src/services/NodeMonitoringService.ts`

Mirrors `MonitoringService`'s public surface so the panel/tree treat both
uniformly: `onChanged`, `state(configId)`, `detach(configId)`, `dispose()`.

- Constructed with `extensionUri`. Exposes `agentPath` (bundled `.cjs` path) and
  `listenPort()` (starts the shared `127.0.0.1` `net.Server` lazily, returns its
  ephemeral port).
- `expect(configId)`: register an entry in `connecting` state awaiting a
  connection. On `hello` with matching `RCM_MONITOR_ID`, bind socket ↔ entry and
  flip to `live` on first `metrics`. No pid needed up front (`hello.pid` carries
  it) — so the debug-launch path works without a pid.
- Per-entry state: `NodeMonitoringState { configId, status:'connecting'|'live'|'lost',
  startTime, hello, history:NodeMetricsTick[], heapSpaces, gcEvents, pid }`. Ring
  buffer capped at 60 (one tick/s; longer windows fed by the webview, as JVM
  does). `gcEvents` pruned to 60 s.
- `saveHeapSnapshot(configId, path)`: write `snapshot <path>\n`, return a promise
  resolved on `snapshotComplete` / rejected on close (same pending-promise
  pattern as JVM heap dumps).
- Socket `close` → mark `lost`, fire `onChanged`. Identity-checked against the
  current entry (avoid stomping a successor after fast detach+reattach).
- `dispose()`: detach all, close the server.

### 4. Launch wiring

**`ExecutionService`** — new optional last ctor param `nodeMonitoring?:
NodeMonitoringService`. In `run()`:

```
if (opts.monitor) {
  if (cfg.type === 'npm' && this.nodeMonitoring) {
    monitorPort   = this.nodeMonitoring.listenPort();   // IPC server port
    nodeAgentPath = this.nodeMonitoring.agentPath;
  } else if (this.monitoring) {
    /* existing JVM allocateFreePort path, unchanged */
  }
}
```

`prepareLaunch` ctx gains optional `nodeAgentPath?: string`. After launch:
`if (cfg.type === 'npm' && this.nodeMonitoring) this.nodeMonitoring.expect(cfg.id)`
instead of `monitoring.attach(...)`. `stop()` and `dispose()` also call
`nodeMonitoring?.detach(id)`.

**npm `prepareLaunch`** (src/adapters/npm/NpmAdapter.ts) — extended to accept
`ctx`. When `ctx.monitor && ctx.nodeAgentPath`, add to `env`:

- `NODE_OPTIONS`: append `--require <agentPath>` to any existing value.
- `RCM_MONITOR_PORT`: `String(ctx.monitorPort)`.
- `RCM_MONITOR_ID`: `cfg.id`.

(Existing `FORCE_COLOR` / Node-path-prepend behavior preserved.)

**`DebugService`** — npm debug is launch-type, bypassing `ExecutionService.run`.
Gains an optional `nodeMonitoring?` dependency. For `npm + opts.monitor`: fetch
`listenPort()`/`agentPath`, merge the same three env vars into the debug
config's `env`, and call `nodeMonitoring.expect(cfg.id)`. (`--require` and
`--inspect` coexist.)

**Server-like gating** — pure helper `isMonitorableNpmScript(cfg): boolean`:
true when `typeOptions.scriptName ∈ {start, dev, serve, develop, watch, preview}`
**or** a framework is detected for the config. Drives the contextValue marker.

### 5. The Node Monitor view

**`MonitorPanel.open(config, extensionUri, jvmMonitoring, nodeMonitoring)`** —
selects the service by `config.type` (`npm` → node, else jvm), subscribes to that
service's `onChanged`, posts a `runtime: 'node' | 'jvm'` tag to the webview via a
`#root` data attribute, and forwards Node data under a `monitor.node.*` command
namespace (`monitor.node.tick`, `.heapSpaces`, `.gc`, `.hello`,
`.snapshotComplete`). The only `extension.ts` change is passing `nodeMonitoring`
to `MonitorPanel.open`.

**Webview split** — `main.tsx` reads the `runtime` attr and renders either the
existing view (renamed `JvmMonitorView`, otherwise unchanged) or a new
**`NodeMonitorView.tsx`**. Separate component trees: Node never imports JVM
tiles/tabs, guaranteeing no Java labels or empty placeholders.

**`NodeMonitorView` layout:**

- Header: config name; window selector (60s / 5min / 30min); **Save heap
  snapshot** (writes `.heapsnapshot`, then offers "Reveal in Explorer"); run
  duration.
- Chart strip: RSS and heap-used over time (auto-scaled; same SVG approach as
  the JVM strip).
- KPI tiles (heap + CPU emphasized): **Heap** (used / limit), **RSS**, **CPU %**,
  **Event-loop lag** (p99), **Active handles**, **GC** (cumulative pause, last
  60 s). Each with a hover tooltip.
- Tabs (three; no "App", no class histogram):
  - **Memory** — RSS/heap chart, V8 heap-space gauges (pools analog: new / old /
    code / large-object space, used vs available), external + arrayBuffers, GC
    timeline, allocation rate (Δ heapUsed/s), Save heap snapshot.
  - **Event loop** — event-loop lag chart (mean + p99) and active
    handles/requests over time. (Node-native counterpart to the JVM "Threads"
    tab.)
  - **Runtime** — Node version, V8 version, pid, platform/arch, execPath, cwd,
    uptime, resource usage; expandable **argv** and **environment variables**
    lists (mirrors the JVM-internals collapsibles).

**Tree row** — for a monitored npm config, `RunConfigTreeProvider` reads
`nodeMonitoring.state(id)` and appends `"<rss MB> · <cpu>%"` **text only** to the
description (RSS as headline, no sparkline). `:monitored` is set when **either**
monitoring service has state for the config.

### 6. Menus / commands / contextValue

No new command IDs. contextValue gains a `:monitorable` marker for server-like
npm rows, placed right after the tool suffix:
`${base}:npm:monitorable${groupSuffix}${monitoredSuffix}`.

- Add two `view/item/context` entries (existing commands, npm-specific `when`):
  - `runConfig.runMonitored` — `^configIdle:npm:monitorable(:grouped)?$`
  - `runConfig.debugMonitored` — `^configIdle:npm:monitorable(:grouped)?$`
- Update anchored npm regexes that must still match a now-`:monitorable` row to
  tolerate `(:monitorable)?` (same convention used when `:monitored` was added —
  onboarding gotcha #265). Touched clauses (enumerate exhaustively in the plan):
  - `runConfig.openMonitor` alternation →
    `…(:(maven|gradle|npm|python|go))?(:monitorable)?(:grouped)?:monitored$`
  - npm right-click actions (install / update / prune): insert `(:monitorable)?`
    before `(:grouped)?(:monitored)?$`.
  - Any other clause currently matching `:npm` with a trailing `$`.

Only npm rows ever carry `:monitorable`; maven/gradle/python/go/spring/java
clauses are untouched.

## Data flow (happy path)

1. Right-click a server-like npm config → **Run with Monitoring**
   (`runConfig.runMonitored`) → `exec.run({monitor:true})`.
2. `ExecutionService` gets `listenPort()` + `agentPath` from `nodeMonitoring`,
   threads them into `prepareLaunch`.
3. npm `prepareLaunch` sets `NODE_OPTIONS=--require <agent>`,
   `RCM_MONITOR_PORT`, `RCM_MONITOR_ID`.
4. Task launches; `exec` calls `nodeMonitoring.expect(cfg.id)`.
5. The agent loads in-process, connects to the server, sends `hello` (matched by
   id), then streams `metrics` / `heapSpaces` / `gc`.
6. `NodeMonitoringService` buffers ticks, fires `onChanged`.
7. Tree row shows `<rss> MB · <cpu>%`; `:monitored` appears →
   **Open Monitor View** is available.
8. `MonitorPanel` renders `NodeMonitorView` from the same stream; **Save heap
   snapshot** round-trips `snapshot`/`snapshotComplete`.
9. Stop → `nodeMonitoring.detach(id)`; or process exit closes the socket → `lost`.

## Testing (Jest + vscode mock)

- `NodeMonitoringService`: real loopback `net` connection (or injected socket) —
  hello routing by `RCM_MONITOR_ID`, metrics ring buffer + window cap, gc
  retention, first-connection-wins dedup, `detach`, snapshot promise
  resolve/reject on close.
- npm `prepareLaunch`: env vars set only when `ctx.monitor`; existing
  `NODE_OPTIONS` preserved.
- `ExecutionService` routing: npm + monitor calls `nodeMonitoring.expect` (not
  `monitoring.attach`) and uses `listenPort()` (not `allocateFreePort`).
- `DebugService`: npm + monitor injects agent env into the debug config and calls
  `expect`.
- `isMonitorableNpmScript`: pure unit tests.
- `RunConfigTreeProvider`: server-like npm → `:monitorable`; monitored npm →
  `:monitored` + heap/CPU description text.
- Agent `.cjs`: not unit-tested in-process; any pure formatting helpers live in a
  tested module. Optional real-node smoke test deferred.

## Build / packaging

- `media/agent/rcm-node-agent.cjs` is committed and covered by the existing
  `media/**` inclusion; no esbuild/vite changes.
- Plan verification includes `vsce ls` (or `--no-dependencies` package) to confirm
  the agent file ships in the VSIX.
- Standard gate: `npm run typecheck && npm test && npm run build`.

## Risks / mitigations

- **NODE_OPTIONS propagation** to child processes → first-connection-wins +
  documented caveat (v1).
- **Destabilizing JVM monitoring** → parallel service; JVM code paths untouched;
  full existing test suite must stay green.
- **contextValue regex churn** → enumerate every touched clause in the plan;
  cover with tree-provider tests; only npm rows affected.
- **Agent keeping the app alive / crashing it** → `.unref()` everywhere, all
  sampling wrapped in try/catch, agent never throws into the host.

## Out of scope (explicit)

Sidebar sparkline for Node; Go/Python monitoring; fork-aware worker selection;
actuator/"App" tab; class histogram; generalizing the two services into a shared
core (revisit when a third runtime lands — YAGNI).
