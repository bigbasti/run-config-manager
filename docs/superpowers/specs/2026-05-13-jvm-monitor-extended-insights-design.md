# JVM Monitor view — extended insights

**Date:** 2026-05-13
**Status:** Design approved, ready for implementation plan
**Builds on:** `2026-05-12-jvm-memory-monitoring-design.md` (the bundled JMX agent + MonitorPanel webview)

## Problem

The current Monitor view shows heap chart, CPU, threads count, GC count/time, and a class histogram. Useful, but it's missing most of the signal the JVM is willing to give us. The user can't tell from the view:

- Where the heap pressure lives (Eden vs Old Gen vs Metaspace).
- Whether GC pauses are spiking (and why — Allocation Failure vs Metadata GC Threshold).
- Whether off-heap buffers (direct + mapped) are leaking — the heap chart misses Netty/NIO leaks entirely.
- What threads are actually doing — state distribution, top-by-CPU, deadlocks.
- Whether the JVM is leaking classloaders (loaded-class count climbing).
- OS-level pressure: load average, free RAM, swap, open file descriptors.
- App-level signals: HTTP request rate, latency percentiles, health, live log-level.

JMX exposes all of this via standard MBeans the agent already has access to. We extend the agent + the webview to surface it, and reorganize the panel so the additional density doesn't drown the user.

## Goals

- Cover all 8 data categories: heap-pool breakdown, GC behavior, threads detail, off-heap, class loading, JIT/OS, Actuator/Tomcat.
- Reorganize the panel: top KPI row → tabs for deep dives → class histogram anchored at the bottom.
- Color-coded KPI tiles (green/yellow/red) so a glowing red tile says "click here." Each tile clicks through to its tab.
- Graceful degradation when a source is unavailable (e.g., no Actuator → App tab shows an explanation, doesn't break).
- Keep agent overhead negligible — tiered polling, cheap reads at 1 s, more expensive ones at 5–10 s.

## Non-goals

- Per-method profiling (CPU sampling, allocation profiling). Out of reach without a proper profiler attached.
- Heap-analysis UI (dominator tree, retention paths). Still the heap-dump file path.
- Remote JMX. Same posture as v1: localhost only.
- Spring Boot Actuator coverage of arbitrary user endpoints. We surface the well-known ones (`/health`, `/metrics`, `/httptrace`, `/loggers`) and skip the rest.
- Prometheus / Micrometer scraping. Actuator is the bridge.

## Architecture

Three pieces extend the existing system. Nothing new gets built from scratch.

### 1. Agent extensions (`monitor-agent/.../Monitor.java`)

The existing `MetricsLoop` gains additional cheap reads. New data joins the existing `metrics` JSON line — no new wire-format types for the per-second tier. New tier-2 (5 s) and tier-3 (10 s) loops emit additional message types.

**Tier 1 — every 1 s** (extending the existing `metrics` line):

```jsonc
{
  "type": "metrics",
  "t": <ms>,
  // existing
  "heapUsed": ..., "heapCommitted": ..., "heapMax": ..., "nonHeapUsed": ...,
  "cpuLoad": ..., "threadCount": ..., "gcCount": ..., "gcTime": ...,
  // NEW
  "pools": {
    "Eden Space":      { "used": ..., "committed": ..., "max": ... },
    "Survivor Space":  { "used": ..., "committed": ..., "max": ... },
    "Old Gen":         { "used": ..., "committed": ..., "max": ... },
    "Metaspace":       { "used": ..., "committed": ..., "max": ... },
    "Compressed Class Space": { "used": ..., ... },
    "CodeHeap 'non-nmethods'":   { "used": ..., ... },
    "CodeHeap 'profiled nmethods'": { "used": ..., ... },
    "CodeHeap 'non-profiled nmethods'": { "used": ..., ... }
  },
  "directBuffer": { "count": <n>, "memoryUsed": <bytes>, "totalCapacity": <bytes> },
  "mappedBuffer": { "count": <n>, "memoryUsed": <bytes>, "totalCapacity": <bytes> },
  "loadedClasses": <count>,
  "totalLoadedClasses": <count>,
  "unloadedClasses": <count>,
  "compileTimeMs": <ms>,
  "openFds": <n>,
  "maxFds": <n>,
  "systemLoad": <fraction>,
  "freePhysicalMemory": <bytes>,
  "totalPhysicalMemory": <bytes>,
  "freeSwap": <bytes>
}
```

Pool names are passed through as the JVM names them — the consumer does the mapping into the canonical "young / old / metaspace / code-cache" buckets.

**Tier 1 (alongside metrics) — per-collector GC events.** When a `GarbageCollectorMXBean.getCollectionCount()` value changes between ticks, emit a `gc` message:

```jsonc
{
  "type": "gc",
  "t": <ms>,
  "collector": "G1 Young Generation",
  "duration": <ms>,
  "cause": "G1 Evacuation Pause",
  "action": "end of minor GC",
  "totalCount": <n>,
  "totalTime": <ms>
}
```

We get cause + action + duration from `com.sun.management.GarbageCollectionNotificationInfo`. The agent attaches a JMX notification listener once at startup; the listener pushes events onto a queue the metrics loop drains each tick. Per-collection emission is the right granularity — you want each pause as a distinct event, not aggregated.

**Tier 2 — every 5 s** — new `threads` message:

```jsonc
{
  "type": "threads",
  "t": <ms>,
  "states": { "RUNNABLE": <n>, "BLOCKED": <n>, "WAITING": <n>, "TIMED_WAITING": <n>, "NEW": <n>, "TERMINATED": <n> },
  "topByCpu": [
    { "id": <tid>, "name": "...", "state": "RUNNABLE", "cpuTimeNs": <ns>, "cpuDeltaNs": <ns>, "stackSnippet": ["a.b.C.foo(C.java:42)", "..."] },
    ...
  ],
  "deadlock": null | { "threadIds": [<tid>, ...], "names": [...], "summary": "..." }
}
```

Top-by-CPU walks every thread, reads `getThreadCpuTime(id)`, sorts by delta-since-last-tier-2-tick, takes top 10. Stack snippet is the top 5 frames from `getThreadInfo(id, 5).getStackTrace()`. Deadlock check uses `findDeadlockedThreads()`. Cost: ~5–20 ms on a 200-thread JVM; acceptable at 5-second cadence.

**Tier 3 — every 10 s** — alongside the existing `histogram` message, add an `actuator` poll when reachable:

```jsonc
{
  "type": "actuator",
  "t": <ms>,
  "available": true,
  "baseUrl": "http://localhost:8080/actuator",
  "health": { "status": "UP", "components": { "db": "UP", "diskSpace": "UP" } },
  "metrics": {
    "http_requests_total": <n>,
    "http_request_duration_p50_ms": <n>,
    "http_request_duration_p95_ms": <n>,
    "http_request_duration_p99_ms": <n>
  },
  "topEndpoints": [
    { "uri": "/api/v1/users", "method": "GET", "count": 1234, "p99Ms": 412, "errorRate": 0.001 }
  ],
  "loggers": [
    { "name": "ROOT", "configured": "INFO", "effective": "INFO" },
    { "name": "de.telekom.it", "configured": null, "effective": "INFO" }
  ],
  "tomcat": null | {
    "currentThreadsBusy": <n>,
    "maxThreads": <n>,
    "requestCount": <n>,
    "errorCount": <n>
  }
}
```

Source detection: at startup the agent tries `http://localhost:<port>/actuator` for the apps's HTTP port. We probe ports 8080, 8081, then read the JVM args for `-Dserver.port=<n>` / `--server.port=<n>`. If any returns a 200, we record the base URL and poll subsequent ticks. If none resolves we emit `{ "type": "actuator", "available": false, "reason": "..." }` once and skip subsequent attempts. The Tomcat block is populated by reading the Tomcat MBeans (`Catalina:type=ThreadPool,*` and `Catalina:type=GlobalRequestProcessor,*`) when present, independent of Actuator.

**On-demand** — agent stdin already accepts commands. New ones:

- `thread-dump <tid>\n` → emits `{ "type": "threadDump", "t": ..., "tid": ..., "stack": [...] }` with the full stack trace.
- `set-log-level <name> <level>\n` → POSTs `{configuredLevel: level}` to `<actuator>/loggers/<name>`. Replies with `{ "type": "logLevelChanged", "name": ..., "level": ... }` or an error.

### 2. Service extensions (`MonitoringService.ts`)

The existing per-config `Entry` gains slots for the new data:

```ts
interface MonitoringState {
  // existing
  configId, pid, jmxPort, startTime, status, history, histogram,
  // NEW
  pools: Record<string, PoolUsage> | null;       // latest pool snapshot
  gcEvents: GCEvent[];                            // ring buffer of last 60s of GC events
  buffers: { direct: BufferStats; mapped: BufferStats } | null;
  classLoading: ClassLoadingSnapshot | null;
  jit: { compileTimeMs: number } | null;
  os: OsSnapshot | null;
  threadsDetail: ThreadsSnapshot | null;          // last tier-2 tick
  actuator: ActuatorSnapshot | null;              // last tier-3 tick (or { available: false } )
  threadDumps: Map<number, ThreadDump>;           // requested via thread-dump cmd
}
```

The existing `applyMessage` switch grows new cases for `gc`, `threads`, `actuator`, `threadDump`, `logLevelChanged`. The `metrics` case absorbs the new fields into a per-tick view — they're still part of the per-second history because the KPI tiles render them.

New service methods:

- `requestThreadDump(configId, tid): Promise<ThreadDump>` — writes `thread-dump <tid>\n` to agent stdin, awaits matching `threadDump` line.
- `setLogLevel(configId, name, level): Promise<void>` — writes `set-log-level <name> <level>\n` to agent stdin.

### 3. UI: layout + tabs (`webview/src/MonitorView.tsx` + new components)

Layout changes top-to-bottom:

```
┌──────────────────────────────────────────────────────────────────┐
│  Monitor: <config-name>          [60s 5min 30min] [Save dump]    │
├──────────────────────────────────────────────────────────────────┤
│  Heap chart (existing — used + committed, auto-scaled)           │
├──────────────────────────────────────────────────────────────────┤
│  KPI tiles (6, single row, click-to-tab)                         │
│    Heap • GC pause • CPU • Threads • Off-heap • FDs              │
├──────────────────────────────────────────────────────────────────┤
│  Tabs:  [Memory]  [Threads]  [JVM internals]  [App]              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  active tab content                                         │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  Class histogram (existing — anchored at the bottom across tabs) │
└──────────────────────────────────────────────────────────────────┘
```

The existing analytics grid (`Run duration`, `Heap used`, `Threads`, `CPU now/avg`, `GC count/time`) gets folded into the KPI tiles + the Memory and JVM internals tabs — it's redundant with the new layout.

#### KPI tiles

Six tiles, fixed order:

| Tile | Source field | Yellow threshold | Red threshold | Click target |
|------|------|------|------|------|
| Heap | `heapUsed / heapMax` | 70% | 90% | Memory |
| GC pause | sum(`gcEvents.duration` last 60s) | 100 ms | 500 ms | Memory |
| CPU | `cpuLoad` (rolling 5 s avg) | 70% | 90% | Threads |
| Threads | total + #BLOCKED | BLOCKED > 0 | deadlock detected | Threads |
| Off-heap | `directBuffer.memoryUsed + mappedBuffer.memoryUsed` | 2× max-heap | 4× max-heap | Memory |
| Open FDs | `openFds / maxFds` | 50% | 80% | JVM internals |

Each tile is a small flex row: label uppercase 9px, primary value 18px, secondary line 9px (e.g., "of 4 GB"). Border-left tinted by health, background subtly tinted in the same hue, full text + threshold in a tooltip. Click → activates the relevant tab.

Tile component is reused across the app — small, generic, takes `{ label, value, secondary, status, tooltip, onClick }`.

#### Memory tab

```
┌─ Memory pools (stacked horizontal bars) ──────────────────────────┐
│  Young   ▓▓▓░░░░░░░  Eden 92 MB / 128 MB                          │
│  Survivor ▓░░░░░░░░░  S0 4 MB / 16 MB · S1 0 MB / 16 MB            │
│  Old     ▓▓▓▓▓▓░░░░  220 MB / 384 MB                              │
│  Metaspace ▓▓░░░░░░░  64 MB / 128 MB                              │
│  Code Cache ▓░░░░░░░  18 MB / 240 MB                              │
└────────────────────────────────────────────────────────────────────┘

GC timeline (last 60s, vertical spikes; hover for cause + duration)
   │           │       │      │
   ╵───────────╵───────╵──────╵─────────────  width = duration

Off-heap buffers (direct + mapped chart, 60s)

Allocation rate (MB/sec, derived from heap delta) — last 60s
```

Memory pools breakdown rendered as horizontal stacked bars; bar segments are colored by pool category (young = green, old = blue, metaspace = orange, code = purple). Tooltip on each segment shows used / committed / max.

GC timeline is an inline SVG strip — same time axis as the heap chart above. Each event is a vertical bar at its `t`; height = `log(duration)` so a 1 s pause stands out next to a 5 ms one. Color-coded by collector (Young = green, Old = red). Hover tooltip:

> **G1 Young Generation** at 14:23:01 · 12 ms · cause: G1 Evacuation Pause

#### Threads tab

```
┌─ State donut + count history side-by-side ───────────────────────┐
│   ◐  RUNNABLE: 23                Threads count over 60s          │
│      BLOCKED:  3   ⚠              ▁▁▂▂▃▃▃▃▃▄▄▄▄                  │
│      WAITING:  142                                                │
│      TIMED:    42                                                 │
└───────────────────────────────────────────────────────────────────┘

⚠ Deadlock detected — 3 threads in cycle              [Show details]

Top threads by CPU (last 5 s)            [▾]
┌───────────────────────────────────────────────────────────────────┐
│ name                          state      CPU%    stack snippet   │
│ http-nio-8080-exec-3          RUNNABLE   12.4%  → fooBar.run     │
│   (click to expand → full stack trace)                            │
└───────────────────────────────────────────────────────────────────┘
```

Donut: SVG conic gradient. State legend on the right with counts. BLOCKED count is highlighted red when > 0.

Deadlock banner: shows when `threadsDetail.deadlock != null`. Red background, "Show details" button expands the cycle as a list of (thread name → waiting on lock held by thread name).

Top-CPU table: 10 rows max. Click a row → expand inline showing the full stack trace fetched on-demand via `monitor.threadDump`. The on-demand fetch keeps the tier-2 tick small (only 5 frames per thread); the full dump is only paid for when the user wants it.

#### JVM internals tab

```
┌─ Runtime ──────────────────────────────────────┬─ Class loading ──────────┐
│ Vendor:  Eclipse Adoptium                      │ Loaded:    4 213          │
│ Version: 17.0.9+9                              │ Total:     4 312          │
│ Uptime:  4m 12s                                │ Unloaded:  99             │
│ PID:     12345                                  │ Δ (60s):  +12 ⚠           │
└────────────────────────────────────────────────┴───────────────────────────┘

┌─ JIT ─────────────────────────┬─ OS ──────────────────────────────────────┐
│ Compile time:  1 234 ms       │ System load:    0.42                       │
│                                │ Free RAM:      8.4 GB / 16 GB              │
│                                │ Swap free:     2.0 GB / 2.0 GB             │
│                                │ Open FDs:      128 of 65 535               │
└───────────────────────────────┴───────────────────────────────────────────┘

▸ JVM args (12 entries, click to expand)
▸ System properties (74 entries)
▸ Environment (38 entries)
```

Each block is a card. Class-loading Δ over 60 s is the leak-indicator — when nonzero on a steady-state app it usually means dynamic classloaders aren't being collected (Spring DevTools restarts, hot-reload tooling, OSGi). Yellow marker + tooltip explaining the signal.

Static info (JVM args / system properties / environment) read once on connect via the existing `RuntimeMXBean`. Stored in the agent state, sent in the very first message after connect (a new `runtime` message type), so the JVM internals tab populates immediately.

#### App tab

```
┌─ Source ──────────────────────────────────────────────────────────┐
│ Spring Boot Actuator detected at http://localhost:8081/actuator    │
│ Updated 3s ago                                                     │
└────────────────────────────────────────────────────────────────────┘

┌─ HTTP traffic ────────────────────────────────────────────────────┐
│ Requests:  1 234 (24 req/s)                                        │
│ Latency:   p50: 18 ms  p95: 142 ms  p99: 412 ms ⚠                  │
└────────────────────────────────────────────────────────────────────┘

Top endpoints by p99 latency
┌────────────────────────────────────────────────────────────────────┐
│ method  uri                          count   p99      err%        │
│ GET     /api/v1/users                1 234   412 ms   0.1%         │
│ POST    /api/v1/orders                 421   234 ms   0.0%         │
└────────────────────────────────────────────────────────────────────┘

Health
  ✓ db          UP
  ✓ diskSpace   UP
  ✗ redis       DOWN — connection refused

Loggers (40 entries — search [____])
┌────────────────────────────────────────────────────────────────────┐
│ name                          effective   actions                  │
│ ROOT                          INFO        [DEBUG] [INFO] [WARN]    │
│ de.telekom.it                 INFO        [DEBUG] [INFO] [WARN]    │
└────────────────────────────────────────────────────────────────────┘
```

When source detection fails:

```
┌────────────────────────────────────────────────────────────────────┐
│ No app-level source detected                                       │
│                                                                     │
│ • Spring Boot: enable Actuator (add `spring-boot-starter-actuator`) │
│   and expose endpoints with                                         │
│   `management.endpoints.web.exposure.include=health,metrics,...`    │
│ • Tomcat: standalone Tomcat configs auto-detect via JMX             │
│                                                                     │
│ The other tabs work without an app-level source.                    │
└────────────────────────────────────────────────────────────────────┘
```

Log-level changer: action buttons inline in the row. Click `[DEBUG]` → service writes `set-log-level ROOT DEBUG\n` to agent stdin → agent POSTs to Actuator → next 10 s tick reflects the new level.

#### Tabs interaction with the KPI tiles

Each tile clicks through to a tab via `setActiveTab` state. Tabs are also reachable directly. State lives in `MonitorView`; no routing.

### 4. Spring Boot port detection

The agent needs to know the app's HTTP port to probe Actuator. Lookup order:

1. Read `RuntimeMXBean.getInputArguments()` for `-Dserver.port=<n>` / `-Dmanagement.server.port=<n>`.
2. Read system property `server.port` (set by Spring Boot at runtime).
3. Probe port 8080.

If none match, mark Actuator unavailable and emit one `{ available: false, reason: "no candidate port found" }` message.

## Schema migration

No persisted state. The view's tab selection isn't remembered across reloads (a v3 nicety; not v2). Every existing config keeps working unchanged — the new fields are additive on the `metrics` line, and old (pre-v2) agent jars are forward-compatible because the consumer treats unknown fields as missing.

## Performance budget

Target: total agent CPU < 0.5% of a core on a 4-core machine, under 4 MB resident.

- Tier 1 (1 s): cumulative ~5 ms per tick on a 200-thread, 4 GB-heap JVM. New reads (memory pools, buffers, class counts, JIT, FDs, OS) are all single-MBean attribute reads, negligible.
- Tier 2 (5 s): ~10–25 ms per tick. Per-thread CPU read + 5-frame stack capture is the dominant cost. Caps at 10 threads for the table.
- Tier 3 (10 s): histogram ~1 s on a 4 GB heap (existing). Actuator HTTP calls < 50 ms. Tomcat MBean reads negligible.

GC notification listener cost is per-collection (a few µs per fired event); not a polling cost.

## Error handling

- **Pool / buffer / OS / class / JIT MBean read fails**: skip the field on that tick, continue. Field will be absent from the JSON; consumer treats as `null`.
- **Per-thread CPU read fails** (rare; happens if the thread terminates mid-walk): drop that row.
- **Deadlock check fails**: log on stderr; tier-2 ticks continue.
- **Actuator probe times out**: mark unavailable; don't retry every tick (retry every 60 s in case the app started late).
- **Actuator returns malformed JSON**: log; emit `{ available: true, error: "..." }` so the UI shows the failure.
- **Tomcat MBean missing**: omit the `tomcat` block. Not an error.
- **GC notification listener fails to register**: log; rely on poll-based count delta as a fallback (no cause / per-event detail, just count + time).

## Testing

- Agent: existing tests cover `metrics` parsing. Add tests for the new fields. Manual smoke covers GC events + Actuator.
- `MonitoringService.test.ts`: extend with mocks for the new message types (gc / threads / actuator / threadDump / runtime / logLevelChanged).
- React: snapshot-light. Add per-component tests for the KPI tile (color thresholds), GC timeline (event positioning), and the deadlock banner.
- Static type check covers AgentMessage shape mismatches.

## Risks

- **Pool name variation across JVMs.** OpenJDK / GraalVM / Zulu use slightly different pool names for the same generations. We don't hardcode; we forward the JVM's names and the consumer maps them. Unrecognized names land in an "Other" bucket so nothing's hidden, just unlabeled.
- **Top-CPU drift on short-lived threads.** A thread that exists for one tick and disappears can show wild CPU% because the delta is divided by 5 s but the thread only ran for 200 ms. We accept this — it's accurate per the math, and the UI is for inspection, not paging.
- **Actuator base URL guess wrong.** When the app is on a non-standard port and doesn't set `-Dserver.port`, we'll miss it. Acceptable: user can disable monitor + re-launch with the right `-D`, or we add a config field later.
- **Log-level changer authentication.** Actuator endpoints can be auth-protected. v2 sends no credentials; if the request gets a 401 we surface "auth required — log-level changes disabled" in the App tab.
- **Stack snippet privacy.** Top-CPU rows ship 5-frame stack snippets to the webview. These can include parameter values via `toString()`-rendered locks. We never include locals, only frames.
- **Webview scroll vs anchored histogram.** With four tabs + KPI row + chart, vertical real-estate is tight. The anchored histogram becomes an inner scroll region instead of the page-level scroll. Acceptable.

## Out of scope (deferred)

- Heap-pool eviction recommendations ("Old gen 90% full — increase -Xmx"). Domain-expert territory.
- JFR (Java Flight Recorder) integration for actual profiling.
- Multi-config "compare two JVMs side-by-side" view.
- Persisted tab selection per config.
- Authentication-aware Actuator (Basic + bearer).
- HTTP request "live tail" (last 50 requests with method / status / latency). Could be a v3 once Actuator's `/httptrace` is parsed.
