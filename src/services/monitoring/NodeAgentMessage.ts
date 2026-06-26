// Wire format produced by the bundled Node agent
// (`media/agent/rcm-node-agent.cjs`). One JSON document per line over a
// localhost TCP socket (the extension is the listener). Mirrors the agent's
// hand-rolled JSON — changes here MUST be reflected in the agent.

export interface NodeHello {
  type: 'hello';
  t: number;
  id: string;            // RCM_MONITOR_ID echoed back
  pid: number;
  ppid: number;
  nodeVersion: string;   // process.version
  v8Version: string;     // process.versions.v8
  platform: string;
  arch: string;
  execPath: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  startTime: number;     // Date.now() at agent load
}

export interface NodeMetricsTick {
  type: 'metrics';
  t: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  heapLimit: number;     // v8.getHeapStatistics().heap_size_limit
  external: number;
  arrayBuffers: number;
  cpuPercent: number;    // 0..100-ish (can exceed 100 across cores)
  uptime: number;        // seconds
  activeHandles: number;
  activeRequests: number;
  loopLagMean: number;   // ms
  loopLagP50: number;    // ms
  loopLagP99: number;    // ms
  loopLagMax: number;    // ms
}

export interface NodeHeapSpace {
  name: string;
  size: number;
  used: number;
  available: number;
}

export interface NodeHeapSpaces {
  type: 'heapSpaces';
  t: number;
  spaces: NodeHeapSpace[];
}

export interface NodeGcEvent {
  type: 'gc';
  t: number;
  kind: string;          // 'minor' | 'major' | 'incremental' | 'weakcb' | 'unknown'
  durationMs: number;
}

export interface NodeSnapshotComplete {
  type: 'snapshotComplete';
  path: string;
}

export interface NodeAgentError {
  type: 'error';
  message: string;
}

export type NodeAgentMessage =
  | NodeHello
  | NodeMetricsTick
  | NodeHeapSpaces
  | NodeGcEvent
  | NodeSnapshotComplete
  | NodeAgentError;
