// Wire format produced by the bundled monitoring agent
// (`media/agent/rcm-monitor.jar`). One JSON document per line on the
// agent's stdout. Mirrors the agent's hand-rolled JSON in
// `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java` —
// changes to one MUST be reflected in the other.

export interface MetricsTick {
  type: 'metrics';
  // Wall-clock ms since epoch (System.currentTimeMillis on the agent).
  t: number;
  heapUsed: number;       // bytes
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

export interface DumpComplete {
  type: 'dumpComplete';
  path: string;
}

export interface AgentError {
  type: 'error';
  message: string;
}

export type AgentMessage = MetricsTick | HistogramSnapshot | DumpComplete | AgentError;
