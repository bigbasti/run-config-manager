import { Uri, __resetFs, __writeFs, __resetWatchers } from 'vscode';
import { ConfigStore } from '../src/services/ConfigStore';
import { RunConfigService } from '../src/services/RunConfigService';

function folder(path: string) {
  return { uri: Uri.file(path), name: 'ws', index: 0 };
}

const invalidRow = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Bad',
  type: 'npm',
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  // no typeOptions
};

describe('RunConfigService with invalid entries', () => {
  beforeEach(() => { __resetFs(); __resetWatchers(); });

  async function makeWithInvalid() {
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: '1.0.0',
      configurations: [invalidRow],
    }));
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    return { store, svc: new RunConfigService(store) };
  }

  test('list() returns mixed refs with valid flag', async () => {
    const { svc, store } = await makeWithInvalid();
    const refs = svc.list();
    expect(refs).toHaveLength(1);
    expect(refs[0].valid).toBe(false);
    expect(refs[0].config.id).toBe(invalidRow.id);
    store.dispose();
  });

  test('update() on an invalid id promotes to valid and drops from invalid list', async () => {
    const { svc, store } = await makeWithInvalid();
    const fixed = {
      ...invalidRow,
      typeOptions: { scriptName: 'start', packageManager: 'npm' as const },
    };
    await svc.update('/ws/a', fixed as any);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(1);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(0);
    store.dispose();
  });

  test('update() on unknown id still throws', async () => {
    const { svc } = await makeWithInvalid();
    await expect(
      svc.update('/ws/a', { ...invalidRow, id: '99999999-2222-3333-4444-555555555555' } as any),
    ).rejects.toThrow(/not found/i);
  });

  test('delete() removes invalid-only entry', async () => {
    const { svc, store } = await makeWithInvalid();
    await svc.delete('/ws/a', invalidRow.id);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(0);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(0);
    store.dispose();
  });
});
