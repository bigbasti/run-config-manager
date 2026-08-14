import { Uri, workspace, window } from 'vscode';
import { DependencyOrchestrator } from '../src/services/DependencyOrchestrator';
import type { RunConfig } from '../src/shared/types';

// Guards the "docker dep stays red after the user fixes it" bug. A failed
// orchestration snapshot used to linger forever with no way to tell it apart
// from a live one, so the tree kept repainting stale failure icons and the
// parent row stayed force-expanded until the parent was re-run.

function custom(id: string, name: string, deps: Array<{ ref: string; delaySeconds?: number }> = []): RunConfig {
  return {
    id, name, type: 'custom-command', projectPath: '', workspaceFolder: 'ws',
    env: {}, programArgs: '', vmArgs: '',
    typeOptions: { command: 'echo', cwd: '', shell: 'default', interactive: false },
    dependsOn: deps,
  } as RunConfig;
}

function docker(id: string, name: string, containerId: string): RunConfig {
  return {
    id, name, type: 'docker', projectPath: '', workspaceFolder: 'ws',
    env: {}, programArgs: '', vmArgs: '',
    typeOptions: { containerId, imageName: '' },
  } as RunConfig;
}

function mkOrch(configs: RunConfig[], liveContainers: Set<string>, startFails: boolean) {
  const byId = new Map(configs.map(c => [c.id, { folderKey: '/ws', config: c, valid: true as const }]));
  const svc = { getById: (id: string) => byId.get(id), list: () => Array.from(byId.values()) } as any;
  const exec = { isRunning: () => false, isStarted: () => false, run: jest.fn(async () => {}) } as any;
  const dbg = { isRunning: () => false, debug: jest.fn(async () => {}) } as any;
  const dockerSvc = {
    isRunning: (cid: string) => liveContainers.has(cid),
    startContainer: jest.fn(async (cid: string) => {
      if (startFails) throw new Error(`No such container: ${cid}`);
      liveContainers.add(cid);
    }),
  } as any;
  const native = {
    getLaunches: () => [], getTasks: async () => [],
    isLaunchRunning: () => false, isTaskRunning: () => false,
  } as any;
  return new DependencyOrchestrator(svc, exec, dbg, dockerSvc, native);
}

describe('DependencyOrchestrator failed-run snapshot', () => {
  beforeEach(() => {
    (workspace as any).workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    (window.showErrorMessage as jest.Mock).mockClear?.();
  });
  afterEach(() => {
    (workspace as any).workspaceFolders = [];
  });

  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;

  test('a dependency failure marks the snapshot finished', async () => {
    const root = custom('a', 'A', [{ ref: 'rcm:d1' }]);
    const d1 = docker('d1', 'D1', 'c1');
    const orch = mkOrch([root, d1], new Set(), true);

    await orch.run(root, folder);

    const snap = orch.snapshotOf('a');
    expect(snap).toBeDefined();
    expect(snap!.statuses.get('rcm:d1')).toBe('failed');
    // Without this flag the tree cannot tell a post-mortem snapshot from a
    // live one, which is what made the icons stick.
    expect(snap!.finished).toBe(true);
  });

  test('later dependencies are marked skipped and the snapshot is finished', async () => {
    const root = custom('a', 'A', [{ ref: 'rcm:d1' }, { ref: 'rcm:d2' }]);
    const orch = mkOrch([root, docker('d1', 'D1', 'c1'), docker('d2', 'D2', 'c2')], new Set(), true);

    await orch.run(root, folder);

    const snap = orch.snapshotOf('a')!;
    expect(snap.statuses.get('rcm:d1')).toBe('failed');
    expect(snap.statuses.get('rcm:d2')).toBe('skipped');
    expect(snap.finished).toBe(true);
  });

  test('a detected cycle also finishes the snapshot', async () => {
    const a = custom('a', 'A', [{ ref: 'rcm:b' }]);
    const b = custom('b', 'B', [{ ref: 'rcm:a' }]);
    const orch = mkOrch([a, b], new Set(), false);

    await orch.run(a, folder);

    expect(orch.snapshotOf('a')!.finished).toBe(true);
  });
});

describe('DependencyOrchestrator.hasUnresolvedFailure', () => {
  beforeEach(() => {
    (workspace as any).workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
  });
  afterEach(() => {
    (workspace as any).workspaceFolders = [];
  });

  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;

  test('false when no orchestration ever ran for that root', () => {
    const orch = mkOrch([custom('a', 'A')], new Set(), false);
    expect(orch.hasUnresolvedFailure('a')).toBe(false);
  });

  test('true right after a dependency failed', async () => {
    const root = custom('a', 'A', [{ ref: 'rcm:d1' }, { ref: 'rcm:d2' }]);
    const orch = mkOrch([root, docker('d1', 'D1', 'c1'), docker('d2', 'D2', 'c2')], new Set(), true);
    await orch.run(root, folder);
    expect(orch.hasUnresolvedFailure('a')).toBe(true);
  });

  test('false once the user has started every failed/skipped dependency by hand', async () => {
    const live = new Set<string>();
    const root = custom('a', 'A', [{ ref: 'rcm:d1' }, { ref: 'rcm:d2' }]);
    const orch = mkOrch([root, docker('d1', 'D1', 'c1'), docker('d2', 'D2', 'c2')], live, true);
    await orch.run(root, folder);
    expect(orch.hasUnresolvedFailure('a')).toBe(true);

    live.add('c1');
    // d2 is still down, so the parent must stay pinned open.
    expect(orch.hasUnresolvedFailure('a')).toBe(true);

    live.add('c2');
    expect(orch.hasUnresolvedFailure('a')).toBe(false);
  });

  test('the root config being skipped does not count as an unresolved failure', async () => {
    // The root's own entry is bookkeeping — its row is painted from live
    // service state, not the snapshot. Counting it would pin the parent row
    // open forever, since the root by definition never started.
    const live = new Set<string>();
    const root = custom('a', 'A', [{ ref: 'rcm:d1' }]);
    const orch = mkOrch([root, docker('d1', 'D1', 'c1')], live, true);
    await orch.run(root, folder);

    expect(orch.snapshotOf('a')!.statuses.get('rcm:a')).toBe('skipped');
    live.add('c1');
    expect(orch.hasUnresolvedFailure('a')).toBe(false);
  });

  test('false while an orchestration is still in flight (nothing has failed yet)', () => {
    const orch = mkOrch([custom('a', 'A', [{ ref: 'rcm:d1' }]), docker('d1', 'D1', 'c1')], new Set(), false);
    // No run started → no snapshot → nothing unresolved.
    expect(orch.hasUnresolvedFailure('a')).toBe(false);
  });
});
