import * as vscode from 'vscode';
import * as net from 'net';
import * as path from 'path';
import { log } from '../utils/logger';
import type {
  NodeAgentMessage, NodeHello, NodeMetricsTick, NodeHeapSpaces, NodeGcEvent,
} from './monitoring/NodeAgentMessage';

export interface NodeMonitoringState {
  configId: string;
  status: 'connecting' | 'live' | 'lost';
  startTime: number;
  pid: number;
  hello: NodeHello | null;
  history: NodeMetricsTick[];
  heapSpaces: NodeHeapSpaces | null;
  gcEvents: NodeGcEvent[];
}

const HISTORY_CAP = 60;
const GC_RETENTION_MS = 60_000;

// Parallel to MonitoringService (JVM) but the data SOURCE is inverted: the
// extension listens on a localhost TCP server and the in-process Node agent
// dials back. One shared server serves all monitored Node configs; agents are
// routed to entries by the `hello.id` (RCM_MONITOR_ID).
export class NodeMonitoringService {
  private entries = new Map<string, Entry>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onChanged = this.emitter.event;
  private server: net.Server | null = null;
  private port = 0;
  private listenPromise?: Promise<number>;

  constructor(private readonly extensionUri: vscode.Uri) {}

  get agentPath(): string {
    return path.join(this.extensionUri.fsPath, 'media', 'agent', 'rcm-node-agent.cjs');
  }

  listenPort(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    if (this.listenPromise) return this.listenPromise;
    this.server = net.createServer(sock => this.onConnection(sock));
    this.server.on('error', e => log.warn(`NodeMonitoring server error: ${e.message}`));
    this.listenPromise = new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = addr && typeof addr === 'object' ? addr.port : 0;
        log.info(`NodeMonitoring listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
    return this.listenPromise;
  }

  expect(configId: string): void {
    const prev = this.entries.get(configId);
    if (prev?.socket) { try { prev.socket.destroy(); } catch { /* ignore */ } }
    this.entries.set(configId, {
      configId, status: 'connecting', startTime: Date.now(), pid: 0,
      hello: null, history: [], heapSpaces: null, gcEvents: [],
      socket: null, pendingSnapshots: [],
    });
    this.emitter.fire(configId);
  }

  state(configId: string): NodeMonitoringState | undefined {
    const e = this.entries.get(configId);
    if (!e) return undefined;
    return {
      configId: e.configId, status: e.status, startTime: e.startTime, pid: e.pid,
      hello: e.hello, history: e.history, heapSpaces: e.heapSpaces, gcEvents: e.gcEvents,
    };
  }

  saveHeapSnapshot(configId: string, targetPath: string): Promise<string> {
    const e = this.entries.get(configId);
    if (!e || !e.socket) return Promise.reject(new Error(`No connected Node agent for ${configId}`));
    return new Promise((resolve, reject) => {
      e.pendingSnapshots.push({ path: targetPath, resolve, reject });
      try { e.socket!.write(`snapshot ${targetPath}\n`); } catch (err) { reject(err as Error); }
    });
  }

  detach(configId: string): void {
    const e = this.entries.get(configId);
    if (!e) return;
    for (const p of e.pendingSnapshots) p.reject(new Error('detached'));
    e.pendingSnapshots = [];
    if (e.socket) { try { e.socket.destroy(); } catch { /* ignore */ } }
    this.entries.delete(configId);
    this.emitter.fire(configId);
  }

  dispose(): void {
    for (const [id] of this.entries) this.detach(id);
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; }
    this.emitter.dispose();
  }

  private onConnection(sock: net.Socket): void {
    let bound: Entry | null = null;
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: NodeAgentMessage;
        try { msg = JSON.parse(line) as NodeAgentMessage; } catch { continue; }
        if (!bound) {
          if (msg.type !== 'hello') continue; // ignore until identified
          const entry = this.entries.get(msg.id);
          if (!entry || entry.socket) { try { sock.destroy(); } catch { /* ignore */ } return; }
          bound = entry;
          entry.socket = sock;
          entry.hello = msg;
          entry.pid = msg.pid;
          this.emitter.fire(entry.configId);
          continue; // hello consumed
        }
        this.applyMessage(bound, msg);
      }
    });
    sock.on('error', () => { try { sock.destroy(); } catch { /* ignore */ } });
    sock.on('close', () => {
      if (bound && bound.socket === sock) {
        bound.status = 'lost';
        bound.socket = null;
        for (const p of bound.pendingSnapshots) p.reject(new Error('agent disconnected'));
        bound.pendingSnapshots = [];
        this.emitter.fire(bound.configId);
      }
    });
  }

  private applyMessage(entry: Entry, msg: NodeAgentMessage): void {
    switch (msg.type) {
      case 'metrics':
        if (entry.status === 'connecting') entry.status = 'live';
        entry.history.push(msg);
        if (entry.history.length > HISTORY_CAP) entry.history.shift();
        this.emitter.fire(entry.configId);
        return;
      case 'heapSpaces':
        entry.heapSpaces = msg;
        this.emitter.fire(entry.configId);
        return;
      case 'gc': {
        const cutoff = Date.now() - GC_RETENTION_MS;
        entry.gcEvents.push(msg);
        entry.gcEvents = entry.gcEvents.filter(e => e.t >= cutoff);
        this.emitter.fire(entry.configId);
        return;
      }
      case 'snapshotComplete': {
        const idx = entry.pendingSnapshots.findIndex(p => p.path === msg.path);
        if (idx >= 0) { const [p] = entry.pendingSnapshots.splice(idx, 1); p.resolve(msg.path); }
        return;
      }
      case 'error':
        log.warn(`nodeMonitor[${entry.configId}] agent error: ${msg.message}`);
        return;
      case 'hello':
        return; // handled at bind time
    }
  }
}

interface Entry {
  configId: string;
  status: 'connecting' | 'live' | 'lost';
  startTime: number;
  pid: number;
  hello: NodeHello | null;
  history: NodeMetricsTick[];
  heapSpaces: NodeHeapSpaces | null;
  gcEvents: NodeGcEvent[];
  socket: net.Socket | null;
  pendingSnapshots: Array<{ path: string; resolve: (p: string) => void; reject: (e: Error) => void }>;
}
