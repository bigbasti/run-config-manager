import { Uri, __resetFs, __resetWatchers } from 'vscode';
import { ConfigStore } from '../src/services/ConfigStore';
import { RunConfigService } from '../src/services/RunConfigService';

function folder(path: string) {
  return { uri: Uri.file(path), name: 'ws', index: 0 };
}

const minimal = {
  name: 'App',
  type: 'npm' as const,
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm' as const },
};

describe('RunConfigService', () => {
  beforeEach(() => { __resetFs(); __resetWatchers(); });

  async function makeService(): Promise<{ store: ConfigStore; svc: RunConfigService }> {
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    return { store, svc: new RunConfigService(store) };
  }

  test('create assigns UUID and persists', async () => {
    const { svc, store } = await makeService();
    const created = await svc.create('/ws/a', minimal);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    await store.reload('/ws/a');
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(1);
    expect(store.getForFolder('/ws/a').configurations[0].name).toBe('App');
    store.dispose();
  });

  test('update modifies an existing config', async () => {
    const { svc, store } = await makeService();
    const c = await svc.create('/ws/a', minimal);
    await svc.update('/ws/a', { ...c, name: 'Renamed' });
    await store.reload('/ws/a');
    expect(store.getForFolder('/ws/a').configurations[0].name).toBe('Renamed');
    store.dispose();
  });

  test('update throws on unknown id', async () => {
    const { svc } = await makeService();
    await expect(
      svc.update('/ws/a', { ...minimal, id: '11111111-2222-3333-4444-555555555555' } as any),
    ).rejects.toThrow(/not found/i);
  });

  test('delete removes config', async () => {
    const { svc, store } = await makeService();
    const c = await svc.create('/ws/a', minimal);
    await svc.delete('/ws/a', c.id);
    await store.reload('/ws/a');
    expect(store.getForFolder('/ws/a').configurations).toEqual([]);
    store.dispose();
  });

  test('delete is a no-op for unknown id', async () => {
    const { svc } = await makeService();
    await expect(svc.delete('/ws/a', 'missing-id')).resolves.toBeUndefined();
  });

  test('getById returns the configuration with matching id', async () => {
    const { svc } = await makeService();
    const c = await svc.create('/ws/a', minimal);
    expect(svc.getById(c.id)?.config.id).toBe(c.id);
    expect(svc.getById(c.id)?.folderKey).toBe('/ws/a');
  });

  test('list returns all configs across folders', async () => {
    const { svc, store } = await makeService();
    await svc.create('/ws/a', { ...minimal, name: 'One' });
    await svc.create('/ws/a', { ...minimal, name: 'Two' });
    expect(svc.list().map(c => c.config.name)).toEqual(['One', 'Two']);
    store.dispose();
  });
});
