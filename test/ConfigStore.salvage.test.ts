import { Uri, __resetFs, __writeFs, __resetWatchers } from 'vscode';
import { ConfigStore } from '../src/services/ConfigStore';

function folder(path: string) {
  return { uri: Uri.file(path), name: 'ws', index: 0 };
}

const validRow = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Good',
  type: 'npm',
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm' },
};

const missingTypeOptions = {
  id: '22222222-2222-3333-4444-555555555555',
  name: 'Bad (no typeOptions)',
  type: 'npm',
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
};

describe('ConfigStore salvage', () => {
  beforeEach(() => { __resetFs(); __resetWatchers(); });

  test('entry missing typeOptions is salvaged into invalid list', async () => {
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: 1,
      configurations: [missingTypeOptions],
    }));
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(0);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(1);
    const invalid = store.invalidForFolder('/ws/a')[0];
    expect(invalid.id).toBe(missingTypeOptions.id);
    expect(invalid.name).toBe(missingTypeOptions.name);
    expect(invalid.error).toMatch(/typeOptions/i);
    expect(invalid.rawText).toContain(missingTypeOptions.id);
    store.dispose();
  });

  test('mixed file: one valid, one invalid', async () => {
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: 1,
      configurations: [validRow, missingTypeOptions],
    }));
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(1);
    expect(store.getForFolder('/ws/a').configurations[0].name).toBe('Good');
    expect(store.invalidForFolder('/ws/a')).toHaveLength(1);
    store.dispose();
  });

  test('entry without id is dropped (not salvageable)', async () => {
    const noId = { ...missingTypeOptions } as any;
    delete noId.id;
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: 1,
      configurations: [noId],
    }));
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(0);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(0);
    store.dispose();
  });

  test('entry without string name is dropped', async () => {
    const badName = { ...missingTypeOptions, name: 123 };
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: 1,
      configurations: [badName],
    }));
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(0);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(0);
    store.dispose();
  });

  test('unparseable JSON still goes to top-level lastError with no invalid list', async () => {
    __writeFs('/ws/a/.vscode/run.json', 'not json {');
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(0);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(0);
    expect(store.lastError('/ws/a')).toMatch(/json/i);
    store.dispose();
  });

  test('top-level schema mismatch (wrong version) falls through without invalid list', async () => {
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: 99,
      configurations: [validRow],
    }));
    const store = new ConfigStore();
    await store.attach([folder('/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(1);
    expect(store.invalidForFolder('/ws/a')).toHaveLength(0);
    store.dispose();
  });
});
