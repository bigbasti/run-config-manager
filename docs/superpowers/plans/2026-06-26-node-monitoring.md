# Node (npm) Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live, Node-native monitoring for `npm` run configurations (memory, CPU, GC, event-loop, heap snapshots), shown in a Node-specific Monitor view with no Java metrics or placeholders.

**Architecture:** A parallel `NodeMonitoringService` (the JVM `MonitoringService` is left untouched). A dependency-free in-process agent is injected via `NODE_OPTIONS=--require` and streams NDJSON back to the extension over a localhost TCP socket the extension listens on. The webview renders a separate `NodeMonitorView` chosen by a `runtime` tag.

**Tech Stack:** TypeScript, VS Code extension API, Node builtins (`net`, `v8`, `perf_hooks`), React (webview), Jest (+ in-memory `vscode` mock), esbuild/vite.

**Spec:** `docs/superpowers/specs/2026-06-26-node-monitoring-design.md`

**Conventions (read before starting):**
- DO NOT COMMIT unless the human asks. Stage only; the human reviews and commits. (Repo hard rule.)
- New optional service dependencies are added as the LAST constructor param so existing call sites/tests keep compiling.
- Run `npm run typecheck && npm test` before claiming a task done; `npm run build` before declaring shippable.
- Jest mock lives in `__mocks__/vscode.ts`; seed FS via `__writeFs`, fire watchers via `__watchers`.
- The commit steps below are written for when the human later commits; while implementing, treat "Commit" steps as "stage the listed files" (`git add ...`) unless told otherwise.

---

### Task 1: (removed)

Originally `isMonitorableNpmScript` for server-like-only gating. Dropped after the decision to offer the monitoring menu items on **all** npm configs (zero contextValue churn — see Task 10). No work here. Task numbers below are unchanged so later cross-references stay valid.

---

### Task 2: Node wire-format types

Parallel to `src/services/monitoring/AgentMessage.ts`. Shared by extension, agent, and webview. No reuse of the JVM `MetricsTick`.

**Files:**
- Create: `src/services/monitoring/NodeAgentMessage.ts`

- [ ] **Step 1: Create the wire-format module**

```ts
// src/services/monitoring/NodeAgentMessage.ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors; the file is types-only and unused so far).

- [ ] **Step 3: Commit**

```bash
git add src/services/monitoring/NodeAgentMessage.ts
git commit -m "feat(monitor): add Node agent NDJSON wire-format types"
```

---

### Task 3: The in-process Node agent

Dependency-free CommonJS, Node builtins only. MUST never throw into the host app and MUST never keep the process alive (everything `.unref()`'d).

**Files:**
- Create: `media/agent/rcm-node-agent.cjs`

- [ ] **Step 1: Write the agent**

```js
// media/agent/rcm-node-agent.cjs
'use strict';
// In-process monitoring agent. Loaded via NODE_OPTIONS=--require. Connects to
// the extension's localhost server (RCM_MONITOR_PORT) and streams NDJSON, one
// JSON document per line. Reads newline-delimited commands (`snapshot <path>`)
// from the same socket. Dependency-free. Never throws into the host app; never
// keeps the process alive (timers + socket are unref'd).
(function () {
  var PORT = parseInt(process.env.RCM_MONITOR_PORT || '', 10);
  var ID = process.env.RCM_MONITOR_ID || '';
  if (!PORT || !ID) return;

  var net, v8, perf;
  try { net = require('net'); v8 = require('v8'); perf = require('perf_hooks'); }
  catch (_) { return; }

  var startTime = Date.now();
  var socket = null, connected = false, buf = '';
  var lastCpu = process.cpuUsage(), lastCpuT = Date.now();
  var metricsTimer = null, spacesTimer = null, eld = null, gcObs = null;

  function round2(n) { return Math.round(n * 100) / 100; }
  function safe(fn, fb) { try { return fn(); } catch (_) { return fb; } }
  function send(obj) {
    if (!socket || !connected) return;
    try { socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  function shallowEnv() {
    var out = {};
    try { Object.keys(process.env).forEach(function (k) { out[k] = String(process.env[k]); }); } catch (_) {}
    return out;
  }

  function gcKind(e) {
    var k = (e.detail && e.detail.kind != null) ? e.detail.kind : e.kind;
    var C = perf.constants || {};
    if (k === C.NODE_PERFORMANCE_GC_MINOR) return 'minor';
    if (k === C.NODE_PERFORMANCE_GC_MAJOR) return 'major';
    if (k === C.NODE_PERFORMANCE_GC_INCREMENTAL) return 'incremental';
    if (k === C.NODE_PERFORMANCE_GC_WEAKCB) return 'weakcb';
    return 'unknown';
  }

  function sampleMetrics() {
    var mem = safe(function () { return process.memoryUsage(); }, {});
    var hs = safe(function () { return v8.getHeapStatistics(); }, {});
    var now = Date.now();
    var cpu = process.cpuUsage(lastCpu);
    var elapsedMs = Math.max(1, now - lastCpuT);
    lastCpu = process.cpuUsage(); lastCpuT = now;
    var cpuPercent = ((cpu.user + cpu.system) / 1000) / elapsedMs * 100;
    var lag = eld
      ? { mean: eld.mean / 1e6, p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 }
      : { mean: 0, p50: 0, p99: 0, max: 0 };
    if (eld) safe(function () { eld.reset(); });
    send({
      type: 'metrics', t: now,
      rss: mem.rss || 0, heapTotal: mem.heapTotal || 0, heapUsed: mem.heapUsed || 0,
      heapLimit: hs.heap_size_limit || 0, external: mem.external || 0, arrayBuffers: mem.arrayBuffers || 0,
      cpuPercent: round2(cpuPercent),
      uptime: safe(function () { return process.uptime(); }, 0),
      activeHandles: safe(function () { return process._getActiveHandles().length; }, 0),
      activeRequests: safe(function () { return process._getActiveRequests().length; }, 0),
      loopLagMean: round2(lag.mean), loopLagP50: round2(lag.p50),
      loopLagP99: round2(lag.p99), loopLagMax: round2(lag.max)
    });
  }

  function sampleSpaces() {
    var spaces = safe(function () { return v8.getHeapSpaceStatistics(); }, []);
    send({
      type: 'heapSpaces', t: Date.now(),
      spaces: spaces.map(function (s) {
        return { name: s.space_name, size: s.space_size, used: s.space_used_size, available: s.space_available_size };
      })
    });
  }

  function handleCommand(line) {
    var m = /^snapshot\s+(.+)$/.exec(line.trim());
    if (m) {
      var p = m[1];
      try { v8.writeHeapSnapshot(p); send({ type: 'snapshotComplete', path: p }); }
      catch (e) { send({ type: 'error', message: 'snapshot failed: ' + (e && e.message) }); }
    }
  }

  function startSampling() {
    send({
      type: 'hello', t: Date.now(), id: ID, pid: process.pid,
      ppid: safe(function () { return process.ppid; }, 0),
      nodeVersion: process.version, v8Version: (process.versions && process.versions.v8) || '',
      platform: process.platform, arch: process.arch, execPath: process.execPath,
      cwd: safe(function () { return process.cwd(); }, ''),
      argv: process.argv.slice(), env: shallowEnv(), startTime: startTime
    });
    try { eld = perf.monitorEventLoopDelay({ resolution: 20 }); eld.enable(); } catch (_) { eld = null; }
    try {
      gcObs = new perf.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          send({ type: 'gc', t: Date.now(), kind: gcKind(e), durationMs: round2(e.duration) });
        });
      });
      gcObs.observe({ entryTypes: ['gc'] });
    } catch (_) { gcObs = null; }
    metricsTimer = setInterval(sampleMetrics, 1000);
    spacesTimer = setInterval(sampleSpaces, 5000);
    if (metricsTimer.unref) metricsTimer.unref();
    if (spacesTimer.unref) spacesTimer.unref();
    sampleMetrics(); sampleSpaces();
  }

  function cleanup() {
    connected = false;
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    if (spacesTimer) { clearInterval(spacesTimer); spacesTimer = null; }
    try { if (gcObs) gcObs.disconnect(); } catch (_) {}
    try { if (eld) eld.disable(); } catch (_) {}
  }

  function connect() {
    try { socket = net.connect(PORT, '127.0.0.1'); } catch (_) { return; }
    if (socket.unref) socket.unref();
    socket.on('connect', function () { connected = true; safe(startSampling); });
    socket.on('data', function (d) {
      buf += d.toString('utf8');
      var i;
      while ((i = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line) safe(function () { handleCommand(line); });
      }
    });
    socket.on('error', cleanup);
    socket.on('close', cleanup);
  }

  connect();
})();
```

- [ ] **Step 2: Smoke-run the agent by hand against a throwaway server**

Run:
```bash
node -e "const net=require('net');const s=net.createServer(c=>c.on('data',d=>process.stdout.write(d)));s.listen(0,'127.0.0.1',()=>{const p=s.address().port;const cp=require('child_process');cp.spawn(process.execPath,['--require','./media/agent/rcm-node-agent.cjs','-e','setTimeout(()=>{},2500)'],{env:{...process.env,RCM_MONITOR_PORT:String(p),RCM_MONITOR_ID:'smoke'},stdio:'inherit'});setTimeout(()=>process.exit(0),2500);});"
```
Expected: at least one `{"type":"hello"...}` line and one or more `{"type":"metrics"...}` lines printed, then exit. (Confirms the agent loads, connects, and streams.)

- [ ] **Step 3: Commit**

```bash
git add media/agent/rcm-node-agent.cjs
git commit -m "feat(monitor): add in-process Node monitoring agent"
```

---

### Task 4: `NodeMonitoringService`

Owns the shared loopback server, per-config ring buffers, hello-routing/dedup, and heap-snapshot round-trips.

**Files:**
- Create: `src/services/NodeMonitoringService.ts`
- Test: `test/NodeMonitoringService.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/NodeMonitoringService.test.ts
import * as net from 'net';
import * as path from 'path';
import { Uri } from 'vscode';
import { NodeMonitoringService } from '../src/services/NodeMonitoringService';

const repoRoot = path.resolve(__dirname, '..');

function hello(id: string, pid = 111) {
  return JSON.stringify({ type: 'hello', t: Date.now(), id, pid, ppid: 1,
    nodeVersion: 'v20.0.0', v8Version: '11.3', platform: 'darwin', arch: 'arm64',
    execPath: '/usr/bin/node', cwd: '/app', argv: ['node', 'x'], env: {}, startTime: Date.now() }) + '\n';
}
function metrics(over: Record<string, number> = {}) {
  return JSON.stringify({ type: 'metrics', t: Date.now(), rss: 5e7, heapTotal: 2e7,
    heapUsed: 1e7, heapLimit: 2e9, external: 0, arrayBuffers: 0, cpuPercent: 3.2, uptime: 1,
    activeHandles: 4, activeRequests: 0, loopLagMean: 1, loopLagP50: 1, loopLagP99: 2, loopLagMax: 3, ...over }) + '\n';
}
function connectClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}
const tick = () => new Promise(r => setTimeout(r, 30));

describe('NodeMonitoringService', () => {
  let svc: NodeMonitoringService;
  afterEach(() => svc?.dispose());

  test('routes hello+metrics to the expecting config and goes live', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1')); c.write(metrics({ heapUsed: 12345678 }));
    await tick();
    const st = svc.state('cfg1');
    expect(st?.status).toBe('live');
    expect(st?.pid).toBe(111);
    expect(st?.history.length).toBe(1);
    expect(st?.history[0].heapUsed).toBe(12345678);
    expect(st?.hello?.nodeVersion).toBe('v20.0.0');
  });

  test('caps history at 60 ticks', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1'));
    for (let i = 0; i < 65; i++) c.write(metrics());
    await tick();
    expect(svc.state('cfg1')!.history.length).toBe(60);
  });

  test('first connection wins; a second agent for the same id is dropped', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c1 = await connectClient(port);
    c1.write(hello('cfg1', 111)); c1.write(metrics());
    await tick();
    const c2 = await connectClient(port);
    c2.write(hello('cfg1', 222)); c2.write(metrics());
    await tick();
    expect(svc.state('cfg1')!.pid).toBe(111); // still the first agent
  });

  test('detach removes state and rejects pending snapshots', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1'));
    await tick();
    const p = svc.saveHeapSnapshot('cfg1', '/tmp/x.heapsnapshot').catch(e => e.message);
    svc.detach('cfg1');
    expect(await p).toMatch(/detached/);
    expect(svc.state('cfg1')).toBeUndefined();
  });

  test('socket close flips status to lost', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1')); c.write(metrics());
    await tick();
    c.destroy();
    await tick();
    expect(svc.state('cfg1')!.status).toBe('lost');
  });

  test('agentPath points at the bundled cjs', () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    expect(svc.agentPath.endsWith(path.join('media', 'agent', 'rcm-node-agent.cjs'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest NodeMonitoringService -v`
Expected: FAIL with "Cannot find module '../src/services/NodeMonitoringService'".

- [ ] **Step 3: Implement the service**

```ts
// src/services/NodeMonitoringService.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest NodeMonitoringService -v`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/NodeMonitoringService.ts test/NodeMonitoringService.test.ts
git commit -m "feat(monitor): add NodeMonitoringService (loopback server + ring buffer)"
```

---

### Task 5: Monitor-env helper + npm `prepareLaunch` injection

Shared helper builds the three env vars (DRY between the run path and the debug path). npm `prepareLaunch` injects them when monitoring is requested.

**Files:**
- Create: `src/utils/nodeMonitorEnv.ts`
- Test: `test/nodeMonitorEnv.test.ts`
- Modify: `src/adapters/npm/NpmAdapter.ts` (the `prepareLaunch` method, lines ~233-249)
- Modify: `src/adapters/RuntimeAdapter.ts` (`PrepareContext`, add `nodeAgentPath?`)
- Test: `test/NpmAdapter.prepareLaunch.test.ts`

- [ ] **Step 1: Write the helper test**

```ts
// test/nodeMonitorEnv.test.ts
import { buildNodeMonitorEnv } from '../src/utils/nodeMonitorEnv';

describe('buildNodeMonitorEnv', () => {
  const OLD = process.env.NODE_OPTIONS;
  afterEach(() => { if (OLD === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = OLD; });

  test('sets require + port + id when no prior NODE_OPTIONS', () => {
    delete process.env.NODE_OPTIONS;
    const env = buildNodeMonitorEnv('/x/agent.cjs', 4321, 'cfg1');
    expect(env.NODE_OPTIONS).toBe('--require "/x/agent.cjs"');
    expect(env.RCM_MONITOR_PORT).toBe('4321');
    expect(env.RCM_MONITOR_ID).toBe('cfg1');
  });

  test('preserves an existing NODE_OPTIONS', () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    const env = buildNodeMonitorEnv('/x/agent.cjs', 1, 'c');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --require "/x/agent.cjs"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest nodeMonitorEnv -v`
Expected: FAIL with "Cannot find module '../src/utils/nodeMonitorEnv'".

- [ ] **Step 3: Implement the helper**

```ts
// src/utils/nodeMonitorEnv.ts
// Env vars that make the bundled Node agent load in-process and dial back to
// the extension. Shared by the run path (NpmAdapter.prepareLaunch) and the
// debug path (DebugService). NODE_OPTIONS supports quoted paths, so a path
// with spaces is safe.
export function buildNodeMonitorEnv(
  agentPath: string,
  port: number,
  configId: string,
): Record<string, string> {
  const requireFlag = `--require "${agentPath}"`;
  const existing = process.env.NODE_OPTIONS;
  return {
    NODE_OPTIONS: existing ? `${existing} ${requireFlag}` : requireFlag,
    RCM_MONITOR_PORT: String(port),
    RCM_MONITOR_ID: configId,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest nodeMonitorEnv -v`
Expected: PASS.

- [ ] **Step 5: Add `nodeAgentPath` to `PrepareContext`**

In `src/adapters/RuntimeAdapter.ts`, extend the `PrepareContext` interface (after `monitorPort?: number;`):

```ts
  monitor?: boolean;
  monitorPort?: number;
  // NEW — for Node monitoring: absolute path to the bundled in-process agent.
  // When present (npm + monitor), the npm adapter injects NODE_OPTIONS=--require.
  nodeAgentPath?: string;
```

- [ ] **Step 6: Write the npm prepareLaunch test**

```ts
// test/NpmAdapter.prepareLaunch.test.ts
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any;
function npm(): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('NpmAdapter.prepareLaunch monitoring', () => {
  const a = new NpmAdapter();

  test('no monitor env when ctx.monitor is false', async () => {
    const r = await a.prepareLaunch(npm(), folder, { debug: false });
    expect(r.env?.NODE_OPTIONS).toBeUndefined();
    expect(r.env?.RCM_MONITOR_ID).toBeUndefined();
  });

  test('injects agent env when monitor + nodeAgentPath present', async () => {
    const r = await a.prepareLaunch(npm(), folder,
      { debug: false, monitor: true, monitorPort: 5555, nodeAgentPath: '/x/agent.cjs' });
    expect(r.env?.NODE_OPTIONS).toContain('--require "/x/agent.cjs"');
    expect(r.env?.RCM_MONITOR_PORT).toBe('5555');
    expect(r.env?.RCM_MONITOR_ID).toBe('cfg1');
    expect(r.env?.FORCE_COLOR).toBe('1'); // existing behavior preserved
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx jest NpmAdapter.prepareLaunch -v`
Expected: FAIL (monitor env undefined — prepareLaunch ignores ctx today).

- [ ] **Step 8: Implement npm prepareLaunch injection**

In `src/adapters/npm/NpmAdapter.ts`, replace the `prepareLaunch` method (lines ~233-249) with:

```ts
  async prepareLaunch(
    cfg: RunConfig,
    _folder?: vscode.WorkspaceFolder,
    ctx?: PrepareContext,
  ): Promise<{ env?: Record<string, string> }> {
    const env: Record<string, string> = {
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      COLORTERM: 'truecolor',
      npm_config_color: 'always',
    };
    if (cfg.type === 'npm' && cfg.typeOptions.nodePath) {
      // Windows Node ships node.exe at the install root, not in bin/.
      const binDir = process.platform === 'win32'
        ? cfg.typeOptions.nodePath
        : path.join(cfg.typeOptions.nodePath, 'bin');
      const sep = process.platform === 'win32' ? ';' : ':';
      env.PATH = `${binDir}${sep}${process.env.PATH ?? ''}`;
    }
    // Node monitoring: inject the in-process agent. ExecutionService passes the
    // IPC server port (ctx.monitorPort) and the bundled agent path.
    if (ctx?.monitor && ctx.nodeAgentPath && ctx.monitorPort) {
      Object.assign(env, buildNodeMonitorEnv(ctx.nodeAgentPath, ctx.monitorPort, cfg.id));
    }
    return { env };
  }
```

Add the imports at the top of `NpmAdapter.ts`:

```ts
import type { PrepareContext } from '../RuntimeAdapter';
import { buildNodeMonitorEnv } from '../../utils/nodeMonitorEnv';
```

(`vscode` is already imported in this file.)

- [ ] **Step 9: Run to verify it passes**

Run: `npx jest NpmAdapter.prepareLaunch nodeMonitorEnv -v`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/utils/nodeMonitorEnv.ts test/nodeMonitorEnv.test.ts src/adapters/npm/NpmAdapter.ts src/adapters/RuntimeAdapter.ts test/NpmAdapter.prepareLaunch.test.ts
git commit -m "feat(monitor): inject Node agent env from npm prepareLaunch"
```

---

### Task 6: ExecutionService routing

Route npm + monitor to `NodeMonitoringService` instead of the JVM JMX path.

**Files:**
- Modify: `src/services/ExecutionService.ts` (ctor ~138-154; monitor-port block ~454-469; prepareLaunch ctx ~479-484; attach block ~785-809; detach sites ~1044, ~1079, ~1096, ~1128)
- Test: `test/ExecutionService.nodeMonitor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ExecutionService.nodeMonitor.test.ts
import { ExecutionService } from '../src/services/ExecutionService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any;
function npm(): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('ExecutionService Node monitoring routing', () => {
  test('npm + monitor uses nodeMonitoring (expect + listenPort), not JVM attach', async () => {
    const registry = new AdapterRegistry();
    registry.register(new NpmAdapter());

    const jvm = { attach: jest.fn(), detach: jest.fn() } as any;
    const node = {
      listenPort: jest.fn().mockResolvedValue(6123),
      agentPath: '/x/agent.cjs',
      expect: jest.fn(),
      detach: jest.fn(),
    } as any;

    // nodeMonitoring is the LAST ctor param.
    const exec = new ExecutionService(registry, jvm, undefined, undefined, node);
    await exec.run(npm(), folder, { monitor: true });

    expect(node.listenPort).toHaveBeenCalled();
    expect(node.expect).toHaveBeenCalledWith('cfg1');
    expect(jvm.attach).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest ExecutionService.nodeMonitor -v`
Expected: FAIL — `new ExecutionService(...)` rejects the 5th arg / `node.expect` never called.

- [ ] **Step 3: Add the `nodeMonitoring` ctor param**

In `src/services/ExecutionService.ts`, add a final optional ctor param after `runState`:

```ts
    private readonly runState?: RunStateStore,
    // Optional Node monitoring service. When present, npm + monitor is routed
    // here (loopback agent) instead of the JVM JMX attach path.
    private readonly nodeMonitoring?: {
      listenPort(): Promise<number>;
      readonly agentPath: string;
      expect(configId: string): void;
      detach(configId: string): void;
    },
  ) {
```

- [ ] **Step 4: Branch the monitor-port allocation**

Replace the monitor-port block (currently lines ~454-469, `let monitorPort: number | undefined; if (opts?.monitor) { ... allocateFreePort ... }`) with:

```ts
    let monitorPort: number | undefined;
    let nodeAgentPath: string | undefined;
    if (opts?.monitor) {
      if (resolvedCfg.type === 'npm' && this.nodeMonitoring) {
        // Node: the "port" is the extension's IPC server, not a port the app
        // binds. The in-process agent dials back to it.
        monitorPort = await this.nodeMonitoring.listenPort();
        nodeAgentPath = this.nodeMonitoring.agentPath;
      } else if (this.monitoring) {
        // JVM: allocate a free JMX port, excluding the app's own port(s).
        const appPorts: number[] = [];
        const rp = resolvedCfg.port;
        if (rp && rp > 0) appPorts.push(rp);
        if (resolvedCfg.type === 'tomcat') appPorts.push(resolvedCfg.typeOptions.httpPort);
        try {
          monitorPort = await allocateFreePort(appPorts);
        } catch (e) {
          log.warn(`Could not allocate JMX port for monitoring: ${(e as Error).message}`);
          vscode.window.showWarningMessage(
            `Monitoring disabled: could not allocate a free JMX port. The run will continue without monitoring.`,
          );
        }
      }
    }
```

- [ ] **Step 5: Pass `nodeAgentPath` into prepareLaunch ctx**

In the `adapter.prepareLaunch(resolvedCfg, folder, { ... })` call (lines ~479-484), add `nodeAgentPath`:

```ts
        prepared = await adapter.prepareLaunch(resolvedCfg, folder, {
          debug: opts?.debug ?? false,
          debugPort: opts?.debugPort,
          monitor: Boolean(monitorPort),
          monitorPort,
          nodeAgentPath,
        });
```

- [ ] **Step 6: Branch the post-launch attach**

Replace the attach block (currently lines ~785-809, `if (monitorPort && this.monitoring) { ... }`) with:

```ts
      if (monitorPort) {
        if (resolvedCfg.type === 'npm' && this.nodeMonitoring) {
          // The in-process agent connects on its own; just register the
          // expectation so its hello is routed to this config.
          this.nodeMonitoring.expect(cfg.id);
        } else if (this.monitoring) {
          const pid = terminalRef.current?.childPid ?? 0;
          const appPort =
            resolvedCfg.port ??
            (resolvedCfg.type === 'tomcat' ? resolvedCfg.typeOptions.httpPort : undefined);
          if (resolvedCfg.type === 'quarkus') {
            const execToken = execution;
            setTimeout(() => {
              const currentEntry = this.running.get(cfg.id);
              if (currentEntry?.execution === execToken && this.monitoring) {
                this.monitoring.attach(cfg.id, 0, monitorPort!, appPort);
              }
            }, QUARKUS_MONITOR_ATTACH_DELAY_MS);
          } else {
            this.monitoring.attach(cfg.id, pid, monitorPort, appPort);
          }
        }
      }
```

- [ ] **Step 7: Detach Node monitoring on stop/end/dispose**

At each existing `this.monitoring?.detach(<id>)` call site (lines ~1044, ~1079, ~1096, ~1128), add a sibling line immediately after it:

```ts
      this.nodeMonitoring?.detach(<id>);
```

Use the same identifier already passed to `this.monitoring?.detach(...)` at that site (`configId` at the stop sites, `id` in `handleEnd`/`dispose`).

- [ ] **Step 8: Run to verify the new test passes and nothing else broke**

Run: `npx jest ExecutionService -v`
Expected: PASS (new test + all existing ExecutionService tests).

- [ ] **Step 9: Commit**

```bash
git add src/services/ExecutionService.ts test/ExecutionService.nodeMonitor.test.ts
git commit -m "feat(monitor): route npm monitoring through NodeMonitoringService"
```

---

### Task 7: DebugService — Debug with Monitoring (npm)

npm debug is launch-type and bypasses ExecutionService.run, so inject the agent env into the debug config and register the expectation here.

**Files:**
- Modify: `src/services/DebugService.ts` (ctor ~21-26; after `getDebugConfig` ~63; `handleEnd`)
- Test: `test/DebugService.nodeMonitor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/DebugService.nodeMonitor.test.ts
import * as vscode from 'vscode';
import { DebugService } from '../src/services/DebugService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any;
function npm(): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('DebugService Debug-with-Monitoring (npm)', () => {
  test('injects agent env into the debug config and registers expect', async () => {
    const registry = new AdapterRegistry();
    registry.register(new NpmAdapter());
    const node = {
      listenPort: jest.fn().mockResolvedValue(7001),
      agentPath: '/x/agent.cjs',
      expect: jest.fn(),
      detach: jest.fn(),
    } as any;
    const startSpy = jest.spyOn(vscode.debug, 'startDebugging').mockResolvedValue(true as any);

    // nodeMonitoring is the LAST ctor param.
    const dbg = new DebugService(registry, undefined, node);
    await dbg.debug(npm(), folder, { monitor: true });

    expect(node.listenPort).toHaveBeenCalled();
    expect(node.expect).toHaveBeenCalledWith('cfg1');
    const conf = startSpy.mock.calls[0][1] as any;
    expect(conf.env.NODE_OPTIONS).toContain('--require "/x/agent.cjs"');
    expect(conf.env.RCM_MONITOR_PORT).toBe('7001');
    expect(conf.env.RCM_MONITOR_ID).toBe('cfg1');
    startSpy.mockRestore();
  });
});
```

(If `vscode.debug.startDebugging` is not yet a `jest.fn()` in the mock, the `jest.spyOn` line covers it; if the mock already defines it as a fn, the spy still works.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest DebugService.nodeMonitor -v`
Expected: FAIL — 3rd ctor arg unsupported / `node.expect` never called.

- [ ] **Step 3: Add the `nodeMonitoring` ctor param**

In `src/services/DebugService.ts`, add a final optional ctor param after `exec`:

```ts
    private readonly exec?: ExecutionService,
    // Optional Node monitoring service for Debug-with-Monitoring on npm configs.
    private readonly nodeMonitoring?: {
      listenPort(): Promise<number>;
      readonly agentPath: string;
      expect(configId: string): void;
      detach(configId: string): void;
    },
  ) {
```

- [ ] **Step 4: Inject agent env for npm + monitor**

In `debug(...)`, immediately after `const conf = adapter.getDebugConfig(resolvedCfg, folder);` (line ~63), add:

```ts
    if (resolvedCfg.type === 'npm' && opts?.monitor && this.nodeMonitoring) {
      const port = await this.nodeMonitoring.listenPort();
      conf.env = {
        ...(conf.env ?? {}),
        ...buildNodeMonitorEnv(this.nodeMonitoring.agentPath, port, cfg.id),
      };
      this.nodeMonitoring.expect(cfg.id);
    }
```

Add the import at the top of `DebugService.ts`:

```ts
import { buildNodeMonitorEnv } from '../utils/nodeMonitorEnv';
```

- [ ] **Step 5: Detach on debug-session end**

In `handleEnd(sessionName)` (lines ~363-374), add `this.nodeMonitoring?.detach(id);` immediately after `this.running.delete(id);`:

```ts
  private handleEnd(sessionName: string): void {
    for (const [id, name] of this.running.entries()) {
      if (name === sessionName) {
        this.running.delete(id);
        this.nodeMonitoring?.detach(id);
        this.emitter.fire(id);
        return;
      }
    }
  }
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest DebugService -v`
Expected: PASS (new test + existing DebugService tests).

- [ ] **Step 7: Commit**

```bash
git add src/services/DebugService.ts test/DebugService.nodeMonitor.test.ts
git commit -m "feat(monitor): support Debug-with-Monitoring for npm configs"
```

---

### Task 8: Wire `NodeMonitoringService` in `extension.ts`

**Files:**
- Modify: `src/extension.ts` (imports; ~84-102; ~476)

- [ ] **Step 1: Import the service**

Add near the existing `import { MonitoringService } from './services/MonitoringService';` (line ~31):

```ts
import { NodeMonitoringService } from './services/NodeMonitoringService';
```

- [ ] **Step 2: Construct it next to `MonitoringService`**

After `const monitoring = new MonitoringService(context.extensionUri);` and its dispose push (lines ~84-85), add:

```ts
  const nodeMonitoring = new NodeMonitoringService(context.extensionUri);
  context.subscriptions.push({ dispose: () => nodeMonitoring.dispose() });
```

- [ ] **Step 3: Pass it to the services that need it (as the LAST arg each)**

```ts
  // line ~89
  const exec = new ExecutionService(registry, monitoring, svc, runState, nodeMonitoring);
  // line ~90
  const dbg = new DebugService(registry, exec, nodeMonitoring);
  // line ~102 — append nodeMonitoring after collapseState
  const tree = new RunConfigTreeProvider(store, svc, exec, dbg, registry, context.extensionUri, docker, orchestrator, native, groups, monitoring, collapseState, nodeMonitoring);
```

- [ ] **Step 4: Make Open Monitor runtime-aware**

```ts
  // line ~476
  MonitorPanel.open(arg.config, context.extensionUri, monitoring, nodeMonitoring);
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: FAIL only where `RunConfigTreeProvider` / `MonitorPanel.open` don't yet accept the new param — those are added in Tasks 9 and 11. (If you do Tasks 9/11 first, this passes clean.) It's fine to proceed; the suite goes green at the end of Task 11.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat(monitor): construct and wire NodeMonitoringService"
```

---

### Task 9: Tree provider — `:monitored` + Node heap/CPU description

No `:monitorable` token (all-npm gating means it's unneeded). The provider only needs to (a) set `:monitored` when a Node config is being monitored, and (b) append RSS+CPU text to the row.

**Files:**
- Modify: `src/ui/RunConfigTreeProvider.ts` (imports; ctor ~82-96; config item ~376-399)
- Test: `test/RunConfigTreeProvider.nodeMonitor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/RunConfigTreeProvider.nodeMonitor.test.ts
// Exercises the pure description/suffix logic via an extracted helper.
import { computeNodeRowExtras } from '../src/ui/RunConfigTreeProvider';
import type { RunConfig } from '../src/shared/types';

function npm(scriptName: string): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName, packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('computeNodeRowExtras', () => {
  test('no node state → no suffix, no description', () => {
    const r = computeNodeRowExtras(npm('dev'), undefined);
    expect(r.monitored).toBe('');
    expect(r.description).toBe('');
  });

  test('formats RSS MB and CPU% from node state, sets :monitored', () => {
    const state = { status: 'live', history: [{ rss: 134217728, cpuPercent: 3.2 }] } as any;
    const r = computeNodeRowExtras(npm('dev'), state);
    expect(r.monitored).toBe(':monitored');
    expect(r.description).toBe('128 MB · 3.2%');
  });

  test('no description when no history yet (still :monitored while connecting)', () => {
    const state = { status: 'connecting', history: [] } as any;
    const r = computeNodeRowExtras(npm('dev'), state);
    expect(r.monitored).toBe(':monitored');
    expect(r.description).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest RunConfigTreeProvider.nodeMonitor -v`
Expected: FAIL with "computeNodeRowExtras is not a function".

- [ ] **Step 3: Add the exported pure helper**

Add the import with the other imports at the top of `src/ui/RunConfigTreeProvider.ts`:

```ts
import type { NodeMonitoringState } from '../services/NodeMonitoringService';
```

And add, at module scope (exported):

```ts
// Pure helper: computes the Node-specific tree-row additions so they can be
// unit-tested without constructing the whole provider. RSS is the headline
// number; no sparkline (Node).
export function computeNodeRowExtras(
  _cfg: RunConfig,
  nodeState: NodeMonitoringState | undefined,
): { monitored: string; description: string } {
  const live = nodeState && nodeState.history.length > 0
    ? nodeState.history[nodeState.history.length - 1]
    : undefined;
  const monitored = nodeState ? ':monitored' : '';
  const description = live
    ? `${(live.rss / (1024 * 1024)).toFixed(0)} MB · ${live.cpuPercent.toFixed(1)}%`
    : '';
  return { monitored, description };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest RunConfigTreeProvider.nodeMonitor -v`
Expected: PASS.

- [ ] **Step 5: Add the `nodeMonitoring` ctor param + refresh subscription**

In the constructor params list (after `collapseState`, the current last param ~line 82), add:

```ts
    private readonly nodeMonitoring?: import('../services/NodeMonitoringService').NodeMonitoringService,
```

In the constructor body, next to the existing `if (monitoring) { monitoring.onChanged(() => this.refresh()); }` (lines ~95-96), add:

```ts
    if (nodeMonitoring) {
      nodeMonitoring.onChanged(() => this.refresh());
    }
```

- [ ] **Step 6: Use the helper in the config item builder**

Replace the existing `const monState = ...; const monitoredSuffix = ...; item.contextValue = ...;` block and the existing JVM description `if` block (lines ~389-399) with:

```ts
    const nodeState = this.nodeMonitoring?.state(n.config.id);
    const nodeExtras = computeNodeRowExtras(n.config, nodeState);

    const monState = this.monitoring?.state(n.config.id);
    const monitoredSuffix = (monState || nodeState) ? ':monitored' : '';
    // contextValue is unchanged in shape — no new :monitorable token (the npm
    // monitoring menus are gated on :npm, see Task 10). openMonitor already
    // includes npm in its alternation, so :monitored alone lights it up.
    item.contextValue = `${baseContextValue}${toolSuffix}${groupSuffix}${monitoredSuffix}`;

    // JVM monitoring description (existing behavior, unchanged).
    if (monState && monState.history.length > 0) {
      const last = monState.history[monState.history.length - 1];
      const heapMb = (last.heapUsed / (1024 * 1024)).toFixed(0);
      const cpuPct = (last.cpuLoad * 100).toFixed(1);
      item.description = `${item.description ? `${item.description}  ` : ''}${heapMb} MB  ${cpuPct}%`;
    } else if (nodeExtras.description) {
      // Node monitoring description: RSS + CPU text, no sparkline.
      item.description = `${item.description ? `${item.description}  ` : ''}${nodeExtras.description}`;
    }
```

- [ ] **Step 7: Run the provider tests**

Run: `npx jest RunConfigTreeProvider -v`
Expected: PASS (new test + existing provider tests).

- [ ] **Step 8: Commit**

```bash
git add src/ui/RunConfigTreeProvider.ts test/RunConfigTreeProvider.nodeMonitor.test.ts
git commit -m "feat(monitor): npm tree rows show :monitored + Node RSS/CPU description"
```

---

### Task 10: Menu gating (offer npm monitoring on all npm configs)

Two tiny alternation edits — no new contextValue token, so the ~20 generic `when`-clauses are untouched.

**Files:**
- Modify: `package.json` (lines ~468 and ~473)

- [ ] **Step 1: Add `npm` to the `runMonitored` when-clause**

Line ~468 — change the alternation from `(maven|gradle)` to `(maven|gradle|npm)`:

```jsonc
{
  "command": "runConfig.runMonitored",
  "when": "view == runConfigurations && viewItem =~ /^configIdle(NoDebug)?:(maven|gradle|npm)(:grouped)?$/",
  "group": "1_run@5"
},
```

- [ ] **Step 2: Add `npm` to the `debugMonitored` when-clause**

Line ~473:

```jsonc
{
  "command": "runConfig.debugMonitored",
  "when": "view == runConfigurations && viewItem =~ /^configIdle:(maven|gradle|npm)(:grouped)?$/",
  "group": "1_run@6"
},
```

(`runConfig.openMonitor` at line ~478 already includes `npm` in its alternation and ends in `:monitored$`, so it lights up automatically once Task 9 sets `:monitored` for a monitored Node config. No change needed.)

- [ ] **Step 3: Verify the JSON is valid**

Run: `node -e "require('./package.json'); console.log('package.json OK')"`
Expected: `package.json OK`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(monitor): offer Run/Debug-with-Monitoring on npm configs"
```

---

### Task 11: `MonitorPanel` runtime-awareness

Route the panel to the right service and post Node data under a `monitor.node.*` namespace, with a `runtime` tag in the HTML.

**Files:**
- Modify: `src/ui/MonitorPanel.ts` (ctor, `open`, `pushState`, `onMessage`, `html`)

- [ ] **Step 1: Make `open`/ctor accept both services and compute runtime**

Replace the constructor signature, `open`, and add a `runtime` field:

```ts
  private readonly runtime: 'node' | 'jvm';

  private constructor(
    private readonly cfg: RunConfig,
    private readonly extensionUri: vscode.Uri,
    private readonly monitoring: MonitoringService,
    private readonly nodeMonitoring?: NodeMonitoringService,
  ) {
    this.runtime = cfg.type === 'npm' ? 'node' : 'jvm';
    this.panel = vscode.window.createWebviewPanel(
      'rcmMonitor', `Monitor: ${cfg.name}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media', 'webview')] },
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    const svc = this.runtime === 'node' ? this.nodeMonitoring : this.monitoring;
    this.subscription = svc!.onChanged(id => { if (id === cfg.id) this.pushState(); });
    this.panel.onDidDispose(() => {
      this.subscription.dispose();
      MonitorPanel.instances.delete(cfg.id);
    });
    this.pushState();
  }

  static open(
    cfg: RunConfig,
    extensionUri: vscode.Uri,
    monitoring: MonitoringService,
    nodeMonitoring?: NodeMonitoringService,
  ): void {
    const existing = this.instances.get(cfg.id);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Beside); return; }
    const inst = new MonitorPanel(cfg, extensionUri, monitoring, nodeMonitoring);
    this.instances.set(cfg.id, inst);
  }
```

Add the import at the top:

```ts
import type { NodeMonitoringService } from '../services/NodeMonitoringService';
```

- [ ] **Step 2: Branch `pushState`**

Wrap the existing body of `pushState()` in `if (this.runtime === 'jvm') { ...existing... return; }` and add the Node branch:

```ts
  private pushState(): void {
    if (this.runtime === 'jvm') {
      // ... existing JVM body unchanged ...
      return;
    }
    // Node
    const state = this.nodeMonitoring?.state(this.cfg.id);
    if (!state) return;
    if (state.hello) {
      this.panel.webview.postMessage({ cmd: 'monitor.node.hello', configId: this.cfg.id, hello: state.hello });
    }
    if (state.history.length > 0) {
      this.panel.webview.postMessage({
        cmd: 'monitor.node.tick', configId: this.cfg.id,
        metrics: state.history[state.history.length - 1], startTime: state.startTime,
      });
    }
    if (state.heapSpaces) {
      this.panel.webview.postMessage({ cmd: 'monitor.node.heapSpaces', configId: this.cfg.id, heapSpaces: state.heapSpaces });
    }
    for (const ev of state.gcEvents) {
      this.panel.webview.postMessage({ cmd: 'monitor.node.gc', configId: this.cfg.id, gc: ev });
    }
  }
```

- [ ] **Step 3: Handle the Node save-snapshot message**

In `onMessage`, add a handler (Node uses `monitor.node.saveSnapshot`):

```ts
    if (msg?.cmd === 'monitor.node.saveSnapshot' && msg.configId === this.cfg.id) {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.tmpdir(),
          `${this.cfg.name.replace(/\W+/g, '-')}-${Date.now()}.heapsnapshot`)),
        filters: { 'Heap snapshot': ['heapsnapshot'] },
      });
      if (!target) return;
      try {
        const written = await this.nodeMonitoring!.saveHeapSnapshot(this.cfg.id, target.fsPath);
        this.panel.webview.postMessage({ cmd: 'monitor.node.snapshotComplete', configId: this.cfg.id, path: written });
        const choice = await vscode.window.showInformationMessage(`Heap snapshot written to ${written}`, 'Reveal in Explorer');
        if (choice === 'Reveal in Explorer') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(written));
        }
      } catch (e) {
        this.panel.webview.postMessage({ cmd: 'monitor.error', configId: this.cfg.id, message: (e as Error).message });
      }
      return;
    }
```

- [ ] **Step 4: Add `data-runtime` to the HTML root**

In `html()`, add the attribute to the `#root` div:

```ts
<div id="root" data-view="monitor" data-runtime="${this.runtime}" data-config-id="${escapeHtml(this.cfg.id)}" data-config-name="${escapeHtml(this.cfg.name)}" data-own-package="${escapeHtml(ownPackagePrefix(this.cfg))}"></div>
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS for `MonitorPanel.ts` and `extension.ts` (Task 8's `MonitorPanel.open(... nodeMonitoring)` now matches). The webview `NodeMonitorView` is added in Task 12.

- [ ] **Step 6: Commit**

```bash
git add src/ui/MonitorPanel.ts
git commit -m "feat(monitor): make MonitorPanel runtime-aware (node vs jvm)"
```

---

### Task 12: Node webview (`NodeMonitorView`) + routing

**Files:**
- Modify: `webview/src/main.tsx` (read `data-runtime`, route)
- Create: `webview/src/NodeMonitorView.tsx`

- [ ] **Step 1: Route by runtime in `main.tsx`**

Replace the `if (view === 'monitor') { ... }` block with:

```ts
if (view === 'monitor') {
  const configId = root.dataset.configId ?? '';
  const configName = root.dataset.configName ?? '';
  const ownPackage = root.dataset.ownPackage ?? '';
  const runtime = root.dataset.runtime ?? 'jvm';
  if (runtime === 'node') {
    void import('./NodeMonitorView').then(({ NodeMonitorView }) => {
      createRoot(root).render(<NodeMonitorView configId={configId} configName={configName} />);
    });
  } else {
    void import('./MonitorView').then(({ MonitorView }) => {
      createRoot(root).render(
        <MonitorView configId={configId} configName={configName} ownPackage={ownPackage} />,
      );
    });
  }
} else {
  void import('./App').then(({ App }) => {
    createRoot(root).render(<App />);
  });
}
```

- [ ] **Step 2: Create `NodeMonitorView.tsx`**

```tsx
// webview/src/NodeMonitorView.tsx
import { useEffect, useMemo, useState } from 'react';
import type {
  NodeHello, NodeMetricsTick, NodeHeapSpaces, NodeGcEvent,
} from '../../src/services/monitoring/NodeAgentMessage';

const HISTORY_CAP_BY_WINDOW: Record<string, number> = { '60s': 60, '5min': 300, '30min': 1800 };
type TabKey = 'memory' | 'loop' | 'runtime';

declare const acquireVsCodeApi: any;
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };
const MB = 1024 * 1024;
const mb = (n: number) => `${(n / MB).toFixed(0)} MB`;

export function NodeMonitorView({ configId, configName }: { configId: string; configName: string }) {
  const [history, setHistory] = useState<NodeMetricsTick[]>([]);
  const [heapSpaces, setHeapSpaces] = useState<NodeHeapSpaces | null>(null);
  const [gcEvents, setGcEvents] = useState<NodeGcEvent[]>([]);
  const [hello, setHello] = useState<NodeHello | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [windowKey, setWindowKey] = useState<keyof typeof HISTORY_CAP_BY_WINDOW>('60s');
  const [tab, setTab] = useState<TabKey>('memory');
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m?.configId !== configId) return;
      if (m.cmd === 'monitor.node.tick') {
        if (typeof m.startTime === 'number') setStartTime(m.startTime);
        setHistory(h => [...h, m.metrics].slice(-HISTORY_CAP_BY_WINDOW[windowKey]));
      } else if (m.cmd === 'monitor.node.heapSpaces') {
        setHeapSpaces(m.heapSpaces);
      } else if (m.cmd === 'monitor.node.gc') {
        setGcEvents(prev => {
          const key = `${m.gc.t}-${m.gc.kind}`;
          if (prev.some(g => `${g.t}-${g.kind}` === key)) return prev;
          const cutoff = Date.now() - 60_000;
          return [...prev, m.gc].filter(g => g.t >= cutoff);
        });
      } else if (m.cmd === 'monitor.node.hello') {
        setHello(m.hello);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [configId, windowKey]);

  const last = history[history.length - 1];
  const uptime = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const gcLast60 = gcEvents.reduce((s, g) => s + g.durationMs, 0);

  return (
    <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)' }}>
      <h2 style={{ marginTop: 0 }}>{configName}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Window:</span>
        {(['60s', '5min', '30min'] as const).map(w => (
          <button key={w} onClick={() => setWindowKey(w)} style={{ fontWeight: w === windowKey ? 'bold' : 'normal' }}>{w}</button>
        ))}
        <button title="Write a V8 heap snapshot (.heapsnapshot) you can open in Chrome DevTools or VS Code."
          onClick={() => vscode.postMessage({ cmd: 'monitor.node.saveSnapshot', configId })}>
          Save heap snapshot
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>
          Run duration: {Math.floor(uptime / 60)}m {uptime % 60}s
        </div>
      </div>

      <MemChart history={history} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginTop: 12, marginBottom: 12 }}>
        <Tile label="Heap" value={last ? mb(last.heapUsed) : '—'} sub={last && last.heapLimit > 0 ? `of ${mb(last.heapLimit)}` : ''} title="V8 heap used / limit." />
        <Tile label="RSS" value={last ? mb(last.rss) : '—'} sub="resident set" title="Resident set size — total memory held by the process." />
        <Tile label="CPU" value={last ? `${last.cpuPercent.toFixed(1)}%` : '—'} sub="process" title="Process CPU usage over the last second (can exceed 100% across cores)." />
        <Tile label="Loop lag" value={last ? `${last.loopLagP99.toFixed(1)} ms` : '—'} sub="p99" title="Event-loop delay p99 — high values mean the loop is blocked." />
        <Tile label="Handles" value={last ? String(last.activeHandles) : '—'} sub="active" title="Active libuv handles (sockets, timers, servers)." />
        <Tile label="GC" value={`${gcLast60.toFixed(0)} ms`} sub="last 60s" title="Cumulative GC pause time over the last 60 seconds." />
      </div>

      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--vscode-editorWidget-border, #444)' }}>
        {([['memory', 'Memory'], ['loop', 'Event loop'], ['runtime', 'Runtime']] as Array<[TabKey, string]>).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            border: 'none', background: 'transparent', padding: '6px 12px', cursor: 'pointer',
            borderBottom: tab === k ? '2px solid var(--vscode-focusBorder, #007acc)' : '2px solid transparent',
            color: tab === k ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
            fontWeight: tab === k ? 600 : 400,
          }}>{l}</button>
        ))}
      </div>

      <div style={{ padding: '12px 0' }}>
        {tab === 'memory' && <MemoryTab last={last} heapSpaces={heapSpaces} gcEvents={gcEvents} history={history} />}
        {tab === 'loop' && <LoopTab history={history} />}
        {tab === 'runtime' && <RuntimeTab hello={hello} last={last} uptime={uptime} />}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, title }: { label: string; value: string; sub: string; title: string }) {
  return (
    <div title={title} style={{ border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4, padding: 8 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 10, opacity: 0.6 }}>{sub}</div>
    </div>
  );
}

function MemChart({ history }: { history: NodeMetricsTick[] }) {
  if (history.length === 0) return <div style={{ height: 140, opacity: 0.6, padding: 8 }}>No data yet</div>;
  const w = 800, h = 140, pT = 16, pB = 18, pL = 56, pR = 12;
  const plotW = w - pL - pR, plotH = h - pT - pB;
  const vals = history.flatMap(m => [m.rss, m.heapUsed]);
  const lo = Math.min(...vals), hi = Math.max(...vals) || 1;
  const range = (hi - lo) || 1;
  const x = (i: number) => pL + (i / (history.length - 1 || 1)) * plotW;
  const y = (v: number) => pT + plotH - ((v - lo) / range) * plotH;
  const line = (sel: (m: NodeMetricsTick) => number) => history.map((m, i) => `${x(i)},${y(sel(m))}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}>
      <text x={pL - 4} y={pT + 4} textAnchor="end" fontSize="10" fill="var(--vscode-descriptionForeground, #888)">{mb(hi)}</text>
      <text x={pL - 4} y={pT + plotH} textAnchor="end" fontSize="10" fill="var(--vscode-descriptionForeground, #888)">{mb(lo)}</text>
      <polyline points={line(m => m.rss)} fill="none" stroke="var(--vscode-charts-orange, #d18616)" strokeWidth={1.5} />
      <polyline points={line(m => m.heapUsed)} fill="none" stroke="var(--vscode-charts-blue, #4080ff)" strokeWidth={1.5} />
      <text x={pL} y={12} fontSize="10" fill="var(--vscode-descriptionForeground, #888)">RSS (orange) · Heap used (blue)</text>
    </svg>
  );
}

function MemoryTab({ last, heapSpaces, gcEvents, history }: {
  last?: NodeMetricsTick; heapSpaces: NodeHeapSpaces | null; gcEvents: NodeGcEvent[]; history: NodeMetricsTick[];
}) {
  const allocRate = useMemo(() => {
    if (history.length < 2) return 0;
    let sum = 0, n = 0;
    for (let i = 1; i < history.length; i++) {
      const d = history[i].heapUsed - history[i - 1].heapUsed;
      if (d > 0) { sum += d; n++; }
    }
    return n ? sum / n : 0;
  }, [history]);
  return (
    <div>
      <h3>V8 heap spaces</h3>
      {!heapSpaces ? <div style={{ opacity: 0.6 }}>No data yet</div> : (
        <div style={{ display: 'grid', gap: 6 }}>
          {heapSpaces.spaces.map(s => {
            const pct = s.size > 0 ? (s.used / s.size) * 100 : 0;
            return (
              <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 140px', gap: 8, alignItems: 'center' }}>
                <span title={s.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                <div style={{ background: 'var(--vscode-editorWidget-background)', height: 12, borderRadius: 3 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--vscode-charts-blue, #4080ff)', borderRadius: 3 }} />
                </div>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{mb(s.used)} / {mb(s.size)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>External</div><div>{last ? mb(last.external) : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>ArrayBuffers</div><div>{last ? mb(last.arrayBuffers) : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Alloc rate</div><div>{(allocRate / MB).toFixed(2)} MB/s</div></div>
      </div>
      <h3 style={{ marginTop: 16 }}>GC timeline (last 60s)</h3>
      <div style={{ display: 'flex', gap: 2, height: 40, alignItems: 'flex-end' }}>
        {gcEvents.length === 0 ? <span style={{ opacity: 0.6 }}>No GC events yet</span> :
          gcEvents.map((g, i) => (
            <div key={i} title={`${g.kind} · ${g.durationMs} ms`} style={{
              width: 4, height: Math.min(40, 4 + g.durationMs), background: g.kind === 'major'
                ? 'var(--vscode-charts-red, #f14c4c)' : 'var(--vscode-charts-green, #16825d)',
            }} />
          ))}
      </div>
    </div>
  );
}

function LoopTab({ history }: { history: NodeMetricsTick[] }) {
  const last = history[history.length - 1];
  return (
    <div>
      <h3>Event-loop lag</h3>
      <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Mean</div><div>{last ? `${last.loopLagMean.toFixed(2)} ms` : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>p99</div><div>{last ? `${last.loopLagP99.toFixed(2)} ms` : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Max</div><div>{last ? `${last.loopLagMax.toFixed(2)} ms` : '—'}</div></div>
      </div>
      <Spark values={history.map(m => m.loopLagP99)} label="p99 lag (ms)" />
      <h3 style={{ marginTop: 16 }}>Active resources</h3>
      <div style={{ display: 'flex', gap: 24 }}>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Handles</div><div>{last?.activeHandles ?? '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Requests</div><div>{last?.activeRequests ?? '—'}</div></div>
      </div>
    </div>
  );
}

function Spark({ values, label }: { values: number[]; label: string }) {
  if (values.length === 0) return <div style={{ opacity: 0.6 }}>No data yet</div>;
  const w = 600, h = 60;
  const hi = Math.max(...values) || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1 || 1)) * w},${h - (v / hi) * h}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}>
      <polyline points={pts} fill="none" stroke="var(--vscode-charts-purple, #b180d7)" strokeWidth={1.5} />
      <text x={4} y={12} fontSize="10" fill="var(--vscode-descriptionForeground, #888)">{label} · max {hi.toFixed(1)}</text>
    </svg>
  );
}

function RuntimeTab({ hello, last, uptime }: { hello: NodeHello | null; last?: NodeMetricsTick; uptime: number }) {
  if (!hello) return <div style={{ opacity: 0.6 }}>No data yet</div>;
  const Row = ({ k, v }: { k: string; v: string }) => (
    <tr><td style={{ opacity: 0.7, paddingRight: 16 }}>{k}</td><td style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</td></tr>
  );
  return (
    <div>
      <table><tbody>
        <Row k="Node" v={hello.nodeVersion} />
        <Row k="V8" v={hello.v8Version} />
        <Row k="PID" v={String(hello.pid)} />
        <Row k="Platform" v={`${hello.platform} / ${hello.arch}`} />
        <Row k="Exec path" v={hello.execPath} />
        <Row k="CWD" v={hello.cwd} />
        <Row k="Uptime" v={`${Math.floor(uptime / 60)}m ${uptime % 60}s`} />
        <Row k="RSS" v={last ? mb(last.rss) : '—'} />
      </tbody></table>
      <Collapsible title={`argv (${hello.argv.length})`}>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{hello.argv.join('\n')}</pre>
      </Collapsible>
      <Collapsible title={`Environment variables (${Object.keys(hello.env).length})`}>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{Object.entries(hello.env).map(([k, v]) => `${k}=${v}`).join('\n')}</pre>
      </Collapsible>
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: any }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-foreground)' }}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open && <div style={{ marginLeft: 16, fontSize: 12 }}>{children}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build the webview**

Run: `npm run typecheck && npm run build`
Expected: PASS; vite emits `media/webview/assets/NodeMonitorView.js` (lazy chunk).

- [ ] **Step 4: Commit**

```bash
git add webview/src/main.tsx webview/src/NodeMonitorView.tsx
git commit -m "feat(monitor): add Node monitor webview (Memory / Event loop / Runtime)"
```

---

### Task 13: Full verification + packaging

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass (the pre-existing `test/detectTomcat.test.ts:73` macOS realpath flake is unrelated and may fail locally on macOS — confirm it's the only failure); build succeeds.

- [ ] **Step 2: Confirm the agent ships in the package**

Run: `npx vsce ls --no-dependencies | grep rcm-node-agent`
Expected: `media/agent/rcm-node-agent.cjs` is listed. If missing, check `.vscodeignore` does not exclude it.

- [ ] **Step 3: Manual smoke test (F5 Extension Development Host)**

  - [ ] Open a folder with a server-like npm script (e.g. `"dev": "node server.js"` running an HTTP server).
  - [ ] Right-click the npm config → **Run with Monitoring**. The row shows `… MB · …%` text after a second; **Open Monitor View** appears in the right-click menu.
  - [ ] Open Monitor View → confirm RSS/heap chart, KPI tiles, the three tabs (Memory / Event loop / Runtime) populate and contain **no** Java labels.
  - [ ] Click **Save heap snapshot** → choose a path → confirm the `.heapsnapshot` is written and "Reveal in Explorer" works.
  - [ ] Right-click → **Debug with Monitoring** → confirm the debugger attaches AND the monitor view populates.
  - [ ] Stop the config → confirm the monitor row text clears and the agent socket closes (no errors in Output).
  - [ ] Confirm a **non**-server-like npm config (e.g. `"build"`) does **not** show Run/Debug with Monitoring.
  - [ ] Sanity check: a JVM config still shows its full (unchanged) Monitor view.

- [ ] **Step 4: Update onboarding doc (optional but recommended)**

Add a short note to `docs/LLM_ONBOARDING.md` under monitoring: "Node monitoring (npm) uses an in-process agent (`media/agent/rcm-node-agent.cjs`) injected via `NODE_OPTIONS=--require`, streaming NDJSON to `NodeMonitoringService`'s loopback server; the webview renders `NodeMonitorView` selected by the `data-runtime` attr."

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "docs(monitor): note Node monitoring architecture in onboarding"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** agent (Task 3), wire format (Task 2), service (Task 4), launch env (Task 5), run routing (Task 6), debug routing (Task 7), wiring (Task 8), tree row (Task 9), menus (Task 10), panel (Task 11), view (Task 12), packaging (Task 13). Heap snapshot: Tasks 3/4/11/12. (Task 1 retired.)
- **Type consistency:** `NodeMetricsTick.cpuPercent` (not `cpuLoad`), `rss` headline in tree + tiles, `heapLimit` (not `heapMax`), `loopLagP99`. The JVM `MetricsTick` is never imported by Node code.
- **Deviation from spec (approved):** monitoring menu items are offered on **all** npm configs (gated on `:npm`), not just server-like scripts. This was chosen over a `:monitorable` contextValue token to avoid editing ~20 anchored `when`-clauses (regression risk). The agent simply connects briefly for short-lived scripts; no harm. Update the spec's "server-like gating" line if you want the doc to match.
