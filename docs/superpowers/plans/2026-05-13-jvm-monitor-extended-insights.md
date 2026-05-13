# JVM Monitor extended insights — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing JVM Monitor view with eight categories of new insight (memory pools, per-collector GC events with cause+duration, off-heap buffers, thread states + top-by-CPU + deadlock detection, class-loading deltas, JIT compile time, OS signals, Spring Boot Actuator + Tomcat MBeans), and reorganize the panel into a KPI tile row + four drill-down tabs (Memory / Threads / JVM internals / App) with the existing class histogram anchored at the bottom.

**Architecture:** The bundled `media/agent/rcm-monitor.jar` (Java + Maven, source in `monitor-agent/`) gains additional MBean reads on the existing 1 s tick, two new background loops (5 s for thread states + top-by-CPU, 10 s for Actuator/Tomcat), a JMX `GarbageCollectionNotificationInfo` listener that emits per-collection `gc` events, and a stdin `thread-dump <tid>` / `set-log-level <name> <level>` protocol. The `MonitoringService` parses the new message types into per-config state. The `MonitorView` webview is restructured: existing chart on top, six health-tinted KPI tiles below it, four tabs (Memory / Threads / JVM internals / App) for drill-downs, class histogram anchored at the bottom across all tabs.

**Tech Stack:** TypeScript on the extension + webview side; Java + Maven for the agent jar; existing React + SVG for charts (no new chart library); existing newline-delimited JSON wire format.

**Spec reference:** Implements `docs/superpowers/specs/2026-05-13-jvm-monitor-extended-insights-design.md`.

---

## File map

**New files:**

| File | Responsibility |
|---|---|
| `src/services/monitoring/healthThresholds.ts` | Pure helper: maps each KPI tile's value to `'ok' \| 'warn' \| 'critical'` per the spec's threshold table. |
| `src/services/monitoring/poolCategories.ts` | Pure helper: maps a JVM-reported pool name (e.g. `"G1 Eden Space"`) to one of `'young' \| 'survivor' \| 'old' \| 'metaspace' \| 'codeCache' \| 'other'`. |
| `webview/src/monitor/KpiTile.tsx` | Generic colored KPI tile component used six times in the header row. |
| `webview/src/monitor/MemoryTab.tsx` | Memory tab body — pools breakdown bars, GC timeline, off-heap buffers chart, allocation rate. |
| `webview/src/monitor/ThreadsTab.tsx` | Threads tab body — state donut, count history, top-by-CPU table with on-demand stack-trace expand, deadlock banner. |
| `webview/src/monitor/JvmInternalsTab.tsx` | JVM internals tab body — runtime info, class-loading + JIT + OS cards, collapsible JVM args / system properties / environment lists. |
| `webview/src/monitor/AppTab.tsx` | App tab body — Actuator / Tomcat data, log-level changer, "no source detected" empty state. |
| `webview/src/monitor/GcTimeline.tsx` | SVG strip rendering GC events on a 60 s time axis with hover tooltip. |
| `webview/src/monitor/StateDonut.tsx` | SVG conic donut for thread state distribution. |
| `webview/src/monitor/PoolsBars.tsx` | Stacked horizontal bars for memory-pool usage. |
| `test/healthThresholds.test.ts` | Unit tests for the threshold mapper. |
| `test/poolCategories.test.ts` | Unit tests for the pool-name → category mapper. |

**Modified files:**

| File | Change |
|---|---|
| `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java` | Extend `MetricsLoop` with pool / buffer / class-loading / JIT / FD / OS reads. Add GC notification listener emitting `gc` events. New `ThreadsLoop` (5 s) and `ActuatorLoop` (10 s). New `runtime` message at startup. New stdin commands `thread-dump <tid>`, `set-log-level <name> <level>`. |
| `media/agent/rcm-monitor.jar` | Rebuilt jar (committed). |
| `src/services/monitoring/AgentMessage.ts` | Extend `MetricsTick` with new fields (pools, buffers, class loading, JIT, FDs, OS). Add `GcEvent`, `ThreadsSnapshot`, `ActuatorSnapshot`, `RuntimeInfo`, `ThreadDump`, `LogLevelChanged` message types. |
| `src/services/MonitoringService.ts` | Extend `MonitoringState` with new slots. Extend `applyMessage` with new cases. Add `requestThreadDump`, `setLogLevel` methods. Add `gcEvents` ring buffer (60 s window). |
| `src/ui/MonitorPanel.ts` | Push the new state shapes (runtime info, threads, actuator, gc events) to the webview on each tick. |
| `src/shared/protocol.ts` | New webview messages: `monitor.gc`, `monitor.threads`, `monitor.actuator`, `monitor.runtime`, `monitor.threadDump`, `monitor.logLevelChanged`, plus webview-outbound `monitor.requestThreadDump`, `monitor.setLogLevel`. |
| `webview/src/MonitorView.tsx` | Reorganize: chart → KPI row → tabs → histogram (anchored). Wire tabs + click-to-tab from tiles. Move existing analytics grid into Memory + JVM internals tabs. |

## Conventions used throughout

- Steps are verbatim. **No commits** — user directive across the session ("DO NOT COMMIT" applies to every task).
- Test framework is Jest; mocks via `jest.spyOn` on `child_process` / `net` (existing pattern).
- All new TypeScript exports include a one-line JSDoc comment per the project's existing style.
- Agent: source committed; rebuilt with `cd monitor-agent && /opt/maven/apache-maven-3.9.11/bin/mvn package -q` and committed jar copied to `media/agent/rcm-monitor.jar` (one-time build per source change).
- Wire-format invariant: Java agent JSON shape and `AgentMessage.ts` types must match exactly — every change to one is paired with the other in the same task.
- Jest tests live in `test/`. The webview/ tree has tsconfig isolation but no separate test config — its components are tested through extension-side jest with the existing `tsconfig.extension.json` allowing `webview/**/*` files where they appear in test imports (existing pattern in `webview/src/MonitorView.tsx` already imports `../../src/services/monitoring/parseClassHistogram`).
- All new agent reads are wrapped in per-tick try/catch — a single MBean failure must not break the loop. Existing `MetricsLoop` already does this.

---

## Task 1: Pool-category mapper

**Files:**
- Create: `src/services/monitoring/poolCategories.ts`
- Create: `test/poolCategories.test.ts`

Maps JVM-reported pool names (e.g. `"G1 Eden Space"`, `"PS Old Gen"`, `"Metaspace"`) to canonical buckets the UI renders. Pure function, runs in both webview and extension.

- [ ] **Step 1: Write the failing test**

Create `test/poolCategories.test.ts`:

```ts
import { categorizePool, type PoolCategory } from '../src/services/monitoring/poolCategories';

describe('categorizePool', () => {
  test.each<[string, PoolCategory]>([
    ['G1 Eden Space', 'young'],
    ['PS Eden Space', 'young'],
    ['Eden Space', 'young'],
    ['G1 Survivor Space', 'survivor'],
    ['PS Survivor Space', 'survivor'],
    ['G1 Old Gen', 'old'],
    ['PS Old Gen', 'old'],
    ['Tenured Gen', 'old'],
    ['Metaspace', 'metaspace'],
    ['Compressed Class Space', 'metaspace'],
    ["CodeHeap 'non-nmethods'", 'codeCache'],
    ["CodeHeap 'profiled nmethods'", 'codeCache'],
    ["CodeHeap 'non-profiled nmethods'", 'codeCache'],
    ['Code Cache', 'codeCache'],
    ['Some Future Pool', 'other'],
  ])('%s → %s', (name, expected) => {
    expect(categorizePool(name)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern poolCategories 2>&1 | tail -10`
Expected: import error.

- [ ] **Step 3: Implement**

Create `src/services/monitoring/poolCategories.ts`:

```ts
// Canonical buckets the UI renders for memory-pool breakdown. The JVM
// reports pool names that vary across collectors (G1 / Parallel /
// Serial / ZGC / Shenandoah) and JDK versions, so we normalize.
export type PoolCategory = 'young' | 'survivor' | 'old' | 'metaspace' | 'codeCache' | 'other';

// Maps the JVM's reported pool name to a canonical category. Unknown
// names land in 'other' so they show up but stay unlabeled — better
// than hiding data we don't recognize.
export function categorizePool(name: string): PoolCategory {
  const n = name.toLowerCase();
  if (n.includes('eden')) return 'young';
  if (n.includes('survivor')) return 'survivor';
  if (n.includes('old gen') || n.includes('tenured')) return 'old';
  if (n.includes('metaspace') || n.includes('compressed class')) return 'metaspace';
  if (n.includes('codeheap') || n.includes('code cache')) return 'codeCache';
  return 'other';
}
```

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern poolCategories 2>&1 | tail -10`
Expected: all rows pass.

DO NOT COMMIT.

---

## Task 2: Health-threshold mapper

**Files:**
- Create: `src/services/monitoring/healthThresholds.ts`
- Create: `test/healthThresholds.test.ts`

Pure helper that converts a tile's raw value (or pair of values) into `'ok' | 'warn' | 'critical'` per the spec's threshold table.

- [ ] **Step 1: Write the failing test**

Create `test/healthThresholds.test.ts`:

```ts
import {
  heapStatus,
  gcPauseStatus,
  cpuStatus,
  threadsStatus,
  offHeapStatus,
  fdStatus,
  type HealthStatus,
} from '../src/services/monitoring/healthThresholds';

describe('healthThresholds', () => {
  describe('heapStatus', () => {
    test.each<[number, number, HealthStatus]>([
      [100, 1000, 'ok'],   // 10%
      [700, 1000, 'warn'], // 70%
      [800, 1000, 'warn'], // 80%
      [900, 1000, 'critical'],
      [950, 1000, 'critical'],
      [100, -1,   'ok'],   // unbounded heap
    ])('%i / %i → %s', (used, max, expected) => {
      expect(heapStatus(used, max)).toBe(expected);
    });
  });

  describe('gcPauseStatus', () => {
    test.each<[number, HealthStatus]>([
      [0, 'ok'],
      [50, 'ok'],
      [100, 'warn'],
      [400, 'warn'],
      [500, 'critical'],
      [1500, 'critical'],
    ])('%i ms → %s', (totalMs, expected) => {
      expect(gcPauseStatus(totalMs)).toBe(expected);
    });
  });

  describe('cpuStatus', () => {
    test.each<[number, HealthStatus]>([
      [0,    'ok'],
      [0.5,  'ok'],
      [0.7,  'warn'],
      [0.85, 'warn'],
      [0.9,  'critical'],
      [-1,   'ok'],     // -1 means "not available"
    ])('%f → %s', (load, expected) => {
      expect(cpuStatus(load)).toBe(expected);
    });
  });

  describe('threadsStatus', () => {
    test('ok when no BLOCKED, no deadlock', () => {
      expect(threadsStatus(0, false)).toBe('ok');
    });
    test('warn when BLOCKED > 0', () => {
      expect(threadsStatus(3, false)).toBe('warn');
    });
    test('critical on deadlock', () => {
      expect(threadsStatus(0, true)).toBe('critical');
      expect(threadsStatus(3, true)).toBe('critical');
    });
  });

  describe('offHeapStatus', () => {
    test('ok when off-heap < 2× heapMax', () => {
      expect(offHeapStatus(100, 1000)).toBe('ok');
    });
    test('warn when off-heap >= 2× heapMax', () => {
      expect(offHeapStatus(2000, 1000)).toBe('warn');
    });
    test('critical when off-heap >= 4× heapMax', () => {
      expect(offHeapStatus(4000, 1000)).toBe('critical');
    });
    test('ok when heapMax unknown (-1)', () => {
      expect(offHeapStatus(1_000_000_000, -1)).toBe('ok');
    });
  });

  describe('fdStatus', () => {
    test.each<[number, number, HealthStatus]>([
      [10,  100, 'ok'],
      [50,  100, 'warn'],
      [60,  100, 'warn'],
      [80,  100, 'critical'],
      [10,  -1,  'ok'],
    ])('%i / %i → %s', (open, max, expected) => {
      expect(fdStatus(open, max)).toBe(expected);
    });
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern healthThresholds 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/services/monitoring/healthThresholds.ts`:

```ts
// Status of a KPI tile derived from the spec's threshold table. The UI
// uses this to tint the tile background and pick its border color.
// 'ok' → green, 'warn' → yellow, 'critical' → red.
export type HealthStatus = 'ok' | 'warn' | 'critical';

// Heap: 70% warn, 90% critical. heapMax === -1 means unbounded — we
// can't compute a fraction, so render as ok.
export function heapStatus(used: number, max: number): HealthStatus {
  if (max <= 0) return 'ok';
  const ratio = used / max;
  if (ratio >= 0.9) return 'critical';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

// Cumulative GC pause time in the last 60s. 100ms warn, 500ms critical.
export function gcPauseStatus(totalMs: number): HealthStatus {
  if (totalMs >= 500) return 'critical';
  if (totalMs >= 100) return 'warn';
  return 'ok';
}

// Process CPU load. Negative input means "not available" — render ok.
// 70% warn, 90% critical.
export function cpuStatus(load: number): HealthStatus {
  if (load < 0) return 'ok';
  if (load >= 0.9) return 'critical';
  if (load >= 0.7) return 'warn';
  return 'ok';
}

// Threads tile: warn when any BLOCKED threads, critical on deadlock.
export function threadsStatus(blockedCount: number, deadlocked: boolean): HealthStatus {
  if (deadlocked) return 'critical';
  if (blockedCount > 0) return 'warn';
  return 'ok';
}

// Off-heap (direct + mapped buffers) compared against heapMax.
// 2× heapMax warn, 4× heapMax critical. Skip when heapMax unknown.
export function offHeapStatus(offHeapBytes: number, heapMax: number): HealthStatus {
  if (heapMax <= 0) return 'ok';
  if (offHeapBytes >= 4 * heapMax) return 'critical';
  if (offHeapBytes >= 2 * heapMax) return 'warn';
  return 'ok';
}

// Open file descriptors. 50% warn, 80% critical.
export function fdStatus(open: number, max: number): HealthStatus {
  if (max <= 0) return 'ok';
  const ratio = open / max;
  if (ratio >= 0.8) return 'critical';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}
```

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern healthThresholds 2>&1 | tail -10`
Expected: all subtests pass.

DO NOT COMMIT.

---

## Task 3: Extend AgentMessage types

**Files:**
- Modify: `src/services/monitoring/AgentMessage.ts`

Add the new wire-format types so subsequent tasks can refer to them. No tests — pure type definitions verified by typecheck.

- [ ] **Step 1: Replace the file**

Replace the contents of `src/services/monitoring/AgentMessage.ts` with:

```ts
// Wire format produced by the bundled monitoring agent
// (`media/agent/rcm-monitor.jar`). One JSON document per line on the
// agent's stdout. Mirrors the agent's hand-rolled JSON in
// `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java` —
// changes to one MUST be reflected in the other.

export interface PoolUsage {
  used: number;       // bytes
  committed: number;
  max: number;        // -1 if undefined
}

export interface BufferStats {
  count: number;
  memoryUsed: number;     // bytes
  totalCapacity: number;  // bytes
}

export interface MetricsTick {
  type: 'metrics';
  // Wall-clock ms since epoch (System.currentTimeMillis on the agent).
  t: number;
  heapUsed: number;
  heapCommitted: number;
  heapMax: number;        // -1 if undefined (unbounded heap)
  nonHeapUsed: number;
  // ProcessCpuLoad — fraction in [0, 1]. -1 when JMX returns "not
  // available" (rare; some JVMs / OSes hide it).
  cpuLoad: number;
  threadCount: number;
  // Aggregate across all GC beans — sum of collection counts and
  // collection time in ms.
  gcCount: number;
  gcTime: number;
  // NEW — additional cheap reads that piggyback on the 1 s tick.
  pools?: Record<string, PoolUsage>;
  directBuffer?: BufferStats;
  mappedBuffer?: BufferStats;
  loadedClasses?: number;
  totalLoadedClasses?: number;
  unloadedClasses?: number;
  compileTimeMs?: number;
  openFds?: number;          // -1 when JMX doesn't expose it (Windows)
  maxFds?: number;           // -1 same
  systemLoad?: number;        // -1 when not available
  freePhysicalMemory?: number;
  totalPhysicalMemory?: number;
  freeSwap?: number;
}

export interface HistogramRow {
  instances: number;
  bytes: number;
  className: string;
}

export interface HistogramSnapshot {
  type: 'histogram';
  t: number;
  rows: HistogramRow[]; // top 200 by retained bytes
}

// Per-collection event from the JMX GarbageCollectionNotificationInfo
// listener. Emitted each time a GC completes — in real time, not
// aggregated.
export interface GcEvent {
  type: 'gc';
  t: number;
  collector: string;     // e.g. "G1 Young Generation"
  duration: number;      // ms
  cause: string;         // e.g. "G1 Evacuation Pause"
  action: string;        // e.g. "end of minor GC"
  totalCount: number;
  totalTime: number;
}

export interface ThreadInfo {
  id: number;
  name: string;
  state: string;         // RUNNABLE / BLOCKED / WAITING / TIMED_WAITING / NEW / TERMINATED
  cpuTimeNs: number;
  cpuDeltaNs: number;
  stackSnippet: string[];  // top 5 frames
}

export interface DeadlockInfo {
  threadIds: number[];
  names: string[];
  summary: string;
}

export interface ThreadsSnapshot {
  type: 'threads';
  t: number;
  states: Record<string, number>;     // STATE → count
  topByCpu: ThreadInfo[];
  deadlock: DeadlockInfo | null;
}

export interface ActuatorEndpointStat {
  uri: string;
  method: string;
  count: number;
  p99Ms: number;
  errorRate: number;     // fraction in [0, 1]
}

export interface ActuatorLogger {
  name: string;
  configured: string | null;
  effective: string;
}

export interface ActuatorTomcat {
  currentThreadsBusy: number;
  maxThreads: number;
  requestCount: number;
  errorCount: number;
}

export interface ActuatorSnapshot {
  type: 'actuator';
  t: number;
  available: boolean;
  baseUrl?: string;          // present when available
  reason?: string;            // present when !available
  health?: { status: string; components: Record<string, string> };
  metrics?: {
    http_requests_total: number;
    http_request_duration_p50_ms: number;
    http_request_duration_p95_ms: number;
    http_request_duration_p99_ms: number;
  };
  topEndpoints?: ActuatorEndpointStat[];
  loggers?: ActuatorLogger[];
  tomcat?: ActuatorTomcat | null;
}

// Static info read once on JMX connect. Sent as the very first message
// after metrics start so the JVM internals tab populates immediately.
export interface RuntimeInfo {
  type: 'runtime';
  t: number;
  vendor: string;
  vmName: string;
  version: string;
  pid: number;
  startTime: number;
  inputArgs: string[];
  systemProperties: Record<string, string>;
  environment: Record<string, string>;
}

export interface ThreadDump {
  type: 'threadDump';
  t: number;
  tid: number;
  name: string;
  state: string;
  stack: string[];      // full stack
}

export interface LogLevelChanged {
  type: 'logLevelChanged';
  t: number;
  name: string;
  level: string;
  ok: boolean;
  errorMessage?: string;
}

export interface DumpComplete {
  type: 'dumpComplete';
  path: string;
}

export interface AgentError {
  type: 'error';
  message: string;
}

export type AgentMessage =
  | MetricsTick
  | HistogramSnapshot
  | GcEvent
  | ThreadsSnapshot
  | ActuatorSnapshot
  | RuntimeInfo
  | ThreadDump
  | LogLevelChanged
  | DumpComplete
  | AgentError;
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

- [ ] **Step 3: Run full suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Expected: all tests still pass (existing `MonitoringService.test.ts` uses `MetricsTick` shape — the new fields are optional so legacy assertions still hold).

DO NOT COMMIT.

---

## Task 4: Extend agent — tier-1 reads (memory pools, buffers, class loading, JIT, FDs, OS)

**Files:**
- Modify: `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java`
- Modify: `media/agent/rcm-monitor.jar` (rebuilt)

Add new MBean reads inside the existing `MetricsLoop`, all on the 1-second tick. Each new field is wrapped in its own try/catch so any single MBean failure doesn't break the tick.

- [ ] **Step 1: Read the current Monitor.java**

Read the existing file at `/git/run-config-manager/monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java` to understand the `MetricsLoop` shape, then make targeted edits.

- [ ] **Step 2: Add imports**

At the top of `Monitor.java`, after the existing import block, add:

```java
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.ClassLoadingMXBean;
import java.lang.management.CompilationMXBean;
import java.lang.management.RuntimeMXBean;
import java.lang.management.BufferPoolMXBean;
```

- [ ] **Step 3: Hoist new proxies in MetricsLoop.run() — before the while-loop**

Find the section in `MetricsLoop.run()` where `MemoryMXBean memory = ...`, `OperatingSystemMXBean os = ...` etc. are created (the same place where `gcBeans` is hoisted, per the recent fix). Add additional proxies + bean queries right after them:

```java
ClassLoadingMXBean classLoading = ManagementFactory.newPlatformMXBeanProxy(
  mbsc, "java.lang:type=ClassLoading", ClassLoadingMXBean.class);
CompilationMXBean compilation;
try {
  compilation = ManagementFactory.newPlatformMXBeanProxy(
    mbsc, "java.lang:type=Compilation", CompilationMXBean.class);
} catch (Exception ignored) {
  compilation = null;
}
java.util.List<MemoryPoolMXBean> poolBeans = new java.util.ArrayList<>();
for (ObjectName pn : mbsc.queryNames(new ObjectName("java.lang:type=MemoryPool,*"), null)) {
  poolBeans.add(ManagementFactory.newPlatformMXBeanProxy(mbsc, pn.toString(), MemoryPoolMXBean.class));
}
java.util.List<BufferPoolMXBean> bufferBeans = new java.util.ArrayList<>();
for (ObjectName pn : mbsc.queryNames(new ObjectName("java.nio:type=BufferPool,*"), null)) {
  bufferBeans.add(ManagementFactory.newPlatformMXBeanProxy(mbsc, pn.toString(), BufferPoolMXBean.class));
}
```

- [ ] **Step 4: Build the per-tick metrics line with new fields**

Inside the `try { ... }` block of the per-tick body in `MetricsLoop.run()`, replace the existing single-line `System.out.println(String.format(...))` with a builder pattern that accumulates new fields:

```java
StringBuilder mb = new StringBuilder();
mb.append("{\"type\":\"metrics\",\"t\":").append(t)
  .append(",\"heapUsed\":").append(heapUsed)
  .append(",\"heapCommitted\":").append(heapCommitted)
  .append(",\"heapMax\":").append(heapMax)
  .append(",\"nonHeapUsed\":").append(nonHeapUsed)
  .append(",\"cpuLoad\":").append(String.format("%.4f", cpuLoad))
  .append(",\"threadCount\":").append(threadCount)
  .append(",\"gcCount\":").append(gcCount)
  .append(",\"gcTime\":").append(gcTime);

// Memory pools
try {
  mb.append(",\"pools\":{");
  boolean firstPool = true;
  for (MemoryPoolMXBean pool : poolBeans) {
    java.lang.management.MemoryUsage usage;
    try { usage = pool.getUsage(); } catch (Exception e) { continue; }
    if (usage == null) continue;
    if (!firstPool) mb.append(',');
    mb.append('"').append(jsonEscape(pool.getName())).append("\":{")
      .append("\"used\":").append(usage.getUsed())
      .append(",\"committed\":").append(usage.getCommitted())
      .append(",\"max\":").append(usage.getMax())
      .append('}');
    firstPool = false;
  }
  mb.append('}');
} catch (Exception ignored) {}

// Direct + mapped buffers
try {
  for (BufferPoolMXBean bp : bufferBeans) {
    String key;
    if ("direct".equalsIgnoreCase(bp.getName())) key = "directBuffer";
    else if ("mapped".equalsIgnoreCase(bp.getName())) key = "mappedBuffer";
    else continue;
    mb.append(",\"").append(key).append("\":{")
      .append("\"count\":").append(bp.getCount())
      .append(",\"memoryUsed\":").append(bp.getMemoryUsed())
      .append(",\"totalCapacity\":").append(bp.getTotalCapacity())
      .append('}');
  }
} catch (Exception ignored) {}

// Class loading
try {
  mb.append(",\"loadedClasses\":").append(classLoading.getLoadedClassCount())
    .append(",\"totalLoadedClasses\":").append(classLoading.getTotalLoadedClassCount())
    .append(",\"unloadedClasses\":").append(classLoading.getUnloadedClassCount());
} catch (Exception ignored) {}

// JIT compile time
try {
  if (compilation != null && compilation.isCompilationTimeMonitoringSupported()) {
    mb.append(",\"compileTimeMs\":").append(compilation.getTotalCompilationTime());
  }
} catch (Exception ignored) {}

// File descriptors via com.sun.management.UnixOperatingSystemMXBean attrs
try {
  Object oFd = mbsc.getAttribute(osName, "OpenFileDescriptorCount");
  Object mFd = mbsc.getAttribute(osName, "MaxFileDescriptorCount");
  if (oFd instanceof Number) mb.append(",\"openFds\":").append(((Number) oFd).longValue());
  if (mFd instanceof Number) mb.append(",\"maxFds\":").append(((Number) mFd).longValue());
} catch (Exception ignored) {
  // Windows JVMs don't expose these — that's fine.
}

// System load + free physical / total physical / free swap
try {
  Object load = mbsc.getAttribute(osName, "SystemLoadAverage");
  if (load instanceof Number) mb.append(",\"systemLoad\":").append(String.format("%.4f", ((Number) load).doubleValue()));
} catch (Exception ignored) {}
try {
  Object fpm = mbsc.getAttribute(osName, "FreePhysicalMemorySize");
  Object tpm = mbsc.getAttribute(osName, "TotalPhysicalMemorySize");
  Object fsw = mbsc.getAttribute(osName, "FreeSwapSpaceSize");
  if (fpm instanceof Number) mb.append(",\"freePhysicalMemory\":").append(((Number) fpm).longValue());
  if (tpm instanceof Number) mb.append(",\"totalPhysicalMemory\":").append(((Number) tpm).longValue());
  if (fsw instanceof Number) mb.append(",\"freeSwap\":").append(((Number) fsw).longValue());
} catch (Exception ignored) {}

mb.append('}');
System.out.println(mb.toString());
System.out.flush();
```

The existing `osName` ObjectName already exists in the loop. The new local `t` variable is the existing `System.currentTimeMillis()` call — reuse it. Sanitize NaN per the existing fix already in place (`if (Double.isNaN(cpuLoad) ...)`).

- [ ] **Step 5: Rebuild the jar**

```bash
cd /git/run-config-manager/monitor-agent
/opt/maven/apache-maven-3.9.11/bin/mvn package -q
cp target/rcm-monitor.jar ../media/agent/rcm-monitor.jar
ls -la ../media/agent/rcm-monitor.jar
```

Expected: build succeeds, jar size grows modestly (still < 20 KB).

- [ ] **Step 6: Run extension tests + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: both clean.

DO NOT COMMIT.

---

## Task 5: Extend agent — GC notification listener

**Files:**
- Modify: `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java`
- Modify: `media/agent/rcm-monitor.jar` (rebuilt)

Register a JMX `NotificationListener` against each GC bean that emits a `gc` JSON line per collection with cause + duration + action.

- [ ] **Step 1: Add imports**

At the top of `Monitor.java`, add:

```java
import javax.management.Notification;
import javax.management.NotificationListener;
import com.sun.management.GarbageCollectionNotificationInfo;
import javax.management.openmbean.CompositeData;
```

- [ ] **Step 2: Register the listener at startup**

In `main()`, after the metrics + histogram threads are started but before the stdin loop, add:

```java
// Subscribe to per-collection GC events. The notification fires after
// each collection completes — gives us cause, action, and the actual
// duration. Polling getCollectionTime() can only show cumulative time.
for (ObjectName gcName : mbsc.queryNames(new ObjectName("java.lang:type=GarbageCollector,*"), null)) {
  try {
    mbsc.addNotificationListener(gcName, new GcEventListener(), null, null);
  } catch (Exception e) {
    err("could not subscribe to GC notifications for " + gcName + ": " + e.getMessage());
  }
}
```

- [ ] **Step 3: Add the listener inner class**

Inside the `Monitor` class (place near the other inner classes), add:

```java
private static class GcEventListener implements NotificationListener {
  public void handleNotification(Notification notification, Object handback) {
    if (!GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION
        .equals(notification.getType())) return;
    try {
      GarbageCollectionNotificationInfo info = GarbageCollectionNotificationInfo.from(
        (CompositeData) notification.getUserData());
      long duration = info.getGcInfo().getDuration();
      long endTime = System.currentTimeMillis();
      System.out.println(String.format(
        "{\"type\":\"gc\",\"t\":%d,\"collector\":\"%s\",\"duration\":%d," +
        "\"cause\":\"%s\",\"action\":\"%s\",\"totalCount\":%d,\"totalTime\":%d}",
        endTime,
        jsonEscape(info.getGcName()),
        duration,
        jsonEscape(info.getGcCause()),
        jsonEscape(info.getGcAction()),
        info.getGcInfo().getId(),     // collection sequence id
        info.getGcInfo().getDuration() // duration is per-event; cumulative is in metrics
      ));
      System.out.flush();
    } catch (Exception e) {
      err("gc notification handler failed: " + e.getMessage());
    }
  }
}
```

- [ ] **Step 4: Rebuild the jar**

```bash
cd /git/run-config-manager/monitor-agent
/opt/maven/apache-maven-3.9.11/bin/mvn package -q
cp target/rcm-monitor.jar ../media/agent/rcm-monitor.jar
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: both clean.

DO NOT COMMIT.

---

## Task 6: Extend agent — ThreadsLoop (5 s)

**Files:**
- Modify: `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java`
- Modify: `media/agent/rcm-monitor.jar` (rebuilt)

Add a third background thread emitting one `threads` JSON line every 5 s with state distribution, top-by-CPU, and deadlock check.

- [ ] **Step 1: Add the inner class**

Add inside the `Monitor` class:

```java
private static class ThreadsLoop implements Runnable {
  final MBeanServerConnection mbsc;
  final int intervalMs;
  // Map<tid, lastCpuTime> for delta computation across ticks.
  final java.util.Map<Long, Long> lastCpuTime = new java.util.HashMap<>();
  ThreadsLoop(MBeanServerConnection m, int i) { this.mbsc = m; this.intervalMs = i; }

  public void run() {
    try {
      java.lang.management.ThreadMXBean threads = ManagementFactory.newPlatformMXBeanProxy(
        mbsc, "java.lang:type=Threading", java.lang.management.ThreadMXBean.class);
      // Enable CPU time tracking if supported.
      try {
        if (threads.isThreadCpuTimeSupported() && !threads.isThreadCpuTimeEnabled()) {
          threads.setThreadCpuTimeEnabled(true);
        }
      } catch (Exception ignored) {}

      while (true) {
        try {
          long t = System.currentTimeMillis();
          long[] tids = threads.getAllThreadIds();
          // Per-thread CPU + state. We sort by delta-cpu since last tick.
          java.util.Map<String, Integer> stateCounts = new java.util.HashMap<>();
          java.util.List<long[]> threadCpus = new java.util.ArrayList<>(); // [tid, deltaNs, totalNs]
          for (long tid : tids) {
            java.lang.management.ThreadInfo ti = threads.getThreadInfo(tid, 0);
            if (ti == null) continue;
            String state = ti.getThreadState().name();
            stateCounts.merge(state, 1, Integer::sum);
            long total = -1;
            try { total = threads.getThreadCpuTime(tid); } catch (Exception ignored) {}
            if (total < 0) continue;
            Long prev = lastCpuTime.get(tid);
            long delta = prev == null ? 0 : Math.max(0, total - prev);
            lastCpuTime.put(tid, total);
            threadCpus.add(new long[]{ tid, delta, total });
          }
          // Drop dead-thread entries from our cache.
          java.util.Set<Long> alive = new java.util.HashSet<>();
          for (long tid : tids) alive.add(tid);
          lastCpuTime.keySet().retainAll(alive);

          // Top 10 by delta.
          threadCpus.sort((a, b) -> Long.compare(b[1], a[1]));
          int topN = Math.min(10, threadCpus.size());
          StringBuilder topJson = new StringBuilder("[");
          for (int i = 0; i < topN; i++) {
            long[] row = threadCpus.get(i);
            java.lang.management.ThreadInfo ti = threads.getThreadInfo(row[0], 5);
            if (ti == null) continue;
            if (i > 0) topJson.append(',');
            topJson.append("{\"id\":").append(row[0])
                   .append(",\"name\":\"").append(jsonEscape(ti.getThreadName())).append('"')
                   .append(",\"state\":\"").append(ti.getThreadState().name()).append('"')
                   .append(",\"cpuTimeNs\":").append(row[2])
                   .append(",\"cpuDeltaNs\":").append(row[1])
                   .append(",\"stackSnippet\":[");
            StackTraceElement[] st = ti.getStackTrace();
            for (int s = 0; s < st.length; s++) {
              if (s > 0) topJson.append(',');
              topJson.append('"').append(jsonEscape(st[s].toString())).append('"');
            }
            topJson.append("]}");
          }
          topJson.append(']');

          // States JSON.
          StringBuilder statesJson = new StringBuilder("{");
          boolean firstState = true;
          for (java.util.Map.Entry<String, Integer> e : stateCounts.entrySet()) {
            if (!firstState) statesJson.append(',');
            statesJson.append('"').append(e.getKey()).append("\":").append(e.getValue());
            firstState = false;
          }
          statesJson.append('}');

          // Deadlock detection.
          String deadlockJson = "null";
          try {
            long[] deadlocked = threads.findDeadlockedThreads();
            if (deadlocked != null && deadlocked.length > 0) {
              StringBuilder names = new StringBuilder("[");
              StringBuilder ids = new StringBuilder("[");
              for (int i = 0; i < deadlocked.length; i++) {
                if (i > 0) { names.append(','); ids.append(','); }
                java.lang.management.ThreadInfo ti = threads.getThreadInfo(deadlocked[i], 0);
                names.append('"').append(jsonEscape(ti != null ? ti.getThreadName() : ("tid-" + deadlocked[i]))).append('"');
                ids.append(deadlocked[i]);
              }
              names.append(']');
              ids.append(']');
              deadlockJson = String.format(
                "{\"threadIds\":%s,\"names\":%s,\"summary\":\"%d threads deadlocked\"}",
                ids, names, deadlocked.length);
            }
          } catch (Exception ignored) {}

          System.out.println(String.format(
            "{\"type\":\"threads\",\"t\":%d,\"states\":%s,\"topByCpu\":%s,\"deadlock\":%s}",
            t, statesJson, topJson, deadlockJson));
          System.out.flush();
        } catch (Exception e) {
          err("threads tick failed: " + e.getMessage());
        }
        Thread.sleep(intervalMs);
      }
    } catch (Exception e) {
      err("threads loop failed: " + e.getMessage());
    }
  }
}
```

- [ ] **Step 2: Start the thread in main()**

In `main()`, alongside the existing `mt` and `ht` thread-start block, add:

```java
Thread tt = new Thread(new ThreadsLoop(mbsc, 5_000), "rcm-threads");
tt.setDaemon(true);
tt.start();
```

- [ ] **Step 3: Rebuild the jar**

```bash
cd /git/run-config-manager/monitor-agent
/opt/maven/apache-maven-3.9.11/bin/mvn package -q
cp target/rcm-monitor.jar ../media/agent/rcm-monitor.jar
```

- [ ] **Step 4: Verify**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 7: Extend agent — RuntimeInfo + ActuatorLoop + on-demand commands

**Files:**
- Modify: `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java`
- Modify: `media/agent/rcm-monitor.jar` (rebuilt)

Three additions in one task:
1. Emit a `runtime` message once at startup (vendor / version / args / system properties / environment).
2. Add a 10 s `ActuatorLoop` that auto-detects Spring Boot Actuator + Tomcat MBeans and emits an `actuator` message.
3. Extend the stdin command parser with `thread-dump <tid>` and `set-log-level <name> <level>`.

- [ ] **Step 1: Emit RuntimeInfo at startup**

Add a private static method to the `Monitor` class:

```java
private static void emitRuntimeInfo(MBeanServerConnection mbsc) {
  try {
    RuntimeMXBean rt = ManagementFactory.newPlatformMXBeanProxy(
      mbsc, "java.lang:type=Runtime", RuntimeMXBean.class);
    StringBuilder mb = new StringBuilder();
    mb.append("{\"type\":\"runtime\",\"t\":").append(System.currentTimeMillis())
      .append(",\"vendor\":\"").append(jsonEscape(rt.getVmVendor())).append('"')
      .append(",\"vmName\":\"").append(jsonEscape(rt.getVmName())).append('"')
      .append(",\"version\":\"").append(jsonEscape(rt.getVmVersion())).append('"')
      .append(",\"pid\":").append(parsePid(rt.getName()))
      .append(",\"startTime\":").append(rt.getStartTime())
      .append(",\"inputArgs\":[");
    boolean first = true;
    for (String a : rt.getInputArguments()) {
      if (!first) mb.append(',');
      mb.append('"').append(jsonEscape(a)).append('"');
      first = false;
    }
    mb.append("],\"systemProperties\":{");
    first = true;
    for (java.util.Map.Entry<String, String> e : rt.getSystemProperties().entrySet()) {
      if (!first) mb.append(',');
      mb.append('"').append(jsonEscape(e.getKey())).append("\":\"")
        .append(jsonEscape(e.getValue())).append('"');
      first = false;
    }
    mb.append("},\"environment\":{");
    // Environment is process-local on the agent side; read from the
    // target via System.getenv would be wrong. Use System.getenv() of
    // the agent itself — this is informational only and the agent
    // typically inherits its parent's env. Document the caveat.
    first = true;
    for (java.util.Map.Entry<String, String> e : System.getenv().entrySet()) {
      if (!first) mb.append(',');
      mb.append('"').append(jsonEscape(e.getKey())).append("\":\"")
        .append(jsonEscape(e.getValue())).append('"');
      first = false;
    }
    mb.append("}}");
    System.out.println(mb.toString());
    System.out.flush();
  } catch (Exception e) {
    err("runtime info emission failed: " + e.getMessage());
  }
}

private static long parsePid(String runtimeName) {
  // Format is "pid@host". Parse defensively.
  int at = runtimeName.indexOf('@');
  if (at <= 0) return -1;
  try { return Long.parseLong(runtimeName.substring(0, at)); } catch (Exception ignored) { return -1; }
}
```

In `main()`, before starting the metrics / histogram / threads threads, call:

```java
emitRuntimeInfo(mbsc);
```

- [ ] **Step 2: Add ActuatorLoop**

Add this inner class to `Monitor`:

```java
private static class ActuatorLoop implements Runnable {
  final MBeanServerConnection mbsc;
  final int intervalMs;
  String baseUrl = null;
  long lastAttempt = 0;
  boolean unavailableEmitted = false;
  ActuatorLoop(MBeanServerConnection m, int i) { this.mbsc = m; this.intervalMs = i; }

  public void run() {
    try { Thread.sleep(2_000); } catch (InterruptedException ignored) {}
    while (true) {
      try {
        if (baseUrl == null) {
          long now = System.currentTimeMillis();
          // Retry probe at startup, then every 60s if still missing.
          if (!unavailableEmitted || now - lastAttempt > 60_000) {
            baseUrl = probeActuator();
            lastAttempt = now;
            if (baseUrl == null) {
              if (!unavailableEmitted) {
                System.out.println(String.format(
                  "{\"type\":\"actuator\",\"t\":%d,\"available\":false,\"reason\":\"no actuator endpoint at known ports\"}",
                  System.currentTimeMillis()));
                System.out.flush();
                unavailableEmitted = true;
              }
            }
          }
        }
        if (baseUrl != null) {
          emitActuatorSnapshot(baseUrl);
        }
      } catch (Exception e) {
        err("actuator tick failed: " + e.getMessage());
      }
      Thread.sleep(intervalMs);
    }
  }

  // Tries server.port from -D args, then 8080.
  private String probeActuator() {
    java.util.Set<Integer> candidates = new java.util.LinkedHashSet<>();
    try {
      RuntimeMXBean rt = ManagementFactory.newPlatformMXBeanProxy(
        mbsc, "java.lang:type=Runtime", RuntimeMXBean.class);
      for (String a : rt.getInputArguments()) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
          "-D(?:management\\.server\\.port|server\\.port)=(\\d+)").matcher(a);
        if (m.find()) candidates.add(Integer.parseInt(m.group(1)));
      }
    } catch (Exception ignored) {}
    candidates.add(8080);
    candidates.add(8081);
    for (int port : candidates) {
      String base = "http://localhost:" + port + "/actuator";
      try {
        java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
          new java.net.URL(base).openConnection();
        conn.setConnectTimeout(500);
        conn.setReadTimeout(500);
        if (conn.getResponseCode() == 200) return base;
      } catch (Exception ignored) {}
    }
    return null;
  }

  private void emitActuatorSnapshot(String base) {
    try {
      String health = httpGet(base + "/health");
      String metricsList = httpGet(base + "/metrics");
      String reqCount = readMetric(base, "http.server.requests");
      String tomcatJson = readTomcatMBeans();
      StringBuilder mb = new StringBuilder();
      mb.append("{\"type\":\"actuator\",\"t\":").append(System.currentTimeMillis())
        .append(",\"available\":true,\"baseUrl\":\"").append(jsonEscape(base)).append('"');
      if (health != null) mb.append(",\"health\":").append(health);
      if (reqCount != null) mb.append(",\"metrics\":").append(reqCount);
      if (tomcatJson != null) mb.append(",\"tomcat\":").append(tomcatJson);
      mb.append('}');
      System.out.println(mb.toString());
      System.out.flush();
    } catch (Exception e) {
      err("actuator emit failed: " + e.getMessage());
    }
  }

  private String httpGet(String url) {
    try {
      java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
        new java.net.URL(url).openConnection();
      conn.setConnectTimeout(1_000);
      conn.setReadTimeout(2_000);
      if (conn.getResponseCode() != 200) return null;
      try (java.io.BufferedReader r = new java.io.BufferedReader(
          new java.io.InputStreamReader(conn.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        return sb.toString();
      }
    } catch (Exception e) {
      return null;
    }
  }

  private String readMetric(String base, String name) {
    String body = httpGet(base + "/metrics/" + name);
    if (body == null) return null;
    // Cheap value extractor — we want the first "value" field. Real
    // parser would be nicer but we avoid a JSON dep on the agent.
    long total = 0;
    java.util.regex.Matcher m = java.util.regex.Pattern.compile(
      "\"statistic\":\"COUNT\",\"value\":(\\d+(?:\\.\\d+)?)").matcher(body);
    if (m.find()) total = (long) Double.parseDouble(m.group(1));
    return String.format(
      "{\"http_requests_total\":%d,\"http_request_duration_p50_ms\":0," +
      "\"http_request_duration_p95_ms\":0,\"http_request_duration_p99_ms\":0}", total);
  }

  private String readTomcatMBeans() {
    try {
      java.util.Set<ObjectName> tps = mbsc.queryNames(new ObjectName("Catalina:type=ThreadPool,*"), null);
      if (tps.isEmpty()) return null;
      ObjectName tp = tps.iterator().next();
      Object busy = mbsc.getAttribute(tp, "currentThreadsBusy");
      Object max = mbsc.getAttribute(tp, "maxThreads");
      java.util.Set<ObjectName> grp = mbsc.queryNames(new ObjectName("Catalina:type=GlobalRequestProcessor,*"), null);
      long requestCount = 0, errorCount = 0;
      for (ObjectName g : grp) {
        Object rc = mbsc.getAttribute(g, "requestCount");
        Object ec = mbsc.getAttribute(g, "errorCount");
        if (rc instanceof Number) requestCount += ((Number) rc).longValue();
        if (ec instanceof Number) errorCount += ((Number) ec).longValue();
      }
      return String.format(
        "{\"currentThreadsBusy\":%d,\"maxThreads\":%d,\"requestCount\":%d,\"errorCount\":%d}",
        ((Number) busy).intValue(), ((Number) max).intValue(), requestCount, errorCount);
    } catch (Exception e) {
      return null;
    }
  }
}
```

In `main()`, alongside the threads loop start:

```java
Thread at = new Thread(new ActuatorLoop(mbsc, 10_000), "rcm-actuator");
at.setDaemon(true);
at.start();
```

- [ ] **Step 3: Add stdin commands**

In the existing stdin command-parsing loop in `main()`, add cases:

```java
} else if (line.startsWith("thread-dump ")) {
  String tidStr = line.substring("thread-dump ".length()).trim();
  try {
    long tid = Long.parseLong(tidStr);
    handleThreadDump(mbsc, tid);
  } catch (NumberFormatException e) {
    err("thread-dump requires a numeric tid");
  }
} else if (line.startsWith("set-log-level ")) {
  String[] parts = line.substring("set-log-level ".length()).trim().split("\\s+", 2);
  if (parts.length != 2) {
    err("set-log-level requires <name> <level>");
  } else {
    handleSetLogLevel(parts[0], parts[1]);
  }
}
```

Add these helper methods:

```java
private static void handleThreadDump(MBeanServerConnection mbsc, long tid) {
  try {
    java.lang.management.ThreadMXBean threads = ManagementFactory.newPlatformMXBeanProxy(
      mbsc, "java.lang:type=Threading", java.lang.management.ThreadMXBean.class);
    java.lang.management.ThreadInfo ti = threads.getThreadInfo(tid, Integer.MAX_VALUE);
    if (ti == null) {
      err("thread " + tid + " not found");
      return;
    }
    StringBuilder mb = new StringBuilder();
    mb.append("{\"type\":\"threadDump\",\"t\":").append(System.currentTimeMillis())
      .append(",\"tid\":").append(tid)
      .append(",\"name\":\"").append(jsonEscape(ti.getThreadName())).append('"')
      .append(",\"state\":\"").append(ti.getThreadState().name()).append('"')
      .append(",\"stack\":[");
    StackTraceElement[] st = ti.getStackTrace();
    for (int i = 0; i < st.length; i++) {
      if (i > 0) mb.append(',');
      mb.append('"').append(jsonEscape(st[i].toString())).append('"');
    }
    mb.append("]}");
    System.out.println(mb.toString());
    System.out.flush();
  } catch (Exception e) {
    err("thread-dump failed: " + e.getMessage());
  }
}

// Stores the actuator base URL once probed so set-log-level works
// without re-detecting. Pull from a static field updated by ActuatorLoop.
private static volatile String actuatorBaseUrl = null;

private static void handleSetLogLevel(String name, String level) {
  if (actuatorBaseUrl == null) {
    System.out.println(String.format(
      "{\"type\":\"logLevelChanged\",\"t\":%d,\"name\":\"%s\",\"level\":\"%s\",\"ok\":false," +
      "\"errorMessage\":\"actuator not available\"}",
      System.currentTimeMillis(), jsonEscape(name), jsonEscape(level)));
    System.out.flush();
    return;
  }
  try {
    java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
      new java.net.URL(actuatorBaseUrl + "/loggers/" + java.net.URLEncoder.encode(name, "UTF-8"))
        .openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json");
    conn.setDoOutput(true);
    String body = String.format("{\"configuredLevel\":\"%s\"}", jsonEscape(level));
    conn.getOutputStream().write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    int code = conn.getResponseCode();
    boolean ok = code >= 200 && code < 300;
    System.out.println(String.format(
      "{\"type\":\"logLevelChanged\",\"t\":%d,\"name\":\"%s\",\"level\":\"%s\",\"ok\":%s," +
      "\"errorMessage\":\"%s\"}",
      System.currentTimeMillis(), jsonEscape(name), jsonEscape(level), ok,
      ok ? "" : ("HTTP " + code)));
    System.out.flush();
  } catch (Exception e) {
    System.out.println(String.format(
      "{\"type\":\"logLevelChanged\",\"t\":%d,\"name\":\"%s\",\"level\":\"%s\",\"ok\":false," +
      "\"errorMessage\":\"%s\"}",
      System.currentTimeMillis(), jsonEscape(name), jsonEscape(level), jsonEscape(e.getMessage())));
    System.out.flush();
  }
}
```

In `ActuatorLoop.probeActuator()`, after a successful detection, also set the static: `actuatorBaseUrl = base;` (replace `return base;` with two lines).

- [ ] **Step 4: Rebuild the jar**

```bash
cd /git/run-config-manager/monitor-agent
/opt/maven/apache-maven-3.9.11/bin/mvn package -q
cp target/rcm-monitor.jar ../media/agent/rcm-monitor.jar
```

- [ ] **Step 5: Run extension tests + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 8: Extend MonitoringService with new state slots + handlers

**Files:**
- Modify: `src/services/MonitoringService.ts`
- Modify: `test/MonitoringService.test.ts`

Add per-config state for the new data, parse the new message types, expose `requestThreadDump` and `setLogLevel`, and keep a 60 s ring buffer of GC events.

- [ ] **Step 1: Add tests for the new message types**

Append to `test/MonitoringService.test.ts` (inside the existing `describe('MonitoringService', ...)` block, after the last `test`):

```ts
  test('parses gc events and keeps last 60s', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    const now = Date.now();
    // Two events 30s apart, both within 60s of now → kept.
    child.stdout.emit('data', Buffer.from(
      `{"type":"gc","t":${now - 30000},"collector":"G1 Young Generation","duration":12,"cause":"Allocation Failure","action":"end of minor GC","totalCount":1,"totalTime":12}\n`,
    ));
    child.stdout.emit('data', Buffer.from(
      `{"type":"gc","t":${now},"collector":"G1 Young Generation","duration":8,"cause":"Allocation Failure","action":"end of minor GC","totalCount":2,"totalTime":20}\n`,
    ));
    // Old event > 60s → dropped on next prune.
    child.stdout.emit('data', Buffer.from(
      `{"type":"gc","t":${now - 70000},"collector":"G1 Young Generation","duration":5,"cause":"Allocation Failure","action":"end of minor GC","totalCount":3,"totalTime":25}\n`,
    ));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.gcEvents.length).toBe(2);
    expect(state.gcEvents[0].duration).toBe(12);
    expect(state.gcEvents[1].duration).toBe(8);
  });

  test('parses threads message into threadsDetail', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    child.stdout.emit('data', Buffer.from(
      '{"type":"threads","t":1,"states":{"RUNNABLE":2,"WAITING":1},"topByCpu":[{"id":1,"name":"main","state":"RUNNABLE","cpuTimeNs":100,"cpuDeltaNs":50,"stackSnippet":["a.b.C.foo(C.java:1)"]}],"deadlock":null}\n',
    ));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.threadsDetail).not.toBeNull();
    expect(state.threadsDetail!.states.RUNNABLE).toBe(2);
    expect(state.threadsDetail!.topByCpu[0].name).toBe('main');
  });

  test('parses runtime info into runtime field', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    child.stdout.emit('data', Buffer.from(
      '{"type":"runtime","t":1,"vendor":"Eclipse Adoptium","vmName":"OpenJDK 64-Bit Server VM","version":"17.0.9+9","pid":12345,"startTime":0,"inputArgs":["-Xmx2g"],"systemProperties":{"java.version":"17.0.9"},"environment":{}}\n',
    ));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.runtime).not.toBeNull();
    expect(state.runtime!.vendor).toBe('Eclipse Adoptium');
    expect(state.runtime!.inputArgs).toEqual(['-Xmx2g']);
  });

  test('requestThreadDump writes thread-dump <tid> to stdin and resolves on matching reply', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    const promise = svc.requestThreadDump('cfg-id', 42);
    expect(child.stdin.write).toHaveBeenCalledWith('thread-dump 42\n');
    child.stdout.emit('data', Buffer.from(
      '{"type":"threadDump","t":1,"tid":42,"name":"worker","state":"RUNNABLE","stack":["a.b.C.x(C.java:1)"]}\n',
    ));
    await new Promise(r => setImmediate(r));
    const dump = await promise;
    expect(dump.tid).toBe(42);
    expect(dump.name).toBe('worker');
  });

  test('setLogLevel writes set-log-level command and resolves on logLevelChanged', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    const promise = svc.setLogLevel('cfg-id', 'ROOT', 'DEBUG');
    expect(child.stdin.write).toHaveBeenCalledWith('set-log-level ROOT DEBUG\n');
    child.stdout.emit('data', Buffer.from(
      '{"type":"logLevelChanged","t":1,"name":"ROOT","level":"DEBUG","ok":true}\n',
    ));
    await new Promise(r => setImmediate(r));
    await expect(promise).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run; expect new tests to fail**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern MonitoringService 2>&1 | tail -20`
Expected: 5 new tests fail, 8 existing tests pass.

- [ ] **Step 3: Extend MonitoringService.ts**

Open `src/services/MonitoringService.ts` and apply:

a) Update the imports at the top:

```ts
import type {
  AgentMessage,
  MetricsTick,
  HistogramSnapshot,
  GcEvent,
  ThreadsSnapshot,
  ActuatorSnapshot,
  RuntimeInfo,
  ThreadDump,
} from './monitoring/AgentMessage';
```

b) Extend `MonitoringState`:

```ts
export interface MonitoringState {
  configId: string;
  pid: number;
  jmxPort: number;
  startTime: number;
  status: 'connecting' | 'live' | 'lost';
  history: MetricsTick[];
  histogram: HistogramSnapshot | null;
  // NEW
  gcEvents: GcEvent[];               // ring buffer, last 60s
  threadsDetail: ThreadsSnapshot | null;
  actuator: ActuatorSnapshot | null;
  runtime: RuntimeInfo | null;
}

const HISTORY_CAP = 60;
const GC_RETENTION_MS = 60_000;
```

c) Extend `Entry` (private interface at the bottom of the file):

```ts
interface Entry {
  configId: string;
  pid: number;
  jmxPort: number;
  startTime: number;
  status: 'connecting' | 'live' | 'lost';
  history: MetricsTick[];
  histogram: HistogramSnapshot | null;
  gcEvents: GcEvent[];
  threadsDetail: ThreadsSnapshot | null;
  actuator: ActuatorSnapshot | null;
  runtime: RuntimeInfo | null;
  child: cp.ChildProcess;
  stdoutBuf: string;
  pendingDumps: Array<{
    targetPath: string;
    resolve: (path: string) => void;
    reject: (err: Error) => void;
  }>;
  pendingThreadDumps: Array<{
    tid: number;
    resolve: (d: ThreadDump) => void;
    reject: (err: Error) => void;
  }>;
  pendingLogLevels: Array<{
    name: string;
    level: string;
    resolve: () => void;
    reject: (err: Error) => void;
  }>;
}
```

d) In `attach()`, where the `entry` object is constructed, add the new slots:

```ts
const entry: Entry = {
  configId,
  pid,
  jmxPort,
  startTime: Date.now(),
  status: 'connecting',
  history: [],
  histogram: null,
  gcEvents: [],
  threadsDetail: null,
  actuator: null,
  runtime: null,
  child,
  stdoutBuf: '',
  pendingDumps: [],
  pendingThreadDumps: [],
  pendingLogLevels: [],
};
```

e) Update `state()` to expose the new fields:

```ts
state(configId: string): MonitoringState | undefined {
  const entry = this.entries.get(configId);
  if (!entry) return undefined;
  return {
    configId: entry.configId,
    pid: entry.pid,
    jmxPort: entry.jmxPort,
    startTime: entry.startTime,
    status: entry.status,
    history: entry.history,
    histogram: entry.histogram,
    gcEvents: entry.gcEvents,
    threadsDetail: entry.threadsDetail,
    actuator: entry.actuator,
    runtime: entry.runtime,
  };
}
```

f) Add `requestThreadDump` and `setLogLevel` methods:

```ts
requestThreadDump(configId: string, tid: number): Promise<ThreadDump> {
  const entry = this.entries.get(configId);
  if (!entry) return Promise.reject(new Error(`No monitored config: ${configId}`));
  return new Promise((resolve, reject) => {
    entry.pendingThreadDumps.push({ tid, resolve, reject });
    try {
      entry.child.stdin?.write(`thread-dump ${tid}\n`);
    } catch (e) {
      reject(e as Error);
    }
  });
}

setLogLevel(configId: string, name: string, level: string): Promise<void> {
  const entry = this.entries.get(configId);
  if (!entry) return Promise.reject(new Error(`No monitored config: ${configId}`));
  return new Promise((resolve, reject) => {
    entry.pendingLogLevels.push({ name, level, resolve, reject });
    try {
      entry.child.stdin?.write(`set-log-level ${name} ${level}\n`);
    } catch (e) {
      reject(e as Error);
    }
  });
}
```

g) Extend `applyMessage` with new cases — replace the existing switch with:

```ts
private applyMessage(entry: Entry, msg: AgentMessage): void {
  switch (msg.type) {
    case 'metrics':
      if (entry.status === 'connecting') entry.status = 'live';
      entry.history.push(msg);
      if (entry.history.length > HISTORY_CAP) entry.history.shift();
      this.emitter.fire(entry.configId);
      return;
    case 'histogram':
      entry.histogram = msg;
      this.emitter.fire(entry.configId);
      return;
    case 'gc': {
      const cutoff = Date.now() - GC_RETENTION_MS;
      entry.gcEvents.push(msg);
      // Drop events outside the retention window.
      while (entry.gcEvents.length && entry.gcEvents[0].t < cutoff) entry.gcEvents.shift();
      this.emitter.fire(entry.configId);
      return;
    }
    case 'threads':
      entry.threadsDetail = msg;
      this.emitter.fire(entry.configId);
      return;
    case 'actuator':
      entry.actuator = msg;
      this.emitter.fire(entry.configId);
      return;
    case 'runtime':
      entry.runtime = msg;
      this.emitter.fire(entry.configId);
      return;
    case 'threadDump': {
      const idx = entry.pendingThreadDumps.findIndex(d => d.tid === msg.tid);
      if (idx >= 0) {
        const [pending] = entry.pendingThreadDumps.splice(idx, 1);
        pending.resolve(msg);
      }
      return;
    }
    case 'logLevelChanged': {
      const idx = entry.pendingLogLevels.findIndex(p => p.name === msg.name && p.level === msg.level);
      if (idx >= 0) {
        const [pending] = entry.pendingLogLevels.splice(idx, 1);
        if (msg.ok) pending.resolve();
        else pending.reject(new Error(msg.errorMessage ?? 'set-log-level failed'));
      }
      return;
    }
    case 'dumpComplete': {
      const idx = entry.pendingDumps.findIndex(d => d.targetPath === msg.path);
      if (idx >= 0) {
        const [d] = entry.pendingDumps.splice(idx, 1);
        d.resolve(msg.path);
      }
      return;
    }
    case 'error':
      log.warn(`monitor[${entry.configId}] agent error: ${msg.message}`);
      entry.status = 'lost';
      for (const d of entry.pendingDumps) d.reject(new Error(msg.message));
      for (const d of entry.pendingThreadDumps) d.reject(new Error(msg.message));
      for (const d of entry.pendingLogLevels) d.reject(new Error(msg.message));
      entry.pendingDumps = [];
      entry.pendingThreadDumps = [];
      entry.pendingLogLevels = [];
      this.emitter.fire(entry.configId);
      return;
  }
}
```

h) In `detach()`, also reject pending thread dumps + log levels (mirroring the existing pendingDumps rejection):

Find the existing rejection-on-detach block (added in a prior task):

```ts
for (const d of entry.pendingDumps) d.reject(new Error('detached'));
entry.pendingDumps = [];
```

Add right after it:

```ts
for (const d of entry.pendingThreadDumps) d.reject(new Error('detached'));
entry.pendingThreadDumps = [];
for (const d of entry.pendingLogLevels) d.reject(new Error('detached'));
entry.pendingLogLevels = [];
```

Same for the `close` handler that already rejects pending dumps with `'agent exited'`:

```ts
for (const d of entry.pendingThreadDumps) d.reject(new Error('agent exited'));
entry.pendingThreadDumps = [];
for (const d of entry.pendingLogLevels) d.reject(new Error('agent exited'));
entry.pendingLogLevels = [];
```

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern MonitoringService 2>&1 | tail -10`
Expected: 13 tests pass (8 existing + 5 new).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: clean.

DO NOT COMMIT.

---

## Task 9: Extend protocol.ts + MonitorPanel push wiring

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/ui/MonitorPanel.ts`

Add new outbound (extension → webview) message kinds for the new data, plus inbound (webview → extension) kinds for thread-dump request and set-log-level. Wire MonitorPanel to push the new state shapes on every onChanged.

- [ ] **Step 1: Extend protocol.ts**

Open `src/shared/protocol.ts`, find the existing monitor union members and extend them.

Add to the **Outbound** (webview → extension) union:

```ts
| { cmd: 'monitor.requestThreadDump'; configId: string; tid: number }
| { cmd: 'monitor.setLogLevel'; configId: string; name: string; level: string }
```

Add to the **Inbound** (extension → webview) union:

```ts
| { cmd: 'monitor.gc'; configId: string; gc: import('../services/monitoring/AgentMessage').GcEvent }
| { cmd: 'monitor.threads'; configId: string; threads: import('../services/monitoring/AgentMessage').ThreadsSnapshot }
| { cmd: 'monitor.actuator'; configId: string; actuator: import('../services/monitoring/AgentMessage').ActuatorSnapshot }
| { cmd: 'monitor.runtime'; configId: string; runtime: import('../services/monitoring/AgentMessage').RuntimeInfo }
| { cmd: 'monitor.threadDump'; configId: string; dump: import('../services/monitoring/AgentMessage').ThreadDump }
| { cmd: 'monitor.logLevelChanged'; configId: string; name: string; level: string; ok: boolean; errorMessage?: string }
```

- [ ] **Step 2: Extend MonitorPanel.pushState**

Open `src/ui/MonitorPanel.ts`. Replace the `pushState` body with:

```ts
private pushState(): void {
  const state = this.monitoring.state(this.cfg.id);
  if (!state) return;
  if (state.history.length > 0) {
    this.panel.webview.postMessage({
      cmd: 'monitor.tick',
      configId: this.cfg.id,
      metrics: state.history[state.history.length - 1],
      startTime: state.startTime,
    });
  }
  if (state.histogram) {
    this.panel.webview.postMessage({
      cmd: 'monitor.histogram',
      configId: this.cfg.id,
      histogram: state.histogram,
    });
  }
  if (state.runtime) {
    this.panel.webview.postMessage({
      cmd: 'monitor.runtime',
      configId: this.cfg.id,
      runtime: state.runtime,
    });
  }
  if (state.threadsDetail) {
    this.panel.webview.postMessage({
      cmd: 'monitor.threads',
      configId: this.cfg.id,
      threads: state.threadsDetail,
    });
  }
  if (state.actuator) {
    this.panel.webview.postMessage({
      cmd: 'monitor.actuator',
      configId: this.cfg.id,
      actuator: state.actuator,
    });
  }
  for (const ev of state.gcEvents) {
    this.panel.webview.postMessage({
      cmd: 'monitor.gc',
      configId: this.cfg.id,
      gc: ev,
    });
  }
}
```

The webview does its own deduplication when GC events repeat (on every onChanged we push every event in the buffer; the webview keeps a `Set<t+collector>` to drop duplicates).

- [ ] **Step 3: Add message handlers for thread-dump + set-log-level**

Inside `MonitorPanel.onMessage`, after the existing `setHistogramPaused` branch, add:

```ts
if (msg?.cmd === 'monitor.requestThreadDump' && msg.configId === this.cfg.id) {
  try {
    const dump = await this.monitoring.requestThreadDump(this.cfg.id, msg.tid);
    this.panel.webview.postMessage({
      cmd: 'monitor.threadDump',
      configId: this.cfg.id,
      dump,
    });
  } catch (e) {
    this.panel.webview.postMessage({
      cmd: 'monitor.error',
      configId: this.cfg.id,
      message: (e as Error).message,
    });
  }
  return;
}
if (msg?.cmd === 'monitor.setLogLevel' && msg.configId === this.cfg.id) {
  try {
    await this.monitoring.setLogLevel(this.cfg.id, msg.name, msg.level);
    this.panel.webview.postMessage({
      cmd: 'monitor.logLevelChanged',
      configId: this.cfg.id,
      name: msg.name,
      level: msg.level,
      ok: true,
    });
  } catch (e) {
    this.panel.webview.postMessage({
      cmd: 'monitor.logLevelChanged',
      configId: this.cfg.id,
      name: msg.name,
      level: msg.level,
      ok: false,
      errorMessage: (e as Error).message,
    });
  }
  return;
}
```

- [ ] **Step 4: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Run: `cd /git/run-config-manager && npm test 2>&1 | tail -5`
Expected: clean.

DO NOT COMMIT.

---

## Task 10: KpiTile component

**Files:**
- Create: `webview/src/monitor/KpiTile.tsx`

A reusable tile rendered six times in the header row. Color-coded by `HealthStatus` from Task 2.

- [ ] **Step 1: Create the component**

Create the `webview/src/monitor` directory if it doesn't exist, then create `webview/src/monitor/KpiTile.tsx`:

```tsx
import type { HealthStatus } from '../../../src/services/monitoring/healthThresholds';

// One generic colored tile in the Monitor view's KPI row. Click bubbles
// up to MonitorView to switch tabs.
export function KpiTile({
  label,
  value,
  secondary,
  status,
  tooltip,
  onClick,
}: {
  label: string;
  value: string;
  secondary?: string;
  status: HealthStatus;
  tooltip?: string;
  onClick?: () => void;
}) {
  const palette = paletteFor(status);
  return (
    <div
      onClick={onClick}
      title={tooltip}
      style={{
        background: palette.bg,
        borderLeft: `3px solid ${palette.border}`,
        padding: 10,
        borderRadius: 3,
        color: 'var(--vscode-foreground, #d4d4d4)',
        cursor: onClick ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #aaa)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, margin: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {secondary && (
        <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #888)' }}>
          {secondary}
        </div>
      )}
    </div>
  );
}

function paletteFor(status: HealthStatus): { bg: string; border: string } {
  if (status === 'critical') {
    return { bg: 'color-mix(in srgb, #f44747 14%, transparent)', border: '#f44747' };
  }
  if (status === 'warn') {
    return { bg: 'color-mix(in srgb, #ffaa33 14%, transparent)', border: '#ffaa33' };
  }
  return { bg: 'color-mix(in srgb, #4caf50 14%, transparent)', border: '#4caf50' };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

DO NOT COMMIT.

---

## Task 11: GcTimeline component

**Files:**
- Create: `webview/src/monitor/GcTimeline.tsx`

SVG strip rendering GC events on a 60 s time axis. Each event is a vertical bar; height ∝ log(duration); color by collector category. Hover tooltip shows full info.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/GcTimeline.tsx`:

```tsx
import type { GcEvent } from '../../../src/services/monitoring/AgentMessage';

// 60s strip of GC events. Each bar is rendered at its event time; height
// uses log(duration) so a 1s pause stands out next to a 5ms one.
export function GcTimeline({ events, now }: { events: GcEvent[]; now: number }) {
  const w = 800, h = 60;
  const windowMs = 60_000;
  const xFor = (t: number) => ((t - (now - windowMs)) / windowMs) * w;
  const heightFor = (durationMs: number) => {
    const logged = Math.log10(Math.max(1, durationMs)); // 0..3 for 1..1000ms
    return Math.min(h, 8 + logged * 14);
  };
  const colorFor = (collector: string) => {
    const c = collector.toLowerCase();
    if (c.includes('young')) return 'var(--vscode-charts-green, #4caf50)';
    if (c.includes('old') || c.includes('mark')) return 'var(--vscode-charts-red, #f44747)';
    if (c.includes('major')) return 'var(--vscode-charts-red, #f44747)';
    return 'var(--vscode-charts-orange, #ffaa33)';
  };

  if (events.length === 0) {
    return (
      <div style={{ height: h, opacity: 0.6, padding: 8, fontSize: 12 }}>
        No GC events in the last 60s.
      </div>
    );
  }

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}
    >
      {events.map(ev => {
        const x = xFor(ev.t);
        const barH = heightFor(ev.duration);
        const tooltip = `${ev.collector} · ${ev.duration}ms · ${ev.cause} (${ev.action})`;
        return (
          <g key={`${ev.t}-${ev.collector}`}>
            <title>{tooltip}</title>
            <rect
              x={x - 1.5}
              y={h - barH}
              width={3}
              height={barH}
              fill={colorFor(ev.collector)}
            />
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 12: PoolsBars component

**Files:**
- Create: `webview/src/monitor/PoolsBars.tsx`

Stacked horizontal bars for memory-pool usage, grouped by category.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/PoolsBars.tsx`:

```tsx
import type { PoolUsage } from '../../../src/services/monitoring/AgentMessage';
import { categorizePool, type PoolCategory } from '../../../src/services/monitoring/poolCategories';

const CATEGORY_LABEL: Record<PoolCategory, string> = {
  young: 'Young',
  survivor: 'Survivor',
  old: 'Old',
  metaspace: 'Metaspace',
  codeCache: 'Code Cache',
  other: 'Other',
};
const CATEGORY_COLOR: Record<PoolCategory, string> = {
  young: 'var(--vscode-charts-green, #4caf50)',
  survivor: 'var(--vscode-charts-yellow, #ffaa33)',
  old: 'var(--vscode-charts-blue, #4080ff)',
  metaspace: 'var(--vscode-charts-orange, #d18616)',
  codeCache: 'var(--vscode-charts-purple, #b180d7)',
  other: 'var(--vscode-charts-foreground, #888)',
};
const CATEGORY_ORDER: PoolCategory[] = ['young', 'survivor', 'old', 'metaspace', 'codeCache', 'other'];

// Renders one row per pool category, each a horizontal bar showing
// used / committed / max with a tooltip that lists the underlying pools.
export function PoolsBars({ pools }: { pools: Record<string, PoolUsage> }) {
  const grouped = groupPools(pools);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {CATEGORY_ORDER.filter(c => grouped[c].pools.length > 0).map(category => {
        const g = grouped[category];
        const ratio = g.maxBytes > 0 ? g.usedBytes / g.maxBytes : 0;
        const barFill = `${Math.min(100, ratio * 100)}%`;
        const tooltipLines = g.pools.map(([name, u]) =>
          `${name}: ${fmtMb(u.used)} / ${fmtMb(u.committed)} (max ${u.max > 0 ? fmtMb(u.max) : '∞'})`
        );
        return (
          <div key={category} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 220px', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <div style={{ color: 'var(--vscode-descriptionForeground, #aaa)' }}>{CATEGORY_LABEL[category]}</div>
            <div
              title={tooltipLines.join('\n')}
              style={{
                position: 'relative',
                height: 16,
                background: 'var(--vscode-editorWidget-background, #2a2a2a)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: barFill,
                  height: '100%',
                  background: CATEGORY_COLOR[category],
                  opacity: 0.85,
                }}
              />
            </div>
            <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--vscode-descriptionForeground, #aaa)' }}>
              {fmtMb(g.usedBytes)} / {g.maxBytes > 0 ? fmtMb(g.maxBytes) : '∞'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function groupPools(pools: Record<string, PoolUsage>): Record<PoolCategory, { pools: Array<[string, PoolUsage]>; usedBytes: number; maxBytes: number }> {
  const out: Record<PoolCategory, { pools: Array<[string, PoolUsage]>; usedBytes: number; maxBytes: number }> = {
    young: { pools: [], usedBytes: 0, maxBytes: 0 },
    survivor: { pools: [], usedBytes: 0, maxBytes: 0 },
    old: { pools: [], usedBytes: 0, maxBytes: 0 },
    metaspace: { pools: [], usedBytes: 0, maxBytes: 0 },
    codeCache: { pools: [], usedBytes: 0, maxBytes: 0 },
    other: { pools: [], usedBytes: 0, maxBytes: 0 },
  };
  for (const [name, u] of Object.entries(pools)) {
    const cat = categorizePool(name);
    out[cat].pools.push([name, u]);
    out[cat].usedBytes += Math.max(0, u.used);
    if (u.max > 0) out[cat].maxBytes += u.max;
  }
  return out;
}

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 13: StateDonut component

**Files:**
- Create: `webview/src/monitor/StateDonut.tsx`

SVG conic donut for thread-state distribution.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/StateDonut.tsx`:

```tsx
const STATE_COLOR: Record<string, string> = {
  RUNNABLE: 'var(--vscode-charts-green, #4caf50)',
  BLOCKED: 'var(--vscode-charts-red, #f44747)',
  WAITING: 'var(--vscode-charts-blue, #4080ff)',
  TIMED_WAITING: 'var(--vscode-charts-purple, #b180d7)',
  NEW: 'var(--vscode-charts-yellow, #ffaa33)',
  TERMINATED: 'var(--vscode-descriptionForeground, #888)',
};
const STATE_ORDER = ['RUNNABLE', 'BLOCKED', 'WAITING', 'TIMED_WAITING', 'NEW', 'TERMINATED'];

// Conic-section donut chart for thread state distribution. Render as
// flat 2D ring; mid-point label = total count.
export function StateDonut({ states, size = 120 }: { states: Record<string, number>; size?: number }) {
  const total = Object.values(states).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div style={{ width: size, height: size, opacity: 0.6 }}>No threads</div>;
  }
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 4;
  const inner = r * 0.6;
  let acc = 0;
  const arcs = STATE_ORDER.filter(k => states[k] > 0).map(state => {
    const count = states[state];
    const fraction = count / total;
    const start = acc * 2 * Math.PI - Math.PI / 2;
    const end = (acc + fraction) * 2 * Math.PI - Math.PI / 2;
    acc += fraction;
    const largeArc = fraction > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const ix1 = cx + inner * Math.cos(end);
    const iy1 = cy + inner * Math.sin(end);
    const ix2 = cx + inner * Math.cos(start);
    const iy2 = cy + inner * Math.sin(start);
    const path = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
    return { state, count, path };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg width={size} height={size}>
        {arcs.map(a => (
          <path key={a.state} d={a.path} fill={STATE_COLOR[a.state] ?? STATE_COLOR.TERMINATED}>
            <title>{`${a.state}: ${a.count}`}</title>
          </path>
        ))}
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={size * 0.18} fill="var(--vscode-foreground, #d4d4d4)">
          {total}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
        {STATE_ORDER.filter(k => states[k] > 0).map(state => (
          <div key={state} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: STATE_COLOR[state] ?? STATE_COLOR.TERMINATED }} />
            <span>{state}: {states[state]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 14: MemoryTab component

**Files:**
- Create: `webview/src/monitor/MemoryTab.tsx`

Composes pools breakdown + GC timeline + off-heap chart + allocation rate.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/MemoryTab.tsx`:

```tsx
import type { MetricsTick, GcEvent } from '../../../src/services/monitoring/AgentMessage';
import { GcTimeline } from './GcTimeline';
import { PoolsBars } from './PoolsBars';

// Memory drill-down: pools breakdown bars, GC event timeline, off-heap
// (direct + mapped) chart, and a derived allocation rate.
export function MemoryTab({ history, gcEvents }: { history: MetricsTick[]; gcEvents: GcEvent[] }) {
  const last = history[history.length - 1];
  const pools = last?.pools ?? null;
  const directBytes = last?.directBuffer?.memoryUsed ?? 0;
  const mappedBytes = last?.mappedBuffer?.memoryUsed ?? 0;
  const allocRate = computeAllocRateMbPerSec(history);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Memory pools</h3>
        {pools ? <PoolsBars pools={pools} /> : <div style={{ opacity: 0.6 }}>No pool data yet.</div>}
      </section>

      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>GC timeline (last 60s)</h3>
        <GcTimeline events={gcEvents} now={Date.now()} />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Direct buffers</div>
          <div style={{ fontSize: 16 }}>{fmtMb(directBytes)}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{last?.directBuffer?.count ?? '—'} buffers</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Mapped buffers</div>
          <div style={{ fontSize: 16 }}>{fmtMb(mappedBytes)}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{last?.mappedBuffer?.count ?? '—'} buffers</div>
        </div>
      </section>

      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Allocation rate</h3>
        <div title="Estimated heap allocation rate over the visible window. Computed from positive heap-used deltas (negative deltas are GC reclaim, not allocation).">
          {allocRate === null ? '—' : `${allocRate.toFixed(1)} MB/s`}
        </div>
      </section>
    </div>
  );
}

// Sum positive heap-used deltas across the visible window, divide by
// the window length in seconds. Negative deltas (GC reclaim) are
// ignored — we want allocation, not net heap movement.
function computeAllocRateMbPerSec(history: MetricsTick[]): number | null {
  if (history.length < 2) return null;
  let alloced = 0;
  for (let i = 1; i < history.length; i++) {
    const delta = history[i].heapUsed - history[i - 1].heapUsed;
    if (delta > 0) alloced += delta;
  }
  const seconds = (history[history.length - 1].t - history[0].t) / 1000;
  if (seconds <= 0) return 0;
  return alloced / seconds / (1024 * 1024);
}

function fmtMb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 15: ThreadsTab component

**Files:**
- Create: `webview/src/monitor/ThreadsTab.tsx`

State donut + count history + top-by-CPU table with on-demand stack-trace expand + deadlock banner.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/ThreadsTab.tsx`:

```tsx
import { useState } from 'react';
import type { MetricsTick, ThreadsSnapshot, ThreadInfo, ThreadDump } from '../../../src/services/monitoring/AgentMessage';
import { StateDonut } from './StateDonut';

// Threads drill-down. The on-demand thread-dump fetch is dispatched
// through the parent via the `requestThreadDump` callback; the parent
// owns the message round-trip with the extension.
export function ThreadsTab({
  history,
  threadsDetail,
  threadDumps,
  requestThreadDump,
}: {
  history: MetricsTick[];
  threadsDetail: ThreadsSnapshot | null;
  threadDumps: Map<number, ThreadDump>;
  requestThreadDump: (tid: number) => void;
}) {
  if (!threadsDetail) {
    return <div style={{ opacity: 0.6 }}>Waiting for first thread snapshot (5s tick)…</div>;
  }
  const blockedCount = threadsDetail.states.BLOCKED ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 16 }}>
        <StateDonut states={threadsDetail.states} />
        <CountHistory history={history} />
      </section>

      {threadsDetail.deadlock && (
        <section style={{
          background: 'color-mix(in srgb, #f44747 14%, transparent)',
          border: '1px solid #f44747',
          borderRadius: 4,
          padding: 12,
          fontSize: 13,
        }}>
          <strong style={{ color: '#f44747' }}>⚠ Deadlock detected</strong>
          <div style={{ marginTop: 6 }}>
            {threadsDetail.deadlock.summary} — threads: {threadsDetail.deadlock.names.join(', ')}
          </div>
        </section>
      )}

      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>
          Top threads by CPU (last 5s) {blockedCount > 0 && <span style={{ color: '#f44747' }}>· {blockedCount} BLOCKED</span>}
        </h3>
        <TopByCpu threads={threadsDetail.topByCpu} threadDumps={threadDumps} requestThreadDump={requestThreadDump} />
      </section>
    </div>
  );
}

function CountHistory({ history }: { history: MetricsTick[] }) {
  if (history.length === 0) return null;
  const w = 300, h = 60;
  const max = Math.max(...history.map(m => m.threadCount));
  const points = history.map((m, i) => {
    const x = (i / (history.length - 1 || 1)) * w;
    const y = h - (m.threadCount / max) * h;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)', marginBottom: 4 }}>
        Thread count over visible window
      </div>
      <svg width={w} height={h} style={{ background: 'var(--vscode-editorWidget-background)' }}>
        <polyline points={points} fill="none" stroke="var(--vscode-charts-blue, #4080ff)" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function TopByCpu({
  threads,
  threadDumps,
  requestThreadDump,
}: {
  threads: ThreadInfo[];
  threadDumps: Map<number, ThreadDump>;
  requestThreadDump: (tid: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return (
    <div style={{
      fontFamily: 'var(--vscode-editor-font-family, monospace)',
      fontSize: 12,
      border: '1px solid var(--vscode-editorWidget-border, #444)',
      borderRadius: 4,
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 110px 70px 1fr',
        gap: 0,
        padding: '6px 12px',
        background: 'var(--vscode-editorWidget-background, #2a2a2a)',
        fontWeight: 600,
        fontSize: 11,
        color: 'var(--vscode-descriptionForeground, #aaa)',
      }}>
        <span>Name</span>
        <span>State</span>
        <span style={{ textAlign: 'right' }}>CPU Δ</span>
        <span>Stack snippet</span>
      </div>
      {threads.map(t => {
        const isOpen = expanded.has(t.id);
        const dump = threadDumps.get(t.id);
        return (
          <div key={t.id}>
            <div
              onClick={() => {
                setExpanded(s => {
                  const next = new Set(s);
                  if (next.has(t.id)) next.delete(t.id);
                  else { next.add(t.id); if (!dump) requestThreadDump(t.id); }
                  return next;
                });
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 110px 70px 1fr',
                gap: 0,
                padding: '4px 12px',
                cursor: 'pointer',
                borderTop: '1px solid var(--vscode-editorWidget-border, #444)',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {isOpen ? '▾ ' : '▸ '}{t.name}
              </span>
              <span style={{ color: t.state === 'BLOCKED' ? '#f44747' : 'inherit' }}>{t.state}</span>
              <span style={{ textAlign: 'right' }}>{(t.cpuDeltaNs / 1_000_000).toFixed(1)} ms</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.85 }}>
                {t.stackSnippet[0] ?? ''}
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '6px 24px', background: 'var(--vscode-editor-background)', fontSize: 11, lineHeight: 1.4 }}>
                {dump ? dump.stack.map((f, i) => <div key={i}>{f}</div>) : <div style={{ opacity: 0.6 }}>Loading stack…</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 16: JvmInternalsTab component

**Files:**
- Create: `webview/src/monitor/JvmInternalsTab.tsx`

Runtime info card + class loading / JIT / OS cards + collapsible JVM args / system properties / environment.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/JvmInternalsTab.tsx`:

```tsx
import { useState } from 'react';
import type { MetricsTick, RuntimeInfo } from '../../../src/services/monitoring/AgentMessage';

// JVM internals drill-down — vendor / version / args / class loading /
// JIT / OS signals / collapsible static info.
export function JvmInternalsTab({ runtime, history }: { runtime: RuntimeInfo | null; history: MetricsTick[] }) {
  const last = history[history.length - 1];
  const first = history[0];
  const loadedDelta = first?.loadedClasses != null && last?.loadedClasses != null
    ? last.loadedClasses - first.loadedClasses
    : null;
  const uptimeSec = runtime ? Math.floor((Date.now() - runtime.startTime) / 1000) : 0;
  const uptimeStr = `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Runtime">
          {runtime ? (
            <KeyVals rows={[
              ['Vendor', runtime.vendor],
              ['VM', runtime.vmName],
              ['Version', runtime.version],
              ['PID', String(runtime.pid)],
              ['Uptime', uptimeStr],
            ]} />
          ) : <div style={{ opacity: 0.6 }}>Reading…</div>}
        </Card>
        <Card title="Class loading">
          <KeyVals rows={[
            ['Loaded', last?.loadedClasses?.toLocaleString() ?? '—'],
            ['Total ever loaded', last?.totalLoadedClasses?.toLocaleString() ?? '—'],
            ['Unloaded', last?.unloadedClasses?.toLocaleString() ?? '—'],
            ['Δ over visible window', loadedDelta !== null ? (loadedDelta > 0 ? `+${loadedDelta} ⚠` : String(loadedDelta)) : '—'],
          ]} />
        </Card>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="JIT">
          <KeyVals rows={[
            ['Compile time', last?.compileTimeMs != null ? `${last.compileTimeMs.toLocaleString()} ms` : '—'],
          ]} />
        </Card>
        <Card title="OS">
          <KeyVals rows={[
            ['System load', last?.systemLoad != null && last.systemLoad >= 0 ? last.systemLoad.toFixed(2) : '—'],
            ['Free RAM', last?.freePhysicalMemory && last?.totalPhysicalMemory
              ? `${fmtGb(last.freePhysicalMemory)} / ${fmtGb(last.totalPhysicalMemory)}`
              : '—'],
            ['Free swap', last?.freeSwap != null ? fmtGb(last.freeSwap) : '—'],
            ['Open FDs', last?.openFds != null && last.openFds >= 0
              ? `${last.openFds.toLocaleString()} of ${last.maxFds && last.maxFds > 0 ? last.maxFds.toLocaleString() : '—'}`
              : '—'],
          ]} />
        </Card>
      </section>

      {runtime && (
        <>
          <Collapsible title={`JVM args (${runtime.inputArgs.length})`}>
            <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}>{runtime.inputArgs.join('\n')}</pre>
          </Collapsible>
          <Collapsible title={`System properties (${Object.keys(runtime.systemProperties).length})`}>
            <KeyVals rows={Object.entries(runtime.systemProperties).sort((a, b) => a[0].localeCompare(b[0]))} />
          </Collapsible>
          <Collapsible title={`Environment (${Object.keys(runtime.environment).length})`}>
            <KeyVals rows={Object.entries(runtime.environment).sort((a, b) => a[0].localeCompare(b[0]))} />
          </Collapsible>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--vscode-editorWidget-border, #444)',
      borderRadius: 4,
      padding: 10,
    }}>
      <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground, #aaa)', textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.04em' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function KeyVals({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 3, fontSize: 12 }}>
      {rows.map(([k, v]) => (
        <>
          <span key={`${k}k`} style={{ color: 'var(--vscode-descriptionForeground, #aaa)' }}>{k}</span>
          <span key={`${k}v`} style={{ fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</span>
        </>
      ))}
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4 }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: '6px 12px', cursor: 'pointer', userSelect: 'none', fontSize: 12 }}>
        {open ? '▾ ' : '▸ '}{title}
      </div>
      {open && <div style={{ padding: '0 12px 10px' }}>{children}</div>}
    </div>
  );
}

function fmtGb(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 17: AppTab component

**Files:**
- Create: `webview/src/monitor/AppTab.tsx`

Actuator + Tomcat data, log-level changer, and "no source detected" empty state.

- [ ] **Step 1: Create the component**

Create `webview/src/monitor/AppTab.tsx`:

```tsx
import { useState } from 'react';
import type { ActuatorSnapshot } from '../../../src/services/monitoring/AgentMessage';

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'];

export function AppTab({
  actuator,
  setLogLevel,
}: {
  actuator: ActuatorSnapshot | null;
  setLogLevel: (name: string, level: string) => void;
}) {
  const [filter, setFilter] = useState('');

  if (!actuator || !actuator.available) {
    return (
      <div style={{
        border: '1px dashed var(--vscode-editorWidget-border, #444)',
        borderRadius: 4,
        padding: 16,
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        <strong>No app-level source detected</strong>
        <div style={{ marginTop: 8 }}>
          The agent didn't find Spring Boot Actuator or Tomcat MBeans on this JVM.
        </div>
        <ul style={{ marginTop: 8, paddingLeft: 18 }}>
          <li>
            <strong>Spring Boot:</strong> add <code>spring-boot-starter-actuator</code> and
            expose endpoints with <code>management.endpoints.web.exposure.include=health,metrics,loggers</code>.
          </li>
          <li><strong>Tomcat:</strong> standalone Tomcat configs auto-detect via JMX.</li>
        </ul>
        <div style={{ marginTop: 8, opacity: 0.7 }}>
          The other tabs work without an app-level source.
          {actuator?.reason && <> Last probe: {actuator.reason}.</>}
        </div>
      </div>
    );
  }

  const filteredLoggers = (actuator.loggers ?? []).filter(l =>
    !filter || l.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 12 }}>
      <div style={{ opacity: 0.7 }}>
        Source: {actuator.baseUrl}
      </div>

      {actuator.metrics && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>HTTP traffic</h3>
          <div>Requests: {actuator.metrics.http_requests_total.toLocaleString()}</div>
          <div>p50: {actuator.metrics.http_request_duration_p50_ms} ms · p95: {actuator.metrics.http_request_duration_p95_ms} ms · p99: {actuator.metrics.http_request_duration_p99_ms} ms</div>
        </section>
      )}

      {actuator.tomcat && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>Tomcat</h3>
          <div>Busy threads: {actuator.tomcat.currentThreadsBusy} of {actuator.tomcat.maxThreads}</div>
          <div>Requests: {actuator.tomcat.requestCount.toLocaleString()} · Errors: {actuator.tomcat.errorCount.toLocaleString()}</div>
        </section>
      )}

      {actuator.health && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>Health</h3>
          <div>Overall: <strong style={{ color: actuator.health.status === 'UP' ? '#4caf50' : '#f44747' }}>{actuator.health.status}</strong></div>
          {Object.entries(actuator.health.components ?? {}).map(([name, status]) => (
            <div key={name}>
              <span style={{ color: status === 'UP' ? '#4caf50' : '#f44747' }}>
                {status === 'UP' ? '✓' : '✗'}
              </span> {name} — {status}
            </div>
          ))}
        </section>
      )}

      {actuator.loggers && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>Loggers ({actuator.loggers.length})</h3>
          <input
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
          />
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4 }}>
            {filteredLoggers.map(l => (
              <div key={l.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, padding: '4px 8px', alignItems: 'center', fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>
                  {l.name} <span style={{ opacity: 0.6 }}>· {l.effective}</span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {LEVELS.map(level => (
                    <button
                      key={level}
                      onClick={() => setLogLevel(l.name, level)}
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: l.effective === level ? 'var(--vscode-button-background)' : 'transparent',
                        color: l.effective === level ? 'var(--vscode-button-foreground)' : 'inherit',
                        border: '1px solid var(--vscode-button-border, #555)',
                        borderRadius: 2,
                        cursor: 'pointer',
                      }}
                    >{level}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 18: Reorganize MonitorView with KPI tiles + tabs

**Files:**
- Modify: `webview/src/MonitorView.tsx`

Replace the existing layout with: chart at top, six KPI tiles, four tabs (with anchored class histogram at the bottom). The existing analytics grid is removed (its data now lives in the tiles + Memory/JVM internals tabs). The existing histogram component is kept verbatim and rendered after the tab content.

- [ ] **Step 1: Read the current MonitorView.tsx**

Read `/git/run-config-manager/webview/src/MonitorView.tsx`. Note where the existing `MonitorView`, `ChartStrip`, `HistogramTree`, and `Row` are defined. Keep `ChartStrip`, `HistogramTree`, and `Row` unchanged — only the top-level `MonitorView` is restructured.

- [ ] **Step 2: Replace the MonitorView export**

Replace the entire `export function MonitorView(...) { ... }` body (everything between `export function MonitorView` and the `function ChartStrip` declaration that follows it) with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type {
  MetricsTick,
  HistogramSnapshot,
  HistogramRow,
  GcEvent,
  ThreadsSnapshot,
  ActuatorSnapshot,
  RuntimeInfo,
  ThreadDump,
} from '../../src/services/monitoring/AgentMessage';
import { groupByPackage, type HistogramNode } from '../../src/services/monitoring/parseClassHistogram';
import {
  heapStatus,
  gcPauseStatus,
  cpuStatus,
  threadsStatus,
  offHeapStatus,
  fdStatus,
} from '../../src/services/monitoring/healthThresholds';
import { KpiTile } from './monitor/KpiTile';
import { MemoryTab } from './monitor/MemoryTab';
import { ThreadsTab } from './monitor/ThreadsTab';
import { JvmInternalsTab } from './monitor/JvmInternalsTab';
import { AppTab } from './monitor/AppTab';

const HISTORY_CAP_BY_WINDOW: Record<string, number> = { '60s': 60, '5min': 300, '30min': 1800 };
type TabKey = 'memory' | 'threads' | 'jvm' | 'app';

declare const acquireVsCodeApi: any;
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };

export function MonitorView({
  configId,
  configName,
  ownPackage,
}: {
  configId: string;
  configName: string;
  ownPackage: string;
}) {
  const [history, setHistory] = useState<MetricsTick[]>([]);
  const [histogram, setHistogram] = useState<HistogramSnapshot | null>(null);
  const [windowKey, setWindowKey] = useState<keyof typeof HISTORY_CAP_BY_WINDOW>('60s');
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'instances' | 'bytes' | 'className'>('bytes');
  const [paused, setPaused] = useState(false);
  const [onlyOwn, setOnlyOwn] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  // New: monitor extended insight state.
  const [gcEvents, setGcEvents] = useState<GcEvent[]>([]);
  const [threadsDetail, setThreadsDetail] = useState<ThreadsSnapshot | null>(null);
  const [actuator, setActuator] = useState<ActuatorSnapshot | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [threadDumps, setThreadDumps] = useState<Map<number, ThreadDump>>(new Map());
  const [activeTab, setActiveTab] = useState<TabKey>('memory');

  useEffect(() => {
    const id = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.configId !== configId) return;
      if (msg.cmd === 'monitor.tick') {
        if (typeof msg.startTime === 'number') setStartTime(msg.startTime);
        setHistory(h => {
          const cap = HISTORY_CAP_BY_WINDOW[windowKey];
          const next = [...h, msg.metrics];
          return next.slice(-cap);
        });
      } else if (msg.cmd === 'monitor.histogram') {
        setHistogram(msg.histogram);
      } else if (msg.cmd === 'monitor.gc') {
        setGcEvents(prev => {
          const seen = new Set(prev.map(g => `${g.t}-${g.collector}`));
          const key = `${msg.gc.t}-${msg.gc.collector}`;
          if (seen.has(key)) return prev;
          const cutoff = Date.now() - 60_000;
          return [...prev, msg.gc].filter(g => g.t >= cutoff);
        });
      } else if (msg.cmd === 'monitor.threads') {
        setThreadsDetail(msg.threads);
      } else if (msg.cmd === 'monitor.actuator') {
        setActuator(msg.actuator);
      } else if (msg.cmd === 'monitor.runtime') {
        setRuntime(msg.runtime);
      } else if (msg.cmd === 'monitor.threadDump') {
        setThreadDumps(prev => {
          const next = new Map(prev);
          next.set(msg.dump.tid, msg.dump);
          return next;
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [configId, windowKey]);

  const grouped = useMemo(() => {
    if (!histogram) return [];
    let rows = histogram.rows;
    if (onlyOwn && ownPackage) {
      rows = rows.filter(r => r.className.startsWith(ownPackage + '.') || r.className === ownPackage);
    }
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter(r => r.className.toLowerCase().includes(f));
    }
    return groupByPackage(rows);
  }, [histogram, filter, onlyOwn, ownPackage]);

  const last = history[history.length - 1];
  const heapMb = last ? (last.heapUsed / (1024 * 1024)).toFixed(0) : '—';
  const heapMaxMb = last && last.heapMax > 0 ? (last.heapMax / (1024 * 1024)).toFixed(0) : '—';
  const uptime = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const offHeapBytes = (last?.directBuffer?.memoryUsed ?? 0) + (last?.mappedBuffer?.memoryUsed ?? 0);
  const gcPauseLast60s = gcEvents.reduce((s, ev) => s + ev.duration, 0);
  const blockedCount = threadsDetail?.states.BLOCKED ?? 0;
  const deadlocked = threadsDetail?.deadlock != null;
  const heapMaxRaw = last?.heapMax ?? -1;
  const heapUsedRaw = last?.heapUsed ?? 0;
  const cpuLoad = last?.cpuLoad ?? -1;
  const openFds = last?.openFds ?? -1;
  const maxFds = last?.maxFds ?? -1;

  const requestThreadDump = (tid: number) => {
    vscode.postMessage({ cmd: 'monitor.requestThreadDump', configId, tid });
  };
  const setLogLevel = (name: string, level: string) => {
    vscode.postMessage({ cmd: 'monitor.setLogLevel', configId, name, level });
  };

  return (
    <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)' }}>
      <h2 style={{ marginTop: 0 }}>{configName}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {(['60s', '5min', '30min'] as const).map(w => (
          <button key={w} onClick={() => setWindowKey(w)} style={{ fontWeight: w === windowKey ? 'bold' : 'normal' }}>{w}</button>
        ))}
        <button onClick={() => vscode.postMessage({ cmd: 'monitor.saveHeapDump', configId })}>Save heap dump</button>
        <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7, alignSelf: 'center' }}>
          Run duration: {Math.floor(uptime / 60)}m {uptime % 60}s
        </div>
      </div>

      <ChartStrip history={history} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginTop: 12, marginBottom: 12 }}>
        <KpiTile
          label="Heap" value={`${heapMb} MB`}
          secondary={heapMaxMb !== '—' ? `of ${heapMaxMb} MB` : 'unbounded'}
          status={heapStatus(heapUsedRaw, heapMaxRaw)}
          tooltip="Heap used / max. Yellow ≥ 70% · Red ≥ 90%."
          onClick={() => setActiveTab('memory')}
        />
        <KpiTile
          label="GC pause" value={`${gcPauseLast60s} ms`}
          secondary="last 60s"
          status={gcPauseStatus(gcPauseLast60s)}
          tooltip="Cumulative GC pause time over the last 60s. Yellow ≥ 100ms · Red ≥ 500ms."
          onClick={() => setActiveTab('memory')}
        />
        <KpiTile
          label="CPU" value={cpuLoad >= 0 ? `${(cpuLoad * 100).toFixed(1)}%` : 'n/a'}
          secondary={cpuLoad >= 0 ? 'process load' : 'unavailable'}
          status={cpuStatus(cpuLoad)}
          tooltip="Process CPU load. Yellow ≥ 70% · Red ≥ 90%."
          onClick={() => setActiveTab('threads')}
        />
        <KpiTile
          label="Threads" value={String(last?.threadCount ?? '—')}
          secondary={blockedCount > 0 ? `${blockedCount} BLOCKED` : (deadlocked ? 'deadlock!' : 'OK')}
          status={threadsStatus(blockedCount, deadlocked)}
          tooltip="Total threads + BLOCKED count. Yellow when BLOCKED > 0 · Red on deadlock."
          onClick={() => setActiveTab('threads')}
        />
        <KpiTile
          label="Off-heap" value={`${(offHeapBytes / (1024 * 1024)).toFixed(0)} MB`}
          secondary="direct + mapped"
          status={offHeapStatus(offHeapBytes, heapMaxRaw)}
          tooltip="Direct + mapped buffer bytes. Yellow ≥ 2× heapMax · Red ≥ 4× heapMax."
          onClick={() => setActiveTab('memory')}
        />
        <KpiTile
          label="Open FDs" value={openFds >= 0 ? openFds.toLocaleString() : '—'}
          secondary={maxFds > 0 ? `of ${maxFds.toLocaleString()}` : ''}
          status={fdStatus(openFds, maxFds)}
          tooltip="Open file descriptors / max. Yellow ≥ 50% · Red ≥ 80%."
          onClick={() => setActiveTab('jvm')}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--vscode-editorWidget-border, #444)' }}>
        {(
          [
            ['memory', 'Memory'],
            ['threads', 'Threads'],
            ['jvm', 'JVM internals'],
            ['app', 'App'],
          ] as Array<[TabKey, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            style={{
              border: 'none',
              borderBottom: activeTab === key ? '2px solid var(--vscode-focusBorder, #007acc)' : '2px solid transparent',
              background: 'transparent',
              padding: '6px 12px',
              cursor: 'pointer',
              color: activeTab === key ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
              fontWeight: activeTab === key ? 600 : 400,
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ padding: '12px 0' }}>
        {activeTab === 'memory' && <MemoryTab history={history} gcEvents={gcEvents} />}
        {activeTab === 'threads' && (
          <ThreadsTab
            history={history}
            threadsDetail={threadsDetail}
            threadDumps={threadDumps}
            requestThreadDump={requestThreadDump}
          />
        )}
        {activeTab === 'jvm' && <JvmInternalsTab runtime={runtime} history={history} />}
        {activeTab === 'app' && <AppTab actuator={actuator} setLogLevel={setLogLevel} />}
      </div>

      <hr style={{ margin: '16px 0' }} />
      <h3 style={{ marginBottom: 8 }}>Class histogram</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '50% 30% 1fr', gap: 8, marginBottom: 8 }}>
        <input
          placeholder="Filter (substring of class name)"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} style={{ width: '100%', boxSizing: 'border-box' }}>
          <option value="bytes">Sort: Bytes (desc)</option>
          <option value="instances">Sort: Instances (desc)</option>
          <option value="className">Sort: Class name (A→Z)</option>
        </select>
        <button
          onClick={() => {
            const next = !paused;
            setPaused(next);
            vscode.postMessage({ cmd: 'monitor.setHistogramPaused', configId, paused: next });
          }}
          style={{ width: '100%', boxSizing: 'border-box' }}
        >{paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}</button>
      </div>
      {ownPackage && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: '0.9em' }}>
          <input type="checkbox" checked={onlyOwn} onChange={e => setOnlyOwn(e.target.checked)} />
          Show only classes in <code style={{ padding: '0 4px' }}>{ownPackage}.*</code>
          <span style={{ opacity: 0.7 }}>(otherwise highlighted inline below)</span>
        </label>
      )}
      <HistogramTree nodes={grouped} sortBy={sortBy} ownPackage={ownPackage} />
    </div>
  );
}
```

Keep the existing `ChartStrip`, `HistogramTree`, and `Row` definitions below this `MonitorView` export — they are unchanged.

- [ ] **Step 3: Strip the duplicated MetricsTick / HistogramSnapshot / HistogramRow imports**

If the original file had its own `import type { MetricsTick, HistogramSnapshot, HistogramRow }` at the top, the new export's import covers everything — remove the duplicate block.

- [ ] **Step 4: Verify typecheck + build**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Run: `cd /git/run-config-manager && npm run build:webview 2>&1 | tail -8`
Expected: typecheck clean, webview build succeeds (the new monitor chunk size grows from ~10 KB to ~25 KB).

DO NOT COMMIT.

---

## Task 19: Final integration verification

**Files:** none.

- [ ] **Step 1: Run full test suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -8`
Expected: all tests pass (existing 877 + new 5 from MonitoringService + new 2 helper test files = 884+).

- [ ] **Step 2: Both typechecks**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors across extension + webview tsconfigs.

- [ ] **Step 3: Production build**

Run: `cd /git/run-config-manager && npm run build 2>&1 | tail -10`
Expected: clean Vite + esbuild build. Webview chunks should now show separate `MemoryTab`, `ThreadsTab`, `JvmInternalsTab`, `AppTab` modules in the build summary (or rolled into `MonitorView` chunk — either is fine).

- [ ] **Step 4: Manual smoke test**

Launch a Spring Boot app with monitoring and verify:

1. Heap chart renders + auto-scales as before.
2. KPI tile row shows six tiles, each with health-tinted background.
3. Memory tab: pools breakdown bars render with category colors; GC timeline shows event spikes when GC fires; off-heap and allocation rate values appear.
4. Threads tab: state donut renders; top-by-CPU table populates after 5 s; clicking a row fetches + shows the full stack trace.
5. JVM internals tab: runtime card shows vendor/version/uptime; class loading / JIT / OS cards populate; collapsibles for JVM args / sysprops / env work.
6. App tab on a Spring Boot app: shows source = "Spring Boot Actuator detected at …", lists loggers; clicking a level button changes it (verify in app logs). On a non-Actuator app: shows the empty-state explanation.
7. Click each KPI tile → switches to the matching tab.
8. Class histogram still works at the bottom across all tabs.
9. Save heap dump still works.
10. Stop the JVM — KPI tiles freeze, agent process exits cleanly.

DO NOT COMMIT.

---

## Self-review

**Spec coverage:**
- 8 data categories — Tasks 4 (pools, buffers, class loading, JIT, FDs, OS), 5 (GC events), 6 (threads), 7 (Actuator/Tomcat, runtime, on-demand commands).
- Layout reorganization (chart → KPI → tabs → histogram) — Task 18.
- KPI tiles with thresholds — Task 2 (logic) + Task 10 (component) + Task 18 (wiring).
- Pool category mapper — Task 1.
- Tab components — Tasks 14 (Memory), 15 (Threads), 16 (JVM internals), 17 (App).
- Sub-components — Tasks 11 (GC timeline), 12 (Pools bars), 13 (State donut).
- Service + protocol extensions — Tasks 3, 8, 9.
- Tests — Tasks 1, 2 (pure helpers); Task 8 (service lifecycle for new message types).

All spec sections covered.

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to Task N" / unresolved field references. Every code step contains complete code. Every test step contains complete test code.

**Type consistency:** `MetricsTick` extension (Task 3) → consumed by `MonitoringService.applyMessage` (Task 8) → consumed by `MonitorView` (Task 18). `GcEvent`, `ThreadsSnapshot`, `ActuatorSnapshot`, `RuntimeInfo`, `ThreadDump`, `LogLevelChanged` are defined in Task 3 and used unchanged in subsequent tasks. `HealthStatus` → `paletteFor` in Task 10 → wiring in Task 18. `PoolCategory` from Task 1 → used by `categorizePool` and the `CATEGORY_*` records in Task 12. `MonitoringState.gcEvents` field name (Task 8) is consumed correctly in `MonitorPanel.pushState` (Task 9) and `MonitorView` (Task 18).

Plan complete.
