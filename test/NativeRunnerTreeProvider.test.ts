import {
  Uri, Task,
  __setLaunchConfig, __resetLaunchConfig,
  __setFetchableTasks, __resetFetchableTasks,
  workspace, debug,
} from 'vscode';
import { NativeRunnerService } from '../src/services/NativeRunnerService';
import { NativeRunnerTreeProvider, type NativeNode } from '../src/ui/NativeRunnerTreeProvider';

const folderA = { uri: Uri.file('/ws/a'), name: 'a', index: 0 };

function workspaceTask(name: string, dependsOn?: string | string[]): Task {
  const raw: any = { label: name, type: 'shell', command: 'echo' };
  if (dependsOn !== undefined) raw.dependsOn = dependsOn;
  const t = new Task({ type: 'shell' }, folderA, name, 'Workspace', {});
  // Our service reads `task.raw` from tasks.json — populated via workspace.fs
  // below. The handle itself just needs to carry the name.
  return t;
}

async function writeTasksJson(entries: any[]): Promise<void> {
  await workspace.fs.writeFile(
    Uri.joinPath(folderA.uri, '.vscode', 'tasks.json'),
    new TextEncoder().encode(JSON.stringify({ version: '2.0.0', tasks: entries })),
  );
}

describe('NativeRunnerTreeProvider', () => {
  let svc: NativeRunnerService;
  let tree: NativeRunnerTreeProvider;

  async function waitForTasksCache() {
    // Kick the first render so the async fetchTasks fires, then flush.
    tree.getChildren();
    await new Promise(r => setImmediate(r));
  }

  beforeEach(async () => {
    __resetLaunchConfig();
    __resetFetchableTasks();
    // Clear in-memory FS files from any previous test.
    try {
      await workspace.fs.delete(Uri.joinPath(folderA.uri, '.vscode', 'tasks.json'));
    } catch { /* not there */ }
    (workspace as any).workspaceFolders = [folderA];
    svc = new NativeRunnerService();
    tree = new NativeRunnerTreeProvider(svc);
  });

  afterEach(() => {
    svc.dispose();
    (workspace as any).workspaceFolders = [];
  });

  test('root children: launches at top level, workspace tasks grouped', async () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [{ name: 'Launch A', type: 'node', request: 'launch' }],
    });
    await writeTasksJson([{ label: 'buildA', type: 'shell', command: 'make' }]);
    __setFetchableTasks([
      workspaceTask('buildA'),
      // Auto-detected task — not in the group; only surfaces as a dep.
      new Task({ type: 'npm' }, folderA, 'start', 'npm', {}),
    ]);

    await waitForTasksCache();
    const roots = tree.getChildren();
    const labels = roots.map(n =>
      n.kind === 'launch' ? `L:${n.launch.name}` :
      n.kind === 'tasksGroup' ? `G:Tasks(${n.count})` :
      '?',
    );
    expect(labels).toEqual(['L:Launch A', 'G:Tasks(1)']);

    // The group expands to the workspace-sourced tasks.
    const group = roots.find(n => n.kind === 'tasksGroup')!;
    const groupChildren = tree.getChildren(group);
    expect(groupChildren.map(c => (c as any).task.name)).toEqual(['buildA']);

    // And the group item itself is Collapsed (not Expanded) by default.
    const item = tree.getTreeItem(group);
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  test('tasks group is omitted when no workspace tasks exist', async () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [{ name: 'Launch A', type: 'node', request: 'launch' }],
    });
    __setFetchableTasks([]);
    await waitForTasksCache();
    const roots = tree.getChildren();
    expect(roots.map(n => n.kind)).toEqual(['launch']);
  });

  test('task with dependsOn expands its dependencies as children', async () => {
    await writeTasksJson([
      { label: 'all', type: 'shell', command: 'echo', dependsOn: ['compile', 'lint'] },
      { label: 'compile', type: 'shell', command: 'tsc' },
      { label: 'lint', type: 'shell', command: 'eslint' },
    ]);
    __setFetchableTasks([
      workspaceTask('all', ['compile', 'lint']),
      workspaceTask('compile'),
      workspaceTask('lint'),
    ]);

    await waitForTasksCache();
    const group = tree.getChildren().find(n => n.kind === 'tasksGroup')!;
    const tasks = tree.getChildren(group);
    const all = tasks.find(n => n.kind === 'task' && n.task.name === 'all') as Extract<NativeNode, { kind: 'task' }>;
    expect(all).toBeDefined();
    const children = tree.getChildren(all);
    const names = children.map(c => c.kind === 'depTask' ? c.task.name : c.kind === 'depMissing' ? `MISSING:${c.name}` : '?');
    expect(names).toEqual(['compile', 'lint']);
  });

  test('dependsOn chains recurse to another level', async () => {
    await writeTasksJson([
      { label: 'all', type: 'shell', command: 'echo', dependsOn: ['compile'] },
      { label: 'compile', type: 'shell', command: 'tsc', dependsOn: ['gen'] },
      { label: 'gen', type: 'shell', command: 'gen' },
    ]);
    __setFetchableTasks([
      workspaceTask('all', ['compile']),
      workspaceTask('compile', ['gen']),
      workspaceTask('gen'),
    ]);

    await waitForTasksCache();
    const group = tree.getChildren().find(n => n.kind === 'tasksGroup')!;
    const tasks = tree.getChildren(group);
    const all = tasks.find(n => n.kind === 'task' && n.task.name === 'all') as Extract<NativeNode, { kind: 'task' }>;
    const level1 = tree.getChildren(all);
    expect(level1.map(n => (n as any).task?.name)).toEqual(['compile']);
    const compile = level1[0];
    const level2 = tree.getChildren(compile);
    expect(level2.map(n => (n as any).task?.name)).toEqual(['gen']);
    // gen has no dependsOn — rendering as leaf.
    const gen = level2[0];
    expect(tree.getChildren(gen)).toEqual([]);
  });

  test('dependsOn to a non-existent task shows as depMissing', async () => {
    await writeTasksJson([
      { label: 'all', type: 'shell', command: 'echo', dependsOn: ['ghost'] },
    ]);
    __setFetchableTasks([workspaceTask('all', ['ghost'])]);

    await waitForTasksCache();
    const group = tree.getChildren().find(n => n.kind === 'tasksGroup')!;
    const tasks = tree.getChildren(group);
    const all = tasks[0] as Extract<NativeNode, { kind: 'task' }>;
    const children = tree.getChildren(all);
    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe('depMissing');
    if (children[0].kind === 'depMissing') {
      expect(children[0].name).toBe('ghost');
      expect(children[0].taskKind).toBe('task');
    }
  });

  test('launch preLaunchTask + postDebugTask + compound members render as children', async () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [
        { name: 'Debug', type: 'node', request: 'launch', preLaunchTask: 'build', postDebugTask: 'clean' },
        { name: 'Attach', type: 'node', request: 'attach' },
      ],
      compounds: [
        { name: 'Everything', configurations: ['Debug', 'Attach'] },
      ],
    });
    await writeTasksJson([
      { label: 'build', type: 'shell', command: 'make' },
      { label: 'clean', type: 'shell', command: 'rm' },
    ]);
    __setFetchableTasks([workspaceTask('build'), workspaceTask('clean')]);

    await waitForTasksCache();
    const roots = tree.getChildren();
    const debug_ = roots.find(n => n.kind === 'launch' && n.launch.name === 'Debug')!;
    const debugChildren = tree.getChildren(debug_);
    expect(debugChildren.map(n => n.kind === 'depTask' ? `T:${n.task.name}` : '?')).toEqual(['T:build', 'T:clean']);

    const compound = roots.find(n => n.kind === 'launch' && n.launch.name === 'Everything')!;
    const compoundChildren = tree.getChildren(compound);
    expect(compoundChildren.map(n => n.kind === 'depLaunch' ? `L:${n.launch.name}` : '?')).toEqual(['L:Debug', 'L:Attach']);
  });

  test('cyclic dependsOn is truncated at max depth without hanging', async () => {
    await writeTasksJson([
      { label: 'a', type: 'shell', command: 'echo', dependsOn: ['b'] },
      { label: 'b', type: 'shell', command: 'echo', dependsOn: ['a'] },
    ]);
    __setFetchableTasks([workspaceTask('a', ['b']), workspaceTask('b', ['a'])]);

    await waitForTasksCache();
    const group = tree.getChildren().find(n => n.kind === 'tasksGroup')!;
    let node: NativeNode | undefined = tree.getChildren(group)[0];
    // Drill down until we hit the depth cap. Should terminate.
    for (let i = 0; i < 20 && node; i++) {
      const children = tree.getChildren(node);
      if (children.length === 0) return;
      node = children[0];
    }
    throw new Error('Tree did not terminate after 20 levels');
  });

  test('running launch picks up green running indicator', async () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [{ name: 'Debug', type: 'node', request: 'launch' }],
    });
    await waitForTasksCache();
    const node = tree.getChildren().find(n => n.kind === 'launch' && n.launch.name === 'Debug')!;
    let item = tree.getTreeItem(node);
    expect(item.contextValue).toBe('nativeLaunchIdle');

    (debug as any).__startEmitter.fire({ configuration: { name: 'Debug' }, name: 'Debug' });
    item = tree.getTreeItem(node);
    expect(item.contextValue).toBe('nativeLaunchRunning');
    expect(String(item.description ?? '')).toContain('running');
  });
});
