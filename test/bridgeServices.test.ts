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

describe('bridgeServices', () => {
  it('lists config summaries', () => {
    const s = createBridgeServices(deps());
    expect(s.listConfigs()).toEqual([
      { id: VALID_ID, name: 'Web', type: 'npm', folderKey: '/w', valid: true },
    ]);
  });

  it('validate returns ok for a good candidate', () => {
    const s = createBridgeServices(deps());
    expect(s.validateConfig(makeNpm(VALID_ID, 'Web'))).toEqual({ ok: true });
  });

  it('validate returns path-scoped errors for a bad candidate', () => {
    const s = createBridgeServices(deps());
    const bad = { ...makeNpm(VALID_ID, ''), name: '' };
    const res = s.validateConfig(bad);
    expect(res.ok).toBe(false);
    expect(res.errors!.some(e => e.path === 'name')).toBe(true);
  });

  it('create defaults to the only folder when workspaceFolder omitted', async () => {
    const d = deps();
    const s = createBridgeServices(d);
    const out = await s.createConfig({ config: { ...makeNpm(VALID_ID, 'Web') } });
    expect(out).toEqual({ id: VALID_ID });
    expect(d.svc.create).toHaveBeenCalledWith('/w', expect.objectContaining({ type: 'npm' }));
  });

  it('create errors when multiple folders and none chosen', async () => {
    const d = deps({
      store: {
        folderKeys: () => ['/a', '/b'],
        getFolder: (k) => ({ uri: { fsPath: k }, name: k, index: 0 } as any),
        getForFolder: () => ({ configurations: [] }),
      },
    });
    const s = createBridgeServices(d);
    await expect(s.createConfig({ config: makeNpm(VALID_ID, 'Web') }))
      .rejects.toThrow(/workspaceFolder is required/);
  });

  it('run resolves the folder from the config id and calls exec.run', async () => {
    const d = deps();
    const s = createBridgeServices(d);
    await s.runConfig(VALID_ID);
    expect(d.exec.run).toHaveBeenCalled();
  });

  it('run throws for an unknown id', async () => {
    const s = createBridgeServices(deps());
    await expect(s.runConfig('nope')).rejects.toThrow(/not found/);
  });

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
    const requestThreadDump = jest.fn(async () => dump as any);
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
});
