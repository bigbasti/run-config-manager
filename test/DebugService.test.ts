import { Uri, debug } from 'vscode';
import { DebugService } from '../src/services/DebugService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const cfg: RunConfig = {
  id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  name: 'App',
  type: 'npm',
  projectPath: 'frontend',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm' },
};

const folder = { uri: Uri.file('/ws/a'), name: 'a', index: 0 };

describe('DebugService', () => {
  let svc: DebugService;

  beforeEach(() => {
    const reg = new AdapterRegistry();
    reg.register(new NpmAdapter());
    svc = new DebugService(reg);
    (debug.startDebugging as any).mockClear();
  });

  test('debug() calls startDebugging with adapter-generated config', async () => {
    await svc.debug(cfg, folder as any);
    expect(debug.startDebugging).toHaveBeenCalledTimes(1);
    const [f, conf] = (debug.startDebugging as any).mock.calls[0];
    expect(f).toBe(folder);
    expect(conf.type).toBe('pwa-node');
    expect(conf.name).toBe('App');
  });

  test('tracks running debug session and marks isRunning true', async () => {
    await svc.debug(cfg, folder as any);
    expect(svc.isRunning(cfg.id)).toBe(true);
  });

  test('onDidTerminateDebugSession clears running state', async () => {
    await svc.debug(cfg, folder as any);
    (debug as any).__termEmitter.fire({ name: 'App' });
    expect(svc.isRunning(cfg.id)).toBe(false);
  });
});
