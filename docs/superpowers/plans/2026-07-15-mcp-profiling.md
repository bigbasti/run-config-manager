# MCP Profiling Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the extension's existing runtime telemetry (JVM + Node) and a monitored-run capability through the MCP server so an AI agent can profile an application by running it with monitoring, polling status + raw snapshots, and drilling into a hot thread.

**Architecture:** New/changed capabilities are added at the loopback bridge boundary. `bridgeServices.ts` gains a runtime-selection helper plus `runStatus` / `monitoringSnapshot` / `threadDump` methods and threads a `monitor` flag through `runConfig` / `debugConfig` (the underlying `ExecutionService.run` and `DebugService.debug` already accept `{ monitor }`). `McpBridgeServer` dispatches the new loopback methods; `server.ts` registers three new read-only MCP tools and adds a `monitor` param to `run_config` / `debug_config`. `extension.ts` passes the already-constructed `monitoring` + `nodeMonitoring` services into the bridge. No changes to `MonitoringService` / `NodeMonitoringService` / `ExecutionService` themselves.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Zod, Jest (in-memory `vscode` mock), esbuild (two bundles: `out/extension.js` + `out/mcp-server.js`).

> **HARD RULE — DO NOT COMMIT.** This repo forbids auto-commits. The user reviews and commits manually. Every task ends by *staging* (`git add`) and running verification — never `git commit`.

**Spec:** `docs/superpowers/specs/2026-07-15-mcp-profiling-design.md`

---

## File Structure

**Modify:**
- `src/mcp/protocol.ts` — add three `BridgeMethod`s (`runStatus`, `monitoringSnapshot`, `threadDump`).
- `src/mcp/bridgeServices.ts` — runtime helper + result types; extend `BridgeDeps` (exec state getters, `monitor` opts, `monitoring`/`nodeMonitoring` deps) and `BridgeServices`; implement new methods; thread `monitor`.
- `src/services/McpBridgeServer.ts` — dispatch the new methods and forward `monitor` / `sections` / `tid`.
- `src/mcp/server.ts` — add `monitor` to `run_config`/`debug_config`; register `get_run_status`, `get_monitoring_snapshot`, `get_thread_dump`.
- `src/extension.ts` — pass `monitoring` + `nodeMonitoring` into `createBridgeServices`.
- `media/mcp/run-config-guide.md` — add a "Profiling a running application" section.
- `test/bridgeServices.test.ts` — extend fakes + new cases.
- `test/McpBridgeServer.test.ts` — round-trip new methods.

**Key shared contracts** (defined in Task 2, referenced everywhere after):

```ts
export type MonitoredRuntime = 'jvm' | 'node';
export function runtimeForType(type: string): MonitoredRuntime | null;
runConfig(id: string, monitor?: boolean): Promise<{ monitoring?: 'requested' | 'unsupported' }>;
debugConfig(id: string, monitor?: boolean): Promise<{ monitoring?: 'requested' | 'unsupported' }>;
runStatus(id: string): RunStatus;
monitoringSnapshot(id: string, sections?: string[]): MonitoringSnapshot;
threadDump(id: string, tid: number): Promise<ThreadDump>;
```

**Section-name → output-key note:** For JVM, the requested section name `runtime` is returned under the output key `runtimeInfo` so it does not clobber the top-level `runtime` tag (`'jvm'`/`'node'`). All other section names map to a like-named key.

---

## Task 1: Protocol — add the new bridge methods

**Files:**
- Modify: `src/mcp/protocol.ts:6-16`

- [ ] **Step 1: Extend the `BridgeMethod` union**

In `src/mcp/protocol.ts`, replace the `BridgeMethod` type (lines 6-16) with:

```ts
export type BridgeMethod =
  | 'list'
  | 'get'
  | 'currentConfigs'
  | 'validate'
  | 'create'
  | 'update'
  | 'delete'
  | 'run'
  | 'debug'
  | 'stop'
  | 'runStatus'
  | 'monitoringSnapshot'
  | 'threadDump';
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the new union members are not yet referenced anywhere, but the file still compiles).

- [ ] **Step 3: Stage (DO NOT COMMIT)**

```bash
git add src/mcp/protocol.ts
```

---

## Task 2: bridgeServices — runtime helper + new methods (TDD)

This is the core task. We write the tests first against the extended `BridgeDeps` fakes, watch them fail, then implement.

**Files:**
- Modify: `src/mcp/bridgeServices.ts`
- Test: `test/bridgeServices.test.ts`

- [ ] **Step 1: Rewrite the test fakes to the new `BridgeDeps` shape**

The new `BridgeDeps` requires exec state getters and optional monitoring deps. Replace `test/bridgeServices.test.ts` lines 1-34 (imports + `makeNpm` + `deps`) with:

```ts
import { createBridgeServices, BridgeDeps, runtimeForType } from '../src/mcp/bridgeServices';
import type { RunConfig } from '../src/shared/types';
import type { MonitoringState } from '../src/services/MonitoringService';
import type { NodeMonitoringState } from '../src/services/NodeMonitoringService';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeNpm(id: string, name: string): RunConfig {
  return {
    id, name, projectPath: '/w', workspaceFolder: '/w',
    env: {}, programArgs: '', vmArgs: '',
    type: 'npm',
    typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
  } as RunConfig;
}

function makeSpringBoot(id: string, name: string): RunConfig {
  return {
    id, name, projectPath: '/w', workspaceFolder: '/w',
    env: {}, programArgs: '', vmArgs: '',
    type: 'spring-boot',
    typeOptions: { launchMode: 'maven', buildTool: 'maven' },
  } as RunConfig;
}

function jvmState(): MonitoringState {
  return {
    configId: VALID_ID, pid: 123, jmxPort: 5000, startTime: 0, status: 'live',
    history: [{ type: 'metrics', t: 1, heapUsed: 10, heapCommitted: 20, heapMax: 100,
      nonHeapUsed: 5, cpuLoad: 0.5, threadCount: 12, gcCount: 1, gcTime: 3 }],
    histogram: { type: 'histogram', t: 1, rows: [{ instances: 2, bytes: 64, className: 'java.lang.String' }] },
    gcEvents: [], threadsDetail: null, actuator: null, runtime: null,
  } as MonitoringState;
}

function nodeState(): NodeMonitoringState {
  return {
    configId: VALID_ID, status: 'live', startTime: 0, pid: 123, hello: null,
    history: [{ type: 'metrics', t: 1, rss: 100, heapTotal: 50, heapUsed: 30, heapLimit: 200,
      external: 1, arrayBuffers: 1, cpuPercent: 12, uptime: 5, activeHandles: 3,
      activeRequests: 0, loopLagMean: 1, loopLagP50: 1, loopLagP99: 2, loopLagMax: 3 }],
    heapSpaces: null, gcEvents: [],
  } as NodeMonitoringState;
}

function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  const cfg = makeNpm(VALID_ID, 'Web');
  return {
    svc: {
      list: () => [{ folderKey: '/w', config: cfg, valid: true }],
      getById: (id) => (id === VALID_ID ? { folderKey: '/w', config: cfg, valid: true } : undefined),
      create: jest.fn(async (_k, data) => ({ ...data, id: VALID_ID } as RunConfig)),
      update: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    },
    store: {
      folderKeys: () => ['/w'],
      getFolder: (k) => (k === '/w' ? ({ uri: { fsPath: '/w' }, name: 'w', index: 0 } as any) : undefined),
      getForFolder: () => ({ configurations: [cfg] }),
    },
    exec: {
      run: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      isRunning: () => false,
      isStarted: () => false,
      isFailed: () => false,
      isPreparing: () => false,
    },
    dbg: { debug: jest.fn(async () => true) },
    ...overrides,
  } as BridgeDeps;
}
```

- [ ] **Step 2: Add new test cases**

Append these tests inside the `describe('bridgeServices', ...)` block in `test/bridgeServices.test.ts` (before its closing `});`):

```ts
  it('runtimeForType maps types to runtimes', () => {
    expect(runtimeForType('npm')).toBe('node');
    expect(runtimeForType('spring-boot')).toBe('jvm');
    expect(runtimeForType('quarkus')).toBe('jvm');
    expect(runtimeForType('java')).toBe('jvm');
    expect(runtimeForType('tomcat')).toBe('jvm');
    expect(runtimeForType('python')).toBeNull();
    expect(runtimeForType('go')).toBeNull();
  });

  it('run threads the monitor flag into exec.run and reports requested', async () => {
    const d = deps();
    const s = createBridgeServices(d);
    const res = await s.runConfig(VALID_ID, true);
    expect(d.exec.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_ID }),
      expect.anything(),
      { monitor: true },
    );
    expect(res).toEqual({ monitoring: 'requested' });
  });

  it('run without monitor passes no opts and reports nothing', async () => {
    const d = deps();
    const s = createBridgeServices(d);
    const res = await s.runConfig(VALID_ID);
    expect(d.exec.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: VALID_ID }),
      expect.anything(),
      undefined,
    );
    expect(res).toEqual({});
  });

  it('run with monitor on an unsupported type reports unsupported', async () => {
    const py = { ...makeNpm(VALID_ID, 'Py'), type: 'python' } as RunConfig;
    const d = deps({
      svc: {
        list: () => [{ folderKey: '/w', config: py, valid: true }],
        getById: () => ({ folderKey: '/w', config: py, valid: true }),
        create: jest.fn(), update: jest.fn(), delete: jest.fn(),
      },
    });
    const s = createBridgeServices(d);
    const res = await s.runConfig(VALID_ID, true);
    expect(res).toEqual({ monitoring: 'unsupported' });
  });

  it('runStatus reports exec state, monitored flag, and runtime', () => {
    const d = deps({
      exec: {
        run: jest.fn(), stop: jest.fn(),
        isRunning: () => true, isStarted: () => true,
        isFailed: () => false, isPreparing: () => false,
      },
      nodeMonitoring: { state: () => nodeState() },
    });
    const s = createBridgeServices(d);
    expect(s.runStatus(VALID_ID)).toEqual({
      running: true, started: true, failed: false, preparing: false,
      monitored: true, runtime: 'node',
    });
  });

  it('monitoringSnapshot default returns latest tick + status (node)', () => {
    const d = deps({ nodeMonitoring: { state: () => nodeState() } });
    const s = createBridgeServices(d);
    const snap = s.monitoringSnapshot(VALID_ID);
    expect(snap.runtime).toBe('node');
    expect(snap.status).toBe('live');
    expect((snap.latest as any).rss).toBe(100);
    expect(snap.metrics).toBeUndefined();
  });

  it('monitoringSnapshot returns requested sections (jvm)', () => {
    const cfg = makeSpringBoot(VALID_ID, 'Api');
    const d = deps({
      svc: {
        list: () => [{ folderKey: '/w', config: cfg, valid: true }],
        getById: () => ({ folderKey: '/w', config: cfg, valid: true }),
        create: jest.fn(), update: jest.fn(), delete: jest.fn(),
      },
      monitoring: { state: () => jvmState(), requestThreadDump: jest.fn() },
    });
    const s = createBridgeServices(d);
    const snap = s.monitoringSnapshot(VALID_ID, ['metrics', 'histogram']);
    expect(snap.runtime).toBe('jvm');
    expect(Array.isArray(snap.metrics)).toBe(true);
    expect((snap.histogram as any).rows[0].className).toBe('java.lang.String');
  });

  it('monitoringSnapshot errors when not monitored', () => {
    const d = deps({ nodeMonitoring: { state: () => undefined } });
    const s = createBridgeServices(d);
    expect(() => s.monitoringSnapshot(VALID_ID)).toThrow(/No monitoring data/);
  });

  it('threadDump is JVM-only', async () => {
    const d = deps({ nodeMonitoring: { state: () => nodeState() } });
    const s = createBridgeServices(d);
    await expect(s.threadDump(VALID_ID, 1)).rejects.toThrow(/JVM-only/);
  });

  it('threadDump delegates to monitoring.requestThreadDump for jvm', async () => {
    const cfg = makeSpringBoot(VALID_ID, 'Api');
    const dump = { type: 'threadDump', t: 1, tid: 7, name: 'main', state: 'RUNNABLE', stack: ['a', 'b'] };
    const requestThreadDump = jest.fn(async () => dump);
    const d = deps({
      svc: {
        list: () => [{ folderKey: '/w', config: cfg, valid: true }],
        getById: () => ({ folderKey: '/w', config: cfg, valid: true }),
        create: jest.fn(), update: jest.fn(), delete: jest.fn(),
      },
      monitoring: { state: () => jvmState(), requestThreadDump },
    });
    const s = createBridgeServices(d);
    await expect(s.threadDump(VALID_ID, 7)).resolves.toEqual(dump);
    expect(requestThreadDump).toHaveBeenCalledWith(VALID_ID, 7);
  });
```

- [ ] **Step 3: Run the tests — verify they fail**

Run: `npx jest test/bridgeServices.test.ts`
Expected: FAIL — `runtimeForType` is not exported; `BridgeDeps`/`BridgeServices` lack the new members; TS compile errors in the test.

- [ ] **Step 4: Extend `BridgeDeps`, `BridgeServices`, and result types**

In `src/mcp/bridgeServices.ts`, update the imports at the top (after line 3) to add the type-only monitoring imports:

```ts
import type { MonitoringState } from '../services/MonitoringService';
import type { NodeMonitoringState } from '../services/NodeMonitoringService';
import type { ThreadDump } from '../services/monitoring/AgentMessage';
```

Add these exported types after the existing `ValidateResult` interface (after line 16):

```ts
export type MonitoredRuntime = 'jvm' | 'node';

export interface RunStatus {
  running: boolean;
  started: boolean;
  failed: boolean;
  preparing: boolean;
  monitored: boolean;
  runtime: MonitoredRuntime | null;
}

export interface MonitoringSnapshot {
  runtime: MonitoredRuntime;
  status: 'connecting' | 'live' | 'lost';
  latest: unknown | null;
  // Requested sections are spread in under their section name (JVM `runtime`
  // section is placed under `runtimeInfo` to avoid clobbering this tag).
  [key: string]: unknown;
}

// JVM: spring-boot/quarkus/java/tomcat; Node: npm. Everything else is not
// monitorable. Used to pick the monitoring service and to annotate run status.
const JVM_TYPES = new Set(['spring-boot', 'quarkus', 'java', 'tomcat']);
export function runtimeForType(type: string): MonitoredRuntime | null {
  if (type === 'npm') return 'node';
  if (JVM_TYPES.has(type)) return 'jvm';
  return null;
}
```

Extend the `BridgeServices` interface — replace the `runConfig`/`debugConfig` lines and add three methods:

```ts
  runConfig(id: string, monitor?: boolean): Promise<{ monitoring?: 'requested' | 'unsupported' }>;
  debugConfig(id: string, monitor?: boolean): Promise<{ monitoring?: 'requested' | 'unsupported' }>;
  stopConfig(id: string): Promise<void>;
  runStatus(id: string): RunStatus;
  monitoringSnapshot(id: string, sections?: string[]): MonitoringSnapshot;
  threadDump(id: string, tid: number): Promise<ThreadDump>;
```

Extend the `BridgeDeps` `exec` / `dbg` members and add the two optional monitoring deps — replace the `exec` and `dbg` fields with:

```ts
  exec: {
    run(cfg: RunConfig, folder: vscode.WorkspaceFolder, opts?: { monitor?: boolean }): Promise<unknown>;
    stop(id: string): Promise<void>;
    isRunning(id: string): boolean;
    isStarted(id: string): boolean;
    isFailed(id: string): boolean;
    isPreparing(id: string): boolean;
  };
  dbg: {
    debug(cfg: RunConfig, folder: vscode.WorkspaceFolder, opts?: { monitor?: boolean }): Promise<boolean>;
  };
  monitoring?: {
    state(id: string): MonitoringState | undefined;
    requestThreadDump(id: string, tid: number): Promise<ThreadDump>;
  };
  nodeMonitoring?: {
    state(id: string): NodeMonitoringState | undefined;
  };
```

- [ ] **Step 5: Implement the new behavior in `createBridgeServices`**

In `src/mcp/bridgeServices.ts`, update the destructure on line 64 to include the new deps:

```ts
  const { svc, store, exec, dbg, monitoring, nodeMonitoring } = deps;
```

Add a small helper near `resolveValid` (after line 71):

```ts
  const typeOf = (id: string): string => {
    const ref = svc.getById(id);
    if (!ref) throw new Error(`Configuration not found: ${id}`);
    return (ref.config as { type?: string }).type ?? '';
  };
```

Replace the existing `runConfig` and `debugConfig` implementations (lines 148-156) with monitor-aware versions:

```ts
    runConfig: async (id, monitor) => {
      const ref = resolveValid(id);
      const supported = runtimeForType(ref.config.type) !== null;
      await exec.run(ref.config, folderOrThrow(ref.folderKey), monitor ? { monitor: true } : undefined);
      if (!monitor) return {};
      return { monitoring: supported ? 'requested' : 'unsupported' };
    },

    debugConfig: async (id, monitor) => {
      const ref = resolveValid(id);
      const supported = runtimeForType(ref.config.type) !== null;
      await dbg.debug(ref.config, folderOrThrow(ref.folderKey), monitor ? { monitor: true } : undefined);
      if (!monitor) return {};
      return { monitoring: supported ? 'requested' : 'unsupported' };
    },
```

Then add the three new methods after `stopConfig` (before the closing `};` of the returned object, after line 160):

```ts
    runStatus: id => {
      const runtime = runtimeForType(typeOf(id));
      const monitored = !!(monitoring?.state(id) || nodeMonitoring?.state(id));
      return {
        running: exec.isRunning(id),
        started: exec.isStarted(id),
        failed: exec.isFailed(id),
        preparing: exec.isPreparing(id),
        monitored,
        runtime,
      };
    },

    monitoringSnapshot: (id, sections) => {
      const runtime = runtimeForType(typeOf(id));
      const want = new Set(sections ?? []);
      const notMonitored = () =>
        new Error(`No monitoring data for ${id} (not running with monitoring, or agent still connecting)`);

      if (runtime === 'jvm') {
        const st = monitoring?.state(id);
        if (!st) throw notMonitored();
        const latest = st.history.length ? st.history[st.history.length - 1] : null;
        const out: MonitoringSnapshot = { runtime, status: st.status, latest };
        if (want.has('metrics')) out.metrics = st.history;
        if (want.has('histogram')) out.histogram = st.histogram;
        if (want.has('threads')) out.threads = st.threadsDetail;
        if (want.has('gc')) out.gc = st.gcEvents;
        if (want.has('actuator')) out.actuator = st.actuator;
        if (want.has('runtime')) out.runtimeInfo = st.runtime;
        return out;
      }

      if (runtime === 'node') {
        const st = nodeMonitoring?.state(id);
        if (!st) throw notMonitored();
        const latest = st.history.length ? st.history[st.history.length - 1] : null;
        const out: MonitoringSnapshot = { runtime, status: st.status, latest };
        if (want.has('metrics')) out.metrics = st.history;
        if (want.has('heapSpaces')) out.heapSpaces = st.heapSpaces;
        if (want.has('gc')) out.gc = st.gcEvents;
        if (want.has('hello')) out.hello = st.hello;
        return out;
      }

      throw new Error(`Monitoring is not supported for type: ${typeOf(id)}`);
    },

    threadDump: async (id, tid) => {
      if (runtimeForType(typeOf(id)) !== 'jvm') throw new Error('Thread dumps are JVM-only');
      if (!monitoring) throw new Error(`No monitoring data for ${id}`);
      return monitoring.requestThreadDump(id, tid);
    },
```

Note: `resolveValid` returns `{ folderKey, config }` where `config` is `RunConfig`, so `ref.config.type` is available.

- [ ] **Step 6: Run the tests — verify they pass**

Run: `npx jest test/bridgeServices.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Stage (DO NOT COMMIT)**

```bash
git add src/mcp/bridgeServices.ts test/bridgeServices.test.ts
```

---

## Task 3: McpBridgeServer — dispatch the new methods (TDD)

**Files:**
- Modify: `src/services/McpBridgeServer.ts:67-82`
- Test: `test/McpBridgeServer.test.ts`

- [ ] **Step 1: Extend the fake services + add round-trip tests**

In `test/McpBridgeServer.test.ts`, replace the `fakeServices()` body (lines 5-18) with one that includes the new methods:

```ts
function fakeServices(): BridgeServices {
  return {
    listConfigs: () => [{ id: 'a', name: 'A', type: 'npm', folderKey: '/w', valid: true }],
    getConfig: (id) => (id === 'a' ? ({ id: 'a' } as any) : undefined),
    currentConfigs: () => [{ folderKey: '/w', configurations: [] }],
    validateConfig: () => ({ ok: true }),
    createConfig: async () => ({ id: 'new' }),
    updateConfig: async () => undefined,
    deleteConfig: async () => undefined,
    runConfig: async (_id, monitor) => ({ monitoring: monitor ? 'requested' : undefined }),
    debugConfig: async () => ({}),
    stopConfig: async () => undefined,
    runStatus: () => ({
      running: true, started: true, failed: false, preparing: false,
      monitored: true, runtime: 'node',
    }),
    monitoringSnapshot: (_id, sections) => ({
      runtime: 'node', status: 'live', latest: { rss: 1 },
      ...(sections?.includes('metrics') ? { metrics: [{ rss: 1 }] } : {}),
    }),
    threadDump: async (_id, tid) => ({
      type: 'threadDump', t: 1, tid, name: 'main', state: 'RUNNABLE', stack: [],
    }) as any,
  };
}
```

Add these tests before the closing `});` of the `describe` block:

```ts
  it('round-trips runStatus', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('runStatus', { id: 'a' });
    expect(res).toMatchObject({ running: true, runtime: 'node', monitored: true });
    client.dispose();
  });

  it('round-trips monitoringSnapshot with sections', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('monitoringSnapshot', { id: 'a', sections: ['metrics'] });
    expect(res).toMatchObject({ runtime: 'node', status: 'live' });
    expect((res as any).metrics).toEqual([{ rss: 1 }]);
    client.dispose();
  });

  it('round-trips threadDump', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('threadDump', { id: 'a', tid: 7 });
    expect(res).toMatchObject({ type: 'threadDump', tid: 7 });
    client.dispose();
  });

  it('forwards the monitor flag on run', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('run', { id: 'a', monitor: true });
    expect(res).toEqual({ monitoring: 'requested' });
    client.dispose();
  });
```

- [ ] **Step 2: Run — verify failure**

Run: `npx jest test/McpBridgeServer.test.ts`
Expected: FAIL — dispatch throws `unknown method: runStatus` (and the `run` monitor case returns `{ monitoring: undefined }` because the server does not yet forward `monitor`).

- [ ] **Step 3: Extend the dispatch switch**

In `src/services/McpBridgeServer.ts`, replace the `dispatch` method body (lines 67-82) with:

```ts
  private dispatch(method: string, params: unknown): Promise<unknown> | unknown {
    const p = (params ?? {}) as {
      id?: string;
      config?: unknown;
      workspaceFolder?: string;
      monitor?: boolean;
      sections?: string[];
      tid?: number;
    };
    switch (method) {
      case 'list': return this.services.listConfigs();
      case 'get': return this.services.getConfig(String(p.id));
      case 'currentConfigs': return this.services.currentConfigs();
      case 'validate': return this.services.validateConfig(p.config);
      case 'create': return this.services.createConfig({ config: p.config, workspaceFolder: p.workspaceFolder });
      case 'update': return this.services.updateConfig(p.config);
      case 'delete': return this.services.deleteConfig(String(p.id));
      case 'run': return this.services.runConfig(String(p.id), p.monitor);
      case 'debug': return this.services.debugConfig(String(p.id), p.monitor);
      case 'stop': return this.services.stopConfig(String(p.id));
      case 'runStatus': return this.services.runStatus(String(p.id));
      case 'monitoringSnapshot': return this.services.monitoringSnapshot(String(p.id), p.sections);
      case 'threadDump': return this.services.threadDump(String(p.id), Number(p.tid));
      default: throw new Error(`unknown method: ${method}`);
    }
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `npx jest test/McpBridgeServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage (DO NOT COMMIT)**

```bash
git add src/services/McpBridgeServer.ts test/McpBridgeServer.test.ts
```

---

## Task 4: server.ts — MCP tool surface

**Files:**
- Modify: `src/mcp/server.ts:141-169`

- [ ] **Step 1: Add the `monitor` param to `run_config`**

In `src/mcp/server.ts`, replace the `run_config` registration (lines 141-149) with:

```ts
server.registerTool(
  'run_config',
  {
    title: 'Run configuration',
    description: 'Start a configuration by id (non-debug). Set `monitor` to attach runtime monitoring (JVM: spring-boot/quarkus/java/tomcat; Node: npm). Then poll get_run_status until started, and get_monitoring_snapshot to observe.',
    inputSchema: {
      id: z.string().describe('The configuration id.'),
      monitor: z.boolean().optional().describe('Attach runtime monitoring (default false). Ignored for non-monitorable types.'),
    },
  },
  async ({ id, monitor }) => text(await client.call('run', { id, monitor })),
);
```

- [ ] **Step 2: Add the `monitor` param to `debug_config`**

Replace the `debug_config` registration (lines 151-159) with:

```ts
server.registerTool(
  'debug_config',
  {
    title: 'Debug configuration',
    description: 'Start a configuration by id in debug mode (if the type supports debugging). Set `monitor` to also attach runtime monitoring.',
    inputSchema: {
      id: z.string().describe('The configuration id.'),
      monitor: z.boolean().optional().describe('Attach runtime monitoring (default false). Ignored for non-monitorable types.'),
    },
  },
  async ({ id, monitor }) => text(await client.call('debug', { id, monitor })),
);
```

- [ ] **Step 3: Register the three new read-only tools**

Immediately after the `stop_config` registration (after line 169), insert:

```ts
server.registerTool(
  'get_run_status',
  {
    title: 'Get run status',
    description: 'Report whether a configuration is running/started/failed/preparing, whether monitoring is attached, and its monitored runtime. Poll this after run_config/debug_config to know when the app is up before profiling.',
    inputSchema: { id: z.string().describe('The configuration id.') },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => text(await client.call('runStatus', { id })),
);

server.registerTool(
  'get_monitoring_snapshot',
  {
    title: 'Get monitoring snapshot',
    description:
      'Read raw runtime telemetry for a monitored configuration. Default (no sections) returns { runtime, status, latest } — the most recent metrics tick — which is cheap and safe to poll repeatedly. ' +
      'Request `sections` to drill in. JVM sections: metrics (full ~60s ring buffer), histogram (top classes by bytes), threads (states, top-by-CPU with stack snippets, deadlock), gc (recent events), actuator (Spring health/HTTP latency/top endpoints), runtime (JVM info; returned under key `runtimeInfo`). ' +
      'Node sections: metrics (ring buffer, incl. event-loop lag), heapSpaces, gc, hello (process info). The payload is runtime-tagged raw data — analyze it yourself.',
    inputSchema: {
      id: z.string().describe('The configuration id.'),
      sections: z.array(z.string()).optional().describe('Optional list of extra sections to include. Omit for the cheap latest-tick-only default.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, sections }) => text(await client.call('monitoringSnapshot', { id, sections })),
);

server.registerTool(
  'get_thread_dump',
  {
    title: 'Get thread dump (JVM only)',
    description: 'Return the full stack trace of a single JVM thread by its numeric thread id (tid). Pick a hot thread id from the `threads` section of get_monitoring_snapshot. JVM configs only.',
    inputSchema: {
      id: z.string().describe('The configuration id.'),
      tid: z.number().describe('The numeric thread id (from the threads section).'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, tid }) => text(await client.call('threadDump', { id, tid })),
);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage (DO NOT COMMIT)**

```bash
git add src/mcp/server.ts
```

---

## Task 5: extension.ts — wire the monitoring services into the bridge

**Files:**
- Modify: `src/extension.ts:113`

- [ ] **Step 1: Pass `monitoring` + `nodeMonitoring` into `createBridgeServices`**

`monitoring` (line 89) and `nodeMonitoring` (line 91) already exist in scope. In `src/extension.ts`, replace line 113:

```ts
    const bridgeServices = createBridgeServices({ svc, store, exec, dbg });
```

with:

```ts
    const bridgeServices = createBridgeServices({ svc, store, exec, dbg, monitoring, nodeMonitoring });
```

The real `ExecutionService` already implements `isRunning/isStarted/isFailed/isPreparing` and `run(cfg, folder, opts?)`; `DebugService.debug(cfg, folder, opts?)` already accepts `{ monitor }`; `MonitoringService` implements `state` + `requestThreadDump`; `NodeMonitoringService` implements `state`. No service signature changes are needed — the structural `BridgeDeps` types are satisfied by the concrete services.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If TS complains that a concrete service is missing a method the dep declares, re-check the method name against the service (they match as of this plan).

- [ ] **Step 3: Stage (DO NOT COMMIT)**

```bash
git add src/extension.ts
```

---

## Task 6: Guide doc — document the profiling workflow

**Files:**
- Modify: `media/mcp/run-config-guide.md`

- [ ] **Step 1: Append the profiling section**

Add this section at the end of `media/mcp/run-config-guide.md`:

```markdown
## Profiling a running application

The extension can attach runtime monitoring to a run and expose the raw
telemetry. Monitorable types: **JVM** — `spring-boot`, `quarkus`, `java`,
`tomcat`; **Node** — `npm`. Other types ignore the `monitor` flag.

Workflow:

1. `list_run_configs` — pick a monitorable config.
2. `run_config` with `monitor: true` (or `debug_config` with `monitor: true`).
   The response's `monitoring` field is `requested` when the runtime supports
   monitoring, or `unsupported` otherwise.
3. Poll `get_run_status(id)` until `started: true` (or `failed: true`). Fields:
   `running`, `started`, `failed`, `preparing`, `monitored`, `runtime`.
4. Poll `get_monitoring_snapshot(id)` to watch the app over time. With no
   `sections` it returns just `{ runtime, status, latest }` (the newest metrics
   tick) — cheap to poll. Add `sections` to drill in:
   - JVM: `metrics` (full ~60s ring buffer), `histogram` (top classes by retained
     bytes), `threads` (state counts, hottest threads with stack snippets,
     deadlock info), `gc` (recent GC events), `actuator` (Spring Boot
     health / HTTP p50-p99 / top endpoints / loggers), `runtime` (JVM/vendor/args;
     returned under key `runtimeInfo`).
   - Node: `metrics` (ring buffer incl. event-loop lag p50/p99), `heapSpaces`,
     `gc`, `hello` (process/version info).
   The payload is raw, runtime-tagged data. Interpret trends yourself: rising
   `heapUsed`/`rss` across ticks suggests a leak; sustained high `cpuLoad`/
   `cpuPercent` or `loopLagP99` suggests a hot path; growing `gc` time suggests
   memory pressure; a non-null `threads.deadlock` is critical.
5. For a JVM hot thread, take its `id` from the `threads` section and call
   `get_thread_dump(id, tid)` for the full stack. Thread dumps are JVM-only.
6. `stop_config(id)` when finished.

If `get_monitoring_snapshot` errors with "No monitoring data", either the run
was not started with `monitor: true`, the type is not monitorable, or the agent
has not connected yet — poll `get_run_status` and retry.
```

- [ ] **Step 2: Stage (DO NOT COMMIT)**

```bash
git add media/mcp/run-config-guide.md
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full test suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass (the pre-existing macOS-only flaky `test/detectTomcat.test.ts:73` realpath quirk is unrelated and may fail locally — confirm it is the only failure and it is that known test); build produces both `out/extension.js` and `out/mcp-server.js`.

- [ ] **Step 2: Confirm the new tools compiled into the MCP bundle**

Run: `grep -c "get_monitoring_snapshot" out/mcp-server.js`
Expected: a count ≥ 1 (the tool name is bundled).

- [ ] **Step 3: Review the staged diff (DO NOT COMMIT)**

Run: `git status && git diff --staged --stat`
Expected: only the 8 files from this plan are staged. Leave committing to the user.

---

## Self-Review notes (addressed)

- **Spec coverage:** `monitor` flag on run/debug (Task 2/4), `get_run_status` (Task 2/4), `get_monitoring_snapshot` with cheap default + sections for both runtimes (Task 2/4), `get_thread_dump` JVM-only (Task 2/4), runtime-tagged raw passthrough (Task 2), bridge wiring (Task 5), error cases — not-monitored, JVM-only thread dump, unsupported-type note, pre-first-tick `latest: null` (Task 2 tests + impl), guide doc (Task 6), tests (Tasks 2/3). All present.
- **Section/tag clash:** JVM `runtime` section returned under `runtimeInfo` — documented in the shared-contracts note, the impl, the tool description, and the guide.
- **Type consistency:** `runtimeForType`, `RunStatus`, `MonitoringSnapshot`, `MonitoredRuntime`, and the `runConfig`/`debugConfig`/`runStatus`/`monitoringSnapshot`/`threadDump` signatures are defined in Task 2 and referenced identically in Tasks 3-5.
- **No-commit rule:** every task stages only; Task 7 explicitly leaves committing to the user.
