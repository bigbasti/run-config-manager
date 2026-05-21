import { Uri, tasks } from 'vscode';
import { ExecutionService } from '../src/services/ExecutionService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import { QuarkusAdapter } from '../src/adapters/quarkus/QuarkusAdapter';
import type { RunConfig } from '../src/shared/types';

const cfg: RunConfig = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'App',
  type: 'npm',
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
};

const quarkusCfg: RunConfig = {
  id: 'qqqqqqqq-1111-2222-3333-444444444444',
  name: 'Quarkus App',
  type: 'quarkus',
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: {
    launchMode: 'maven' as const,
    buildTool: 'maven' as const,
    gradleCommand: './gradlew' as const,
    profile: '',
    jdkPath: '',
    module: '',
    gradlePath: '',
    mavenPath: '',
    buildRoot: '',
    debugPort: 5005,
    colorOutput: false,
  },
};

const folder = { uri: Uri.file('/ws/a'), name: 'a', index: 0 };

describe('ExecutionService', () => {
  let svc: ExecutionService;

  beforeEach(() => {
    const reg = new AdapterRegistry();
    reg.register(new NpmAdapter());
    svc = new ExecutionService(reg);
    (tasks.executeTask as any).mockClear();
  });

  test('run() calls tasks.executeTask and marks config running', async () => {
    await svc.run(cfg, folder as any);
    expect(tasks.executeTask).toHaveBeenCalledTimes(1);
    expect(svc.isRunning(cfg.id)).toBe(true);
  });

  test('run() is a no-op when already running', async () => {
    await svc.run(cfg, folder as any);
    await svc.run(cfg, folder as any);
    expect(tasks.executeTask).toHaveBeenCalledTimes(1);
  });

  test('stop() terminates execution and clears state', async () => {
    await svc.run(cfg, folder as any);
    await svc.stop(cfg.id);
    expect(svc.isRunning(cfg.id)).toBe(false);
  });

  test('natural task end clears running state', async () => {
    const execution = await svc.run(cfg, folder as any);
    (tasks as any).__endEmitter.fire({ execution });
    expect(svc.isRunning(cfg.id)).toBe(false);
  });

  test('fires onRunningChanged at least on start and end', async () => {
    // Adapters with prepareLaunch also emit two extra events (preparing
    // enter/exit) before start. We assert inclusive rather than exact to
    // stay resilient to adapters adding or dropping preparing phases.
    const events: string[] = [];
    svc.onRunningChanged(id => events.push(id));
    const execution = await svc.run(cfg, folder as any);
    (tasks as any).__endEmitter.fire({ execution });
    expect(events.filter(e => e === cfg.id).length).toBeGreaterThanOrEqual(2);
  });
});

describe('ExecutionService — Quarkus monitoring delay', () => {
  // The monitoring agent's connect-retry window is 10 s. Quarkus dev mode
  // compiles before forking the JVM, so spawning the agent immediately after
  // executeTask would exhaust that window before the JVM is ready.
  // ExecutionService must delay monitoring.attach for Quarkus configs.

  let svc: ExecutionService;
  let monitoring: { attach: jest.Mock; detach: jest.Mock; state: jest.Mock; onChanged: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    const reg = new AdapterRegistry();
    reg.register(new QuarkusAdapter());
    monitoring = {
      attach: jest.fn(),
      detach: jest.fn(),
      state: jest.fn().mockReturnValue(undefined),
      onChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    };
    svc = new ExecutionService(reg, monitoring as any);
    (tasks.executeTask as any).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    svc.dispose();
  });

  test('monitoring.attach is NOT called immediately for a Quarkus config', async () => {
    // Use legacyFakeTimers=false so real I/O (allocateFreePort net.createServer)
    // still fires while setTimeout/setInterval are faked.
    // We run the async part first, then check the synchronous timer state.
    const runPromise = svc.run(quarkusCfg, folder as any, { monitor: true });
    // Let real I/O (allocateFreePort) complete without advancing fake timers.
    await runPromise;

    // attach must not have fired yet — the delay hasn't elapsed.
    expect(monitoring.attach).not.toHaveBeenCalled();
  });

  test('monitoring.attach fires after the delay when the config is still running', async () => {
    await svc.run(quarkusCfg, folder as any, { monitor: true });
    expect(monitoring.attach).not.toHaveBeenCalled();

    // Advance past the delay — attach should now fire.
    jest.runAllTimers();

    expect(monitoring.attach).toHaveBeenCalledTimes(1);
    const [configId, pid, port] = monitoring.attach.mock.calls[0];
    expect(configId).toBe(quarkusCfg.id);
    expect(pid).toBe(0); // ShellExecution — no RunTerminal, so pid is always 0
    expect(typeof port).toBe('number');
  });

  test('monitoring.attach is suppressed when config is stopped before the delay fires', async () => {
    await svc.run(quarkusCfg, folder as any, { monitor: true });
    await svc.stop(quarkusCfg.id);

    jest.runAllTimers();

    // The execution token guard must prevent the stale attach.
    expect(monitoring.attach).not.toHaveBeenCalled();
  });
});
