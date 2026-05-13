import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { log } from '../utils/logger';
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

export interface MonitoringState {
  configId: string;
  // PID of the spawned shell that's running the JVM. Held for liveness
  // signals only; the agent connects via JMX, not via PID.
  pid: number;
  jmxPort: number;
  startTime: number;
  status: 'connecting' | 'live' | 'lost';
  // Ring buffer of recent metrics ticks. Capped at HISTORY_CAP entries
  // (one per second by default = 60 s of history).
  history: MetricsTick[];
  // Most recent histogram, or null until the first one arrives.
  histogram: HistogramSnapshot | null;
  // NEW
  gcEvents: GcEvent[];               // ring buffer, last 60s
  threadsDetail: ThreadsSnapshot | null;
  actuator: ActuatorSnapshot | null;
  runtime: RuntimeInfo | null;
}

const HISTORY_CAP = 60;
const GC_RETENTION_MS = 60_000;

// Holds one `Entry` per active monitored config. `attach` spawns the
// agent and pipes its stdout into the per-config ring buffer; `detach`
// kills the agent + clears state. Tree provider listens to `onChanged`
// to refresh the sparkline; the panel listens to render the chart.
export class MonitoringService {
  private entries = new Map<string, Entry>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onChanged = this.emitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  attach(configId: string, pid: number, jmxPort: number): void {
    if (this.entries.has(configId)) return; // idempotent
    const jarPath = path.join(this.extensionUri.fsPath, 'media', 'agent', 'rcm-monitor.jar');
    log.info(`MonitoringService.attach: configId=${configId} pid=${pid} jmxPort=${jmxPort} jar=${jarPath}`);
    const child = cp.spawn('java', ['-jar', jarPath, String(jmxPort)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    this.entries.set(configId, entry);

    child.stdout?.on('data', (b: Buffer) => this.handleStdout(entry, b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => log.debug(`monitor[${configId}] stderr: ${b.toString().trim()}`));
    child.on('error', e => {
      log.warn(`monitor[${configId}] spawn error: ${e.message}`);
      // Identity-check: don't mutate a successor entry if attach was
      // called again for the same id after this child died.
      if (this.entries.get(configId) !== entry) return;
      entry.status = 'lost';
      this.emitter.fire(configId);
    });
    child.on('close', code => {
      log.info(`monitor[${configId}] exited with code ${code}`);
      // Reject any pending heap dumps so callers don't hang waiting
      // for a `dumpComplete` that will never come.
      for (const d of entry.pendingDumps) d.reject(new Error('agent exited'));
      entry.pendingDumps = [];
      for (const d of entry.pendingThreadDumps) d.reject(new Error('agent exited'));
      entry.pendingThreadDumps = [];
      for (const d of entry.pendingLogLevels) d.reject(new Error('agent exited'));
      entry.pendingLogLevels = [];
      // If the entry still exists at close time AND it's still ours,
      // the JVM died but we weren't asked to detach — flag as lost.
      if (this.entries.get(configId) !== entry) return;
      entry.status = 'lost';
      this.emitter.fire(configId);
    });
  }

  detach(configId: string): void {
    const entry = this.entries.get(configId);
    if (!entry) return;
    log.info(`MonitoringService.detach: configId=${configId}`);
    // Reject any pending heap dumps before tearing down the agent.
    for (const d of entry.pendingDumps) d.reject(new Error('detached'));
    entry.pendingDumps = [];
    for (const d of entry.pendingThreadDumps) d.reject(new Error('detached'));
    entry.pendingThreadDumps = [];
    for (const d of entry.pendingLogLevels) d.reject(new Error('detached'));
    entry.pendingLogLevels = [];
    try { entry.child.stdin?.end(); } catch { /* ignore */ }
    try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { entry.child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000).unref?.();
    this.entries.delete(configId);
    this.emitter.fire(configId);
  }

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

  saveHeapDump(configId: string, targetPath: string): Promise<string> {
    const entry = this.entries.get(configId);
    if (!entry) return Promise.reject(new Error(`No monitored config: ${configId}`));
    return new Promise((resolve, reject) => {
      entry.pendingDumps.push({ targetPath, resolve, reject });
      try {
        entry.child.stdin?.write(`dump ${targetPath}\n`);
      } catch (e) {
        reject(e);
      }
    });
  }

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

  setHistogramPaused(configId: string, paused: boolean): void {
    const entry = this.entries.get(configId);
    if (!entry) return;
    try {
      entry.child.stdin?.write(paused ? 'histogram-pause\n' : 'histogram-resume\n');
    } catch { /* ignore */ }
  }

  dispose(): void {
    for (const [id] of this.entries) this.detach(id);
    this.emitter.dispose();
  }

  private handleStdout(entry: Entry, chunk: string): void {
    entry.stdoutBuf += chunk;
    let nlIdx;
    while ((nlIdx = entry.stdoutBuf.indexOf('\n')) >= 0) {
      const line = entry.stdoutBuf.slice(0, nlIdx).trim();
      entry.stdoutBuf = entry.stdoutBuf.slice(nlIdx + 1);
      if (!line) continue;
      let msg: AgentMessage;
      try {
        msg = JSON.parse(line) as AgentMessage;
      } catch {
        log.debug(`monitor[${entry.configId}] bad line: ${line.slice(0, 200)}`);
        continue;
      }
      this.applyMessage(entry, msg);
    }
  }

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
        // Prune any events older than the retention window. Out-of-order
        // arrivals (e.g. from clock skew) may sit anywhere in the array,
        // so filter rather than shift-from-front.
        entry.gcEvents = entry.gcEvents.filter(e => e.t >= cutoff);
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
}

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
