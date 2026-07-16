import type * as vscode from 'vscode';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';
import { RunConfigSchema } from '../shared/schema';
import type { MonitoringState } from '../services/MonitoringService';
import type { NodeMonitoringState } from '../services/NodeMonitoringService';
import type { ThreadDump } from '../services/monitoring/AgentMessage';

export interface ConfigSummary {
  id: string;
  name: string;
  type: string;
  folderKey: string;
  valid: boolean;
}

export interface ValidateResult {
  ok: boolean;
  errors?: { path: string; message: string }[];
}

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

export interface BridgeServices {
  listConfigs(): ConfigSummary[];
  getConfig(id: string): RunConfig | InvalidConfigEntry | undefined;
  currentConfigs(): { folderKey: string; configurations: RunConfig[] }[];
  validateConfig(candidate: unknown): ValidateResult;
  createConfig(params: { config: unknown; workspaceFolder?: string }): Promise<{ id: string }>;
  updateConfig(config: unknown): Promise<void>;
  deleteConfig(id: string): Promise<void>;
  runConfig(id: string, monitor?: boolean): Promise<{ monitoring?: 'requested' | 'unsupported' }>;
  debugConfig(id: string, monitor?: boolean): Promise<{ monitoring?: 'requested' | 'unsupported' }>;
  stopConfig(id: string): Promise<void>;
  runStatus(id: string): RunStatus;
  monitoringSnapshot(id: string, sections?: string[]): MonitoringSnapshot;
  threadDump(id: string, tid: number): Promise<ThreadDump>;
}

// Narrow structural views of the real services — keeps this module unit-testable
// with plain fakes and free of concrete service imports.
export interface BridgeDeps {
  svc: {
    list(): { folderKey: string; config: RunConfig | InvalidConfigEntry; valid: boolean }[];
    getById(id: string):
      | { folderKey: string; config: RunConfig | InvalidConfigEntry; valid: boolean }
      | undefined;
    create(folderKey: string, data: Omit<RunConfig, 'id'>): Promise<RunConfig>;
    update(folderKey: string, cfg: RunConfig): Promise<void>;
    delete(folderKey: string, id: string): Promise<void>;
  };
  store: {
    folderKeys(): string[];
    getFolder(key: string): vscode.WorkspaceFolder | undefined;
    getForFolder(key: string): { configurations: RunConfig[] };
  };
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
}

// A syntactically valid UUID used only to satisfy the schema's `id` field when
// validating a candidate that has not been assigned an id yet.
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

function issuesToErrors(issues: { path: (string | number)[]; message: string }[]) {
  return issues.map(i => ({ path: i.path.join('.'), message: i.message }));
}

export function createBridgeServices(deps: BridgeDeps): BridgeServices {
  const { svc, store, exec, dbg, monitoring, nodeMonitoring } = deps;

  const resolveValid = (id: string): { folderKey: string; config: RunConfig } => {
    const ref = svc.getById(id);
    if (!ref) throw new Error(`Configuration not found: ${id}`);
    if (!ref.valid) throw new Error(`Configuration is invalid: ${id}`);
    return ref as { folderKey: string; config: RunConfig };
  };

  const folderOrThrow = (key: string): vscode.WorkspaceFolder => {
    const f = store.getFolder(key);
    if (!f) throw new Error(`Unknown workspace folder: ${key}`);
    return f;
  };

  const typeOf = (id: string): string => {
    const ref = svc.getById(id);
    if (!ref) throw new Error(`Configuration not found: ${id}`);
    return (ref.config as { type?: string }).type ?? '';
  };

  return {
    listConfigs: () =>
      svc.list().map(r => ({
        id: r.config.id,
        name: (r.config as { name?: string }).name ?? '(invalid)',
        type: (r.config as { type?: string }).type ?? 'invalid',
        folderKey: r.folderKey,
        valid: r.valid,
      })),

    getConfig: id => svc.getById(id)?.config,

    currentConfigs: () =>
      store.folderKeys().map(k => ({
        folderKey: k,
        configurations: store.getForFolder(k).configurations,
      })),

    validateConfig: candidate => {
      const res = RunConfigSchema.safeParse(candidate);
      if (res.success) return { ok: true };
      return { ok: false, errors: issuesToErrors(res.error.issues) };
    },

    createConfig: async ({ config, workspaceFolder }) => {
      const keys = store.folderKeys();
      let key = workspaceFolder;
      if (!key) {
        if (keys.length === 1) key = keys[0];
        else throw new Error(`workspaceFolder is required; choose one of: ${keys.join(', ')}`);
      }
      if (!keys.includes(key)) throw new Error(`Unknown workspace folder: ${key}`);

      const src = config as Record<string, unknown>;
      const parsed = RunConfigSchema.safeParse({ ...src, id: PLACEHOLDER_ID });
      if (!parsed.success) {
        throw new Error(
          `Invalid configuration: ${issuesToErrors(parsed.error.issues)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ')}`,
        );
      }
      const { id: _dropId, ...rest } = src;
      void _dropId;
      const created = await svc.create(key, rest as unknown as Omit<RunConfig, 'id'>);
      return { id: created.id };
    },

    updateConfig: async config => {
      const parsed = RunConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(
          `Invalid configuration: ${issuesToErrors(parsed.error.issues)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ')}`,
        );
      }
      const cfg = parsed.data as RunConfig;
      const ref = svc.getById(cfg.id);
      if (!ref) throw new Error(`Configuration not found: ${cfg.id}`);
      await svc.update(ref.folderKey, cfg);
    },

    deleteConfig: async id => {
      const ref = svc.getById(id);
      if (!ref) return;
      await svc.delete(ref.folderKey, id);
    },

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

    stopConfig: async id => {
      await exec.stop(id);
    },

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
  };
}
