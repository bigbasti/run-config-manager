# JVM memory monitoring

**Date:** 2026-05-12
**Status:** Design approved, ready for implementation plan

## Problem

When a Spring Boot, Quarkus, Java, or Tomcat config is running, the user has no visibility into its runtime — heap usage, CPU, thread count, GC behaviour. The standard alternatives (VisualVM, JConsole, Spring Boot Actuator UI, JProfiler) require switching tools, configuring JMX manually, and in some cases adding project dependencies. The extension already owns the launch lifecycle and JVM flag injection, so it can offer in-IDE monitoring without any of that friction.

## Goals

- Two new right-click entries on every JVM config: **"Run with Monitoring"** and **"Debug with Monitoring"**.
- When invoked, the launch automatically enables JMX, allocates a port, and attaches a small bundled monitoring agent.
- Tree row for the running config shows a 60-second heap-usage sparkline + current numeric (`▂▃▄▅▆▇▇▆▅▄▃▂  312 MB  2.1%`), updating each second.
- Right-click → **"Open monitor view"** opens a webview panel: large time-series chart on top, runtime analytics (uptime, heap, CPU, threads, GC) to the side, class-histogram table at the bottom (auto-refresh every 10 s).
- Class histogram is searchable, sortable by instances / bytes / className, groups by package prefix with expand/collapse.
- A **"Save heap dump"** button writes a `.hprof` file and offers to open it in an external analyzer (VisualVM / Eclipse MAT / JProfiler / `jhat`) when one is found on PATH.

## Non-goals

- A full heap-analysis UI (dominator tree, retention paths, leak suspects). Out of reach without a real heap parser; users with that need open the `.hprof` in MAT.
- Sub-second metric refresh. 1 s is the polling rate; finer is unhelpful and noisy.
- Histogram diff between snapshots. Could come later; v1 shows the current snapshot only.
- Remote monitoring of non-local JVMs. We connect to `localhost:<jmxPort>` only.
- Authenticated JMX. We disable JMX auth (`-Dcom.sun.management.jmxremote.authenticate=false`) and bind to localhost — same posture every IDE-side JVM monitoring tool ships.
- Profiling (CPU sampling, thread state attribution). MBeans give us aggregate values, not per-method breakdowns.

## Architecture

Six pieces.

### 1. Monitoring agent (`monitor-agent/`, source committed; built jar at `media/agent/rcm-monitor.jar`)

A small Java program that connects to the target JVM's JMX server and prints metrics as newline-delimited JSON to stdout. Built once with Maven; the prebuilt jar is committed under `media/agent/` so installing the extension never requires a JDK.

Source layout:

```
monitor-agent/
  pom.xml
  src/main/java/com/runconfig/monitor/Monitor.java
  README.md  # how to rebuild + commit the jar
```

Behaviour:

- Args: `<jmxPort> [--histogram-interval=<seconds>] [--metrics-interval=<seconds>]`.
- Connects to `service:jmx:rmi:///jndi/rmi://localhost:<jmxPort>/jmxrmi`.
- Two background timers:
  - **Metrics tick** (default every 1 s): reads `MemoryMXBean`, `OperatingSystemMXBean`, `ThreadMXBean`, `GarbageCollectorMXBean`. Emits one `{ type: 'metrics', t, heapUsed, heapCommitted, heapMax, nonHeapUsed, cpuLoad, threadCount, gcCount, gcTime }` JSON line.
  - **Histogram tick** (default every 10 s): invokes `gcClassHistogram` on the diagnostic MBean. Parses the text output. Emits one `{ type: 'histogram', t, rows: Array<{ instances, bytes, className }> }`. Top 200 rows only.
- Dump-on-demand: stdin protocol. The extension can write `dump <absolutePath>\n` on the agent's stdin. Agent calls `HotSpotDiagnosticMXBean.dumpHeap(path, true)` and emits a `{ type: 'dumpComplete', path }` or `{ type: 'error', message }` line when finished.
- On JMX connection loss: emits `{ type: 'error', message: '<err>' }` and exits with code 2. The extension marks the monitored config as `'lost'` in the tree and tears down the agent.
- On parent-process termination: agent exits naturally (its parent's stdin pipe closes).

Wire format: one JSON document per line, `\n`-terminated. No streaming-JSON parser needed on the consumer.

```ts
// src/services/monitoring/AgentMessage.ts (new)
export type AgentMessage =
  | { type: 'metrics'; t: number; heapUsed: number; heapCommitted: number; heapMax: number;
      nonHeapUsed: number; cpuLoad: number; threadCount: number; gcCount: number; gcTime: number; }
  | { type: 'histogram'; t: number; rows: Array<{ instances: number; bytes: number; className: string }> }
  | { type: 'dumpComplete'; path: string }
  | { type: 'error'; message: string };
```

### 2. MonitoringService (`src/services/MonitoringService.ts`)

Owns the per-config monitoring lifecycle. Singleton on the extension. API:

```ts
export class MonitoringService {
  // Attach to a freshly-launched JVM. Spawns the agent jar; pipes its stdout
  // into the per-config history buffer. Idempotent — calling attach() twice
  // for the same config is a no-op.
  attach(configId: string, pid: number, jmxPort: number): void;

  // Stop the agent. Called by the existing onDidEndTask listener so we don't
  // leak agent processes when the user clicks Stop.
  detach(configId: string): void;

  // Read the current state.
  state(configId: string): MonitoringState | undefined;

  // Subscribe to per-config updates. Tree provider listens for sparkline
  // refresh; the panel listens for chart + table updates.
  readonly onChanged: vscode.Event<string>; // emits configId

  // Save a heap dump. Returns the absolute path of the written file, or
  // throws on failure.
  saveHeapDump(configId: string, targetPath: string): Promise<string>;
}

export interface MonitoringState {
  configId: string;
  pid: number;
  jmxPort: number;
  startTime: number;
  status: 'connecting' | 'live' | 'lost';
  // Ring buffer, ~60 entries (one per second).
  history: AgentMessage[];
  histogram: AgentMessage | null; // last 'histogram' message
  histogramAt: number;
}
```

Internal:
- Agent process is spawned with `cp.spawn('java', ['-jar', '<extensionUri>/media/agent/rcm-monitor.jar', port])`.
- Stdout is line-buffered. Each complete line `JSON.parse`'d. Bad lines logged at debug; not surfaced.
- Ring buffer size: 60 entries × 1 s = 60 s on the default polling rate. Keeping a fixed-size array makes "last N seconds" rendering trivial.
- Heap dump: writes `dump <path>\n` to agent stdin; awaits the matching `dumpComplete` line.

### 3. Adapter changes — JVM flag injection

Each of the four JVM adapters (`SpringBoot`, `Quarkus`, `Java`, `Tomcat`) already implements `prepareLaunch`. Extend `PrepareContext` (in `src/adapters/RuntimeAdapter.ts`) with:

```ts
interface PrepareContext {
  debug: boolean;
  debugPort?: number;
  monitor?: boolean;     // NEW
  monitorPort?: number;  // NEW — JMX port allocated by ExecutionService
}
```

Each adapter, when `monitor === true`, appends to the JVM-args env block:

```
-Dcom.sun.management.jmxremote=true
-Dcom.sun.management.jmxremote.port=<monitorPort>
-Dcom.sun.management.jmxremote.rmi.port=<monitorPort>
-Dcom.sun.management.jmxremote.local.only=true
-Dcom.sun.management.jmxremote.authenticate=false
-Dcom.sun.management.jmxremote.ssl=false
-Djava.rmi.server.hostname=127.0.0.1
```

Per adapter:

- **SpringBoot:** `java-main` mode appends to `vmArgs`; `gradle` and `maven` modes inject via `JAVA_TOOL_OPTIONS` (the existing pattern for debug-mode flags).
- **Java:** `java-main` mode appends to `vmArgs`; `gradle`/`maven`/`*-custom` modes inject via `JAVA_TOOL_OPTIONS`.
- **Quarkus:** dev mode forks a JVM via Quarkus's plugin; flags go through `JAVA_TOOL_OPTIONS`.
- **Tomcat:** all modes go through `CATALINA_OPTS` (the env channel `catalina.sh` already reads).

The flag injection is identical across adapters; we centralize the string-building in a small helper `buildMonitorJvmArgs(port: number): string[]` in `MonitoringService.ts`.

### 4. ExecutionService + DebugService — port allocation + post-launch attach

`ExecutionService.run` and `DebugService.debug` gain an `opts.monitor?: boolean`. When set:

1. Allocate a free port via the existing `PortAllocator` (used for debug ports).
2. Pass `monitor: true, monitorPort: <port>` into `prepareLaunch`'s context.
3. After the launch resolves and the child PID is known, call `monitoringService.attach(cfg.id, pid, port)`.
4. Subscribe to the existing `onDidEndTask` listener so the agent is detached when the JVM exits.

PID acquisition: `RunTerminal` already exposes the spawned child's `pid`. For `ShellExecution`-path configs (Quarkus + interactive custom-command — neither relevant here, but kept for completeness), we'd skip monitoring with a warning. JVM configs all use `CustomExecution` + `RunTerminal`, so `pid` is reliably available.

### 5. Tree provider — sparkline + monitored contextValue

`RunConfigTreeProvider`:

- Listens on `monitoringService.onChanged` and refreshes the affected row.
- For monitored running configs:
  - Computes a 16-character sparkline from the history buffer's `heapUsed` series. 16 buckets × 4 s = 64 s coverage; one Unicode block char per bucket.
  - `TreeItem.description = '▂▃▄▅▆▇▇▆▅▄▃▂  312 MB  2.1%'`.
  - `tooltip` includes full breakdown: heap used / committed / max, non-heap used, threads, CPU, GC count + time, uptime.
  - Adds `:monitored` suffix to `contextValue` so the right-click menu can offer the "Open monitor view" entry.

Sparkline implementation: standard `▁▂▃▄▅▆▇█` mapping by bucketed value range. Buckets are min-max scaled to the heap-max; if heap-max is unknown (early connection), uses the running min/max.

### 6. MonitorPanel webview (`src/ui/MonitorPanel.tsx`, new)

A new webview panel mirroring the existing `PortViewerPanel` shape. Single panel per config (re-opening reveals the existing one). Layout:

```
┌─────────────────────────────────────────────────────────────────┐
│  Monitor: <config name>          [60s 5min 30min] [Save dump]   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │  uPlot line chart — heap (used/committed/max) + non-heap    │ │
│ │                  + CPU% on a secondary axis                  │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ Run duration: 4m 12s    Heap: 312 MB / 2 GB    Threads: 47       │
│ CPU: 2.1% (avg 1.8%)    GC: 23 collections, 412 ms total         │
│ ─────────────────────────────────────────────────────────────── │
│ Class histogram (last refresh 8s ago, next in 2s) [Pause auto]   │
│ Filter: [______________]    Sort: [Bytes ▾]                      │
│ ▾ java.* (5 234 instances, 124 MB)                               │
│   ▸ java.util (1 203 instances, 23 MB)                           │
│   ▸ java.lang (3 099 instances, 45 MB)                           │
│ ▸ org.springframework.* (2 100 instances, 56 MB)                 │
│ ▸ com.example.* (412 instances, 4.2 MB)                          │
└─────────────────────────────────────────────────────────────────┘
```

Components:

- **Chart**: uPlot library (35 KB minified). Time-axis = wall-clock; primary Y = bytes (auto-scale to 4 GB max), secondary Y = CPU% 0-100. Three series stacked: heap-used (filled), heap-committed (line), heap-max (dashed line); CPU% as a separate line on the right axis.
- **Time-window selector**: 60s / 5min / 30min. The agent only buffers 60 s server-side; longer windows are rendered from a webview-side ring buffer fed by the `MonitoringService` events. 30-min buffer = 1800 entries × ~70 bytes = ~120 KB; trivial.
- **Analytics row**: derived numbers — uptime from `MonitoringState.startTime`, average CPU from history, GC stats from the latest tick.
- **Histogram table**: virtual-scrolled (max 200 rows from the agent + group rollups). Searchable by substring of `className` (case-insensitive). Sortable by instances / bytes / className. Grouping is client-side: for each row, split `className` on `.`, accumulate counts per prefix, render as nested expand-collapse.
- **Pause auto-refresh** toggle: when on, the agent stops emitting histograms (extension sends `histogram-pause\n` on the agent's stdin). Useful on big heaps where the GC pause from each refresh hurts.
- **Save heap dump** button: opens a Save File dialog defaulting to `<configName>-<timestamp>.hprof`. On confirm, posts `saveHeapDump` to the extension; extension calls `monitoringService.saveHeapDump`. While writing, the panel shows a notification: "Writing heap dump… 412 MB written". On completion, panel offers "Open in <External Tool>" buttons for any of VisualVM / Eclipse MAT / JProfiler / `jhat` found on PATH, plus "Reveal in file explorer".

### Right-click menu wiring

Three new commands:

- `runConfig.runMonitored` — gated on `viewItem == configIdle*` AND config type ∈ {spring-boot, quarkus, java, tomcat}. Routes through `ExecutionService.run(cfg, folder, { monitor: true })`.
- `runConfig.debugMonitored` — same gating; routes through `DebugService.debug(cfg, folder, { monitor: true })`.
- `runConfig.openMonitor` — gated on `viewItem` containing `:monitored` suffix. Opens / reveals the `MonitorPanel` for that config.

The two run/debug commands also append to the existing tree-row inline buttons cluster (alongside Run + Debug), with a small chart icon. "Open monitor view" is right-click-only.

## Schema migration

No persisted state — monitored vs non-monitored is per-launch, not per-config. The user picks "Run with Monitoring" rather than configuring a flag in the form. Existing configs keep working unchanged.

## Error handling

- **Agent jar missing or unreadable**: `MonitoringService.attach` throws; the run still succeeds, but the user sees a toast: "Monitoring unavailable — `media/agent/rcm-monitor.jar` not found." Run continues without the sparkline.
- **JMX connect failure** (port not yet open when agent starts): agent retries internally for 10 s, then exits with `error` message. Service flips state to `'lost'`; tree row shows the sparkline frozen + a `(disconnected)` badge.
- **Histogram parse failure** (unexpected `gcClassHistogram` output): agent emits `{ type: 'error' }`; panel keeps the previous histogram + shows a warn banner.
- **Heap dump out of disk**: JMX call throws; panel shows the error.
- **Tree-row sparkline desync**: ring buffer is the single source of truth; tree refresh is event-driven, not polled.

## Testing

- `monitor-agent/test/` — Java tests for the parser (using a known `gcClassHistogram` fixture).
- `MonitoringService.test.ts` — agent stdout parsing (well-formed / error / partial lines), ring buffer wraparound, lifecycle (attach / detach / restart). Mocks `child_process.spawn` with a fake stdout stream.
- `buildMonitorJvmArgs.test.ts` — flag string is correct for all eight permutations (each adapter × monitor on/off).
- `parseClassHistogram.test.ts` — extension-side post-processing: package-prefix grouping, sorting, search filter.
- Manual smoke: launch a Spring Boot app with monitoring → see sparkline → open monitor view → click Save dump → confirm `.hprof` written → open in VisualVM if installed.

## Risks

- **Histogram cost on huge heaps.** `gcClassHistogram` walks live objects. On a 4 GB heap, ~1 s wall-clock and a brief GC pause. Mitigations: 10 s default refresh, "Pause auto-refresh" toggle, optional histogram-disable flag in the panel.
- **JMX port collisions.** Same risk as debug ports; reuses the existing `PortAllocator`.
- **Agent jar bitrot.** Source committed alongside the prebuilt jar means anyone can rebuild. CI: a build-verify step that rebuilds the jar from source and diffs against the committed one. (Out of scope for v1; flag for later.)
- **Bundled jar size.** ~12 KB. Negligible compared to the existing `media/webview/assets/main.js` at 235 KB.
- **Auth posture.** JMX disabled-auth + localhost-only is the same posture VisualVM / JConsole / IntelliJ's profiler use for local debugging. Not safe for production servers — not relevant since this only triggers on the user's local launch.
- **Quarkus dev mode JMX.** Quarkus's hot-reload restarts the forked JVM on file change. The forked JVM picks up `JAVA_TOOL_OPTIONS` so JMX still binds — but the port number stays the same across restarts because we set it explicitly. Confirm during smoke test.
- **Spring Boot DevTools restarts.** When DevTools restarts the application context, the JVM stays alive — JMX connection survives, no special handling needed.

## Out of scope (deferred)

- Histogram diffing between snapshots ("what's grown since I started?").
- Per-thread CPU attribution.
- HTTP request rate / latency metrics (would require Actuator / Micrometer).
- Saved monitoring sessions (record metrics to a file, replay later).
- Auto-detection of Actuator-exposed metrics for richer per-app data.
- Build-verify CI step that rebuilds the agent jar.
