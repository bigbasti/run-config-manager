import { PythonAdapter } from '../src/adapters/python/PythonAdapter';
import type { RunConfig } from '../src/shared/types';

const base: any = {
  id: 'i', name: 'x', projectPath: '', workspaceFolder: '',
  env: {}, programArgs: '', vmArgs: '',
};

function cfg(overrides: any): RunConfig {
  return {
    ...base, type: 'python',
    typeOptions: {
      launchMode: 'script',
      pythonPath: '/opt/py',
      scriptPath: 'app.py',
      moduleName: '', framework: '', frameworkCommand: '',
      pytestArgs: '', customArgs: '', buildRoot: '',
      ...overrides,
    },
  } as RunConfig;
}

describe('PythonAdapter.buildCommand', () => {
  const adapter = new PythonAdapter();
  test('script mode', () => {
    const out = adapter.buildCommand(cfg({}));
    expect(out.args).toEqual(['app.py']);
  });
  test('module mode', () => {
    const out = adapter.buildCommand(cfg({ launchMode: 'module', moduleName: 'pkg.cli' }));
    expect(out.args).toEqual(['-m', 'pkg.cli']);
  });
});

describe('PythonAdapter.getDebugConfig', () => {
  const adapter = new PythonAdapter();
  const folder = { uri: require('vscode').Uri.file('/proj'), name: 'proj', index: 0 } as any;
  test('returns a debugpy attach configuration', () => {
    const dc = adapter.getDebugConfig(cfg({}), folder);
    expect(dc.type).toBe('debugpy');
    expect(dc.request).toBe('attach');
    expect(dc.connect).toBeDefined();
  });
  test('uses port stashed on cfg by prepareLaunch (not hardcoded 5678)', () => {
    const c = cfg({});
    (c as any).__debugPort = 6789;
    const dc = adapter.getDebugConfig(c, folder);
    expect(dc.connect).toEqual({ host: '127.0.0.1', port: 6789 });
  });
});

describe('PythonAdapter.prepareLaunch (debug)', () => {
  const adapter = new PythonAdapter();
  const folder = { uri: require('vscode').Uri.file('/proj'), name: 'proj', index: 0 } as any;

  // prepareLaunch probes for debugpy via spawn. Stub child_process.spawn so
  // the probe reports success without touching the host's python install.
  beforeAll(() => {
    const cp = require('child_process');
    jest.spyOn(cp, 'spawn').mockImplementation(() => {
      const handlers: Record<string, Function[]> = {};
      const child: any = {
        stdout: { on: () => {} },
        kill: () => {},
        on: (ev: string, fn: Function) => {
          (handlers[ev] = handlers[ev] || []).push(fn);
          if (ev === 'close') setImmediate(() => fn(0));
          return child;
        },
      };
      return child;
    });
  });
  afterAll(() => jest.restoreAllMocks());

  test('non-debug returns empty result', async () => {
    const out = await adapter.prepareLaunch(cfg({}), folder, { debug: false });
    expect(out).toEqual({});
  });

  test('debug=true with vmArgs hoists them before debugpy and clears them on cfg', async () => {
    const c = { ...cfg({}), vmArgs: '-O -W default' } as any;
    const out = await adapter.prepareLaunch(c, folder, { debug: true });
    expect(out.extraArgs).toEqual([
      '-O', '-W', 'default',
      '-m', 'debugpy', '--listen', '127.0.0.1:5678', '--wait-for-client',
    ]);
    expect(out.cfg).toBeDefined();
    expect((out.cfg as any).vmArgs).toBe('');
    expect((out.cfg as any).__debugPort).toBe(5678);
  });

  test('debug=true with custom debugPort threads the port to extraArgs and cfg', async () => {
    const out = await adapter.prepareLaunch(cfg({}), folder, { debug: true, debugPort: 6789 });
    expect(out.extraArgs).toEqual([
      '-m', 'debugpy', '--listen', '127.0.0.1:6789', '--wait-for-client',
    ]);
    expect((out.cfg as any).__debugPort).toBe(6789);
  });

  test('debug=true with empty vmArgs emits only the debugpy bootstrap', async () => {
    const out = await adapter.prepareLaunch(cfg({}), folder, { debug: true });
    expect(out.extraArgs).toEqual([
      '-m', 'debugpy', '--listen', '127.0.0.1:5678', '--wait-for-client',
    ]);
  });
});
