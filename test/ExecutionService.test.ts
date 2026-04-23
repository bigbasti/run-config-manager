import { Uri, tasks } from 'vscode';
import { ExecutionService } from '../src/services/ExecutionService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
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
  typeOptions: { scriptName: 'start', packageManager: 'npm' },
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
