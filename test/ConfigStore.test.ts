import { Uri, __resetFs, __writeFs, __watchers, __resetWatchers } from 'vscode';
import { ConfigStore } from '../src/services/ConfigStore';

function folder(name: string, path: string) {
  return { uri: Uri.file(path), name, index: 0 };
}

const runJsonContents = (name: string) => JSON.stringify({
  version: 1,
  configurations: [{
    id: '11111111-2222-3333-4444-555555555555',
    name,
    type: 'npm',
    projectPath: '',
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: { scriptName: 'start', packageManager: 'npm' },
  }],
});

describe('ConfigStore', () => {
  beforeEach(() => { __resetFs(); __resetWatchers(); });

  test('loads configurations for each workspace folder', async () => {
    __writeFs('/ws/a/.vscode/run.json', runJsonContents('App A'));
    __writeFs('/ws/b/.vscode/run.json', runJsonContents('App B'));
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a'), folder('b', '/ws/b')]);
    const a = store.getForFolder('/ws/a');
    const b = store.getForFolder('/ws/b');
    expect(a.configurations[0].name).toBe('App A');
    expect(b.configurations[0].name).toBe('App B');
    store.dispose();
  });

  test('returns empty file when run.json is missing', async () => {
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toEqual([]);
    store.dispose();
  });

  test('surfaces validation error without mutating state', async () => {
    __writeFs('/ws/a/.vscode/run.json', runJsonContents('Orig'));
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    const before = store.getForFolder('/ws/a');
    __writeFs('/ws/a/.vscode/run.json', '{"bad":1}');
    await store.reload('/ws/a');
    expect(store.getForFolder('/ws/a')).toBe(before); // reference-equal: not mutated
    expect(store.lastError('/ws/a')).toMatch(/schema/i);
    store.dispose();
  });

  test('writes atomically via tmp+rename and persists back', async () => {
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    await store.write('/ws/a', {
      version: 1,
      configurations: [{
        id: '11111111-2222-3333-4444-555555555555',
        name: 'New',
        type: 'npm',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: { scriptName: 'start', packageManager: 'npm' },
      }],
    });
    // Reload from disk and verify content.
    await store.reload('/ws/a');
    expect(store.getForFolder('/ws/a').configurations[0].name).toBe('New');
    store.dispose();
  });

  test('fires onChange when watcher fires', async () => {
    __writeFs('/ws/a/.vscode/run.json', runJsonContents('v1'));
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);

    const calls: string[] = [];
    store.onChange(folderPath => calls.push(folderPath));

    __writeFs('/ws/a/.vscode/run.json', runJsonContents('v2'));
    __watchers[0].change.fire(Uri.file('/ws/a/.vscode/run.json'));

    // Allow debounce + reload to complete.
    await new Promise(r => setTimeout(r, 250));
    expect(calls).toContain('/ws/a');
    expect(store.getForFolder('/ws/a').configurations[0].name).toBe('v2');
    store.dispose();
  });
});
