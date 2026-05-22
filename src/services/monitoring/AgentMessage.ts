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
  // Spring Boot /actuator/health returns components as objects with at least
  // a `status` field (plus optional `details`). The TypeScript type mirrors
  // the real wire shape so AppTab can render comp.status correctly.
  health?: { status: string; components: Record<string, { status: string }> };
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
