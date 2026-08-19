import * as vscode from 'vscode';
import { Uri, __resetFs, __writeFs, __readFs, __watchers, __resetWatchers, __failReadFs } from 'vscode';
import { ConfigStore } from '../src/services/ConfigStore';
import { EXTENSION_VERSION } from '../src/utils/extensionVersion';

function folder(name: string, path: string) {
  return { uri: Uri.file(path), name, index: 0 };
}

// Every physical run.json write ends in a rename (atomic tmp+rename), so
// counting renames counts writes that actually touched the file.
function countWrites() {
  return jest.spyOn(vscode.workspace.fs, 'rename');
}

const npmConfig = (name: string, extra: Record<string, unknown> = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  name,
  type: 'npm',
  projectPath: '',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
  ...extra,
});

const runJsonContents = (name: string) => JSON.stringify({
  version: '1.0.0',
  configurations: [{
    id: '11111111-2222-3333-4444-555555555555',
    name,
    type: 'npm',
    projectPath: '',
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
  }],
});

describe('ConfigStore', () => {
  beforeEach(() => { __resetFs(); __resetWatchers(); jest.restoreAllMocks(); });

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

  test('legacy version: 1 (number) is coerced to "0.0.0" so migrations run', async () => {
    // Files written before the migration system used `version: 1`
    // (a literal number). On load we must treat that as the
    // earliest version — NOT "1.0.0", which the migrator would see
    // as newer than the running extension and refuse to migrate.
    const legacy = JSON.stringify({
      version: 1,
      configurations: [{
        id: '11111111-2222-3333-4444-555555555555',
        name: 'App',
        type: 'npm',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
      }],
    });
    __writeFs('/ws/legacy/.vscode/run.json', legacy);
    const store = new ConfigStore();
    await store.attach([folder('legacy', '/ws/legacy')]);
    const f = store.getForFolder('/ws/legacy');
    // Loaded successfully (would fail if treated as newer).
    expect(f.configurations).toHaveLength(1);
    // Stamped with the running extension version (semver string).
    expect(typeof f.version).toBe('string');
    expect(f.version).not.toBe('1');
    expect(f.version).toBe(EXTENSION_VERSION);
    store.dispose();
  });

  test('a run.json already at the extension version triggers no write', async () => {
    // Regression: the legacy-version coercion used to rewrite a genuine
    // "1.0.0" down to "0.0.0", which made the file look permanently stale.
    // reload() then wrote it back, the watcher fired, and the whole thing
    // looped forever — the file visibly blinked in the explorer.
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: EXTENSION_VERSION,
      configurations: [npmConfig('App', { closeTerminalOnExit: true })],
      groups: [],
    }));
    const renames = countWrites();
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    expect(renames).not.toHaveBeenCalled();
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
      version: '1.0.0',
      configurations: [{
        id: '11111111-2222-3333-4444-555555555555',
        name: 'New',
        type: 'npm',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
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

  test('write() skips the physical write when the bytes are unchanged', async () => {
    // Defence in depth against rewrite loops: an identical write must not
    // touch the file, because touching it wakes the watcher.
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    const file = {
      version: EXTENSION_VERSION,
      configurations: [npmConfig('New')],
    } as any;

    await store.write('/ws/a', file);
    const renames = countWrites();
    await store.write('/ws/a', file);
    expect(renames).not.toHaveBeenCalled();
    store.dispose();
  });

  test('write() still fires onChange when the write is skipped', async () => {
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    const file = {
      version: EXTENSION_VERSION,
      configurations: [npmConfig('New')],
    } as any;
    await store.write('/ws/a', file);

    const calls: string[] = [];
    store.onChange(k => calls.push(k));
    await store.write('/ws/a', file);
    expect(calls).toEqual(['/ws/a']);
    store.dispose();
  });

  test('write() performs the write when the bytes differ', async () => {
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    await store.write('/ws/a', {
      version: EXTENSION_VERSION,
      configurations: [npmConfig('One')],
    } as any);

    const renames = countWrites();
    await store.write('/ws/a', {
      version: EXTENSION_VERSION,
      configurations: [npmConfig('Two')],
    } as any);
    expect(renames).toHaveBeenCalled();
    expect(__readFs('/ws/a/.vscode/run.json')).toContain('"Two"');
    store.dispose();
  });

  test('a transient read error does not wipe the loaded configurations', async () => {
    // The atomic tmp+rename leaves a window where run.json is briefly
    // unreadable. Collapsing that to an empty file lets the next write
    // from any caller persist the emptiness — real data loss.
    __writeFs('/ws/a/.vscode/run.json', runJsonContents('Keep Me'));
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);

    __failReadFs('/ws/a/.vscode/run.json', 'Unavailable');
    await store.reload('/ws/a');

    expect(store.getForFolder('/ws/a').configurations).toHaveLength(1);
    expect(store.getForFolder('/ws/a').configurations[0].name).toBe('Keep Me');
    store.dispose();
  });

  test('a genuinely missing run.json still yields an empty file', async () => {
    __writeFs('/ws/a/.vscode/run.json', runJsonContents('Gone Soon'));
    const store = new ConfigStore();
    await store.attach([folder('a', '/ws/a')]);
    expect(store.getForFolder('/ws/a').configurations).toHaveLength(1);

    __resetFs();
    await store.reload('/ws/a');
    expect(store.getForFolder('/ws/a').configurations).toEqual([]);
    store.dispose();
  });

  test.each(['FileNotFound', 'EntryNotFound', 'ENOENT'])(
    'treats a %s error as a deleted file, not a transient failure',
    async code => {
      // Failing to recognise a real deletion is the dangerous direction:
      // the tree would keep showing configurations that no longer exist.
      __writeFs('/ws/a/.vscode/run.json', runJsonContents('Gone Soon'));
      const store = new ConfigStore();
      await store.attach([folder('a', '/ws/a')]);

      __failReadFs('/ws/a/.vscode/run.json', code);
      await store.reload('/ws/a');
      expect(store.getForFolder('/ws/a').configurations).toEqual([]);
      store.dispose();
    },
  );

  test('archives the pre-migration file when a migration changes content', async () => {
    // version 0.5.0 predates the 0.6.3 closeTerminalOnExit backfill, and
    // the config lacks the field — so the migration really mutates.
    const before = JSON.stringify({
      version: '0.5.0',
      configurations: [npmConfig('App')],
    });
    __writeFs('/ws/dds2/.vscode/run.json', before);

    const store = new ConfigStore({
      backupHomeDir: '/home/tester',
      now: () => new Date(2026, 7, 19, 9, 13, 33),
    });
    await store.attach([folder('dds2', '/ws/dds2')]);
    await new Promise(r => setTimeout(r, 10));

    const archived = __readFs('/home/tester/.run-configs/dds2_run.json_2026-08-19_09-13-33');
    expect(archived).toBe(before);
    store.dispose();
  });

  test('a migrating file converges: the reload after the migration write is a no-op', async () => {
    // The loop had two legs: reload() wrote, the watcher woke reload().
    // A legitimate migration still writes once — what matters is that the
    // reload it provokes writes nothing more.
    __writeFs('/ws/a/.vscode/run.json', JSON.stringify({
      version: '0.5.0',
      configurations: [npmConfig('App')],
    }));
    const store = new ConfigStore({ backupHomeDir: '/home/tester' });
    await store.attach([folder('a', '/ws/a')]);
    await new Promise(r => setTimeout(r, 10));

    // The migration wrote once.
    expect(__readFs('/ws/a/.vscode/run.json')).toContain(`"version": "${EXTENSION_VERSION}"`);

    // Now replay what the watcher does after that write.
    const renames = countWrites();
    __watchers[0].change.fire(Uri.file('/ws/a/.vscode/run.json'));
    await new Promise(r => setTimeout(r, 250));
    expect(renames).not.toHaveBeenCalled();
    store.dispose();
  });

  test('does not archive when no migration changes content', async () => {
    __writeFs('/ws/dds2/.vscode/run.json', JSON.stringify({
      version: EXTENSION_VERSION,
      configurations: [npmConfig('App', { closeTerminalOnExit: true })],
      groups: [],
    }));
    const createDir = jest.spyOn(vscode.workspace.fs, 'createDirectory');
    const store = new ConfigStore({
      backupHomeDir: '/home/tester',
      now: () => new Date(2026, 7, 19, 9, 13, 33),
    });
    await store.attach([folder('dds2', '/ws/dds2')]);
    await new Promise(r => setTimeout(r, 10));

    expect(createDir).not.toHaveBeenCalled();
    store.dispose();
  });
});
