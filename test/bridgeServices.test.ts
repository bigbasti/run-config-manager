import { createBridgeServices, BridgeDeps } from '../src/mcp/bridgeServices';
import type { RunConfig } from '../src/shared/types';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeNpm(id: string, name: string): RunConfig {
  return {
    id, name, projectPath: '/w', workspaceFolder: '/w',
    env: {}, programArgs: '', vmArgs: '',
    type: 'npm',
    typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
  } as RunConfig;
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
    exec: { run: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) },
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
});
