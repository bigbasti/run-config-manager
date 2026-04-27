import {
  Uri, Task, EventEmitter,
  __setLaunchConfig, __resetLaunchConfig,
  __setFetchableTasks, __resetFetchableTasks,
  workspace, tasks, debug,
} from 'vscode';
import { NativeRunnerService, type NativeLaunch } from '../src/services/NativeRunnerService';

const folderA = { uri: Uri.file('/ws/a'), name: 'a', index: 0 };
const folderB = { uri: Uri.file('/ws/b'), name: 'b', index: 1 };

describe('NativeRunnerService', () => {
  let svc: NativeRunnerService;

  beforeEach(() => {
    __resetLaunchConfig();
    __resetFetchableTasks();
    (workspace as any).workspaceFolders = [folderA, folderB];
    svc = new NativeRunnerService();
  });

  afterEach(() => {
    svc.dispose();
    (workspace as any).workspaceFolders = [];
  });

  test('getLaunches returns configs + compounds across folders', () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [
        { name: 'Run API', type: 'node', request: 'launch' },
        { name: 'Attach Debugger', type: 'node', request: 'attach' },
      ],
      compounds: [
        { name: 'Run All', configurations: ['Run API', 'Attach Debugger'] },
      ],
    });
    __setLaunchConfig(folderB.uri.fsPath, {
      configurations: [{ name: 'Frontend', type: 'chrome', request: 'launch' }],
    });

    const launches = svc.getLaunches();
    expect(launches).toHaveLength(4);
    expect(launches.find(l => l.name === 'Run API')?.launchType).toBe('node');
    const compound = launches.find(l => l.kind === 'compound');
    expect(compound?.compoundMembers).toEqual(['Run API', 'Attach Debugger']);
  });

  test('getLaunches skips malformed entries', () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [
        null,
        { type: 'node' }, // no name
        'string',
        { name: 'Good', type: 'node', request: 'launch' },
      ],
    });
    const launches = svc.getLaunches();
    expect(launches.map(l => l.name)).toEqual(['Good']);
  });

  test('getLaunches preserves preLaunchTask / postDebugTask', () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [
        {
          name: 'Run With Deps',
          type: 'node',
          request: 'launch',
          preLaunchTask: 'build',
          postDebugTask: 'cleanup',
        },
      ],
    });
    const launch = svc.getLaunches()[0];
    expect(launch.preLaunchTask).toBe('build');
    expect(launch.postDebugTask).toBe('cleanup');
  });

  test('dependenciesOf flattens preLaunchTask + postDebugTask + compound members', () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [
        { name: 'Run API', type: 'node', request: 'launch' },
        { name: 'Attach', type: 'node', request: 'attach' },
      ],
      compounds: [
        { name: 'All', configurations: ['Run API', 'Attach'], preLaunchTask: 'build' },
      ],
    });
    const all = svc.getLaunches();
    const compound = all.find(l => l.name === 'All')!;
    const deps = svc.dependenciesOf(compound, all);
    expect(deps).toEqual([
      { kind: 'task', key: `${folderA.uri.fsPath}::task::build`, name: 'build' },
      { kind: 'launch', key: `${folderA.uri.fsPath}::Run API`, name: 'Run API' },
      { kind: 'launch', key: `${folderA.uri.fsPath}::Attach`, name: 'Attach' },
    ]);
  });

  test('dependenciesOf omits members that do not exist', () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      compounds: [{ name: 'All', configurations: ['Ghost'] }],
    });
    const all = svc.getLaunches();
    const deps = svc.dependenciesOf(all[0], all);
    expect(deps).toEqual([]);
  });

  test('getTasks maps TaskScope folders to folderKey/folderName', async () => {
    const t = new Task(
      { type: 'npm', script: 'start' },
      folderA,
      'start',
      'npm',
      {},
    );
    __setFetchableTasks([t]);
    const list = await svc.getTasks();
    expect(list).toHaveLength(1);
    expect(list[0].folderKey).toBe(folderA.uri.fsPath);
    expect(list[0].folderName).toBe('a');
    expect(list[0].name).toBe('start');
    expect(list[0].source).toBe('npm');
    expect(list[0].type).toBe('npm');
  });

  test('launch running state tracked via debug session events', () => {
    expect(svc.isLaunchRunning('X')).toBe(false);
    const events: number[] = [];
    svc.onRunningChanged(() => events.push(1));
    (debug as any).__startEmitter.fire({ configuration: { name: 'X' }, name: 'X' });
    expect(svc.isLaunchRunning('X')).toBe(true);
    expect(events.length).toBe(1);
  });

  test('launch running state clears only for matching session', () => {
    const session = { configuration: { name: 'X' }, name: 'X' };
    (debug as any).__startEmitter.fire(session);
    expect(svc.isLaunchRunning('X')).toBe(true);
    // Terminating an unrelated session shouldn't clear X.
    (debug as any).__termEmitter.fire({ configuration: { name: 'Y' }, name: 'Y' });
    expect(svc.isLaunchRunning('X')).toBe(true);
    // The real terminate does.
    (debug as any).__termEmitter.fire(session);
    expect(svc.isLaunchRunning('X')).toBe(false);
  });

  test('task running state tracked via task events', () => {
    const t = new Task({ type: 'shell' }, folderA, 'build', 'Workspace', {});
    const execution = { task: t, terminate: jest.fn() };
    expect(svc.isTaskRunning('Workspace', 'build')).toBe(false);
    (tasks as any).__startEmitter.fire({ execution });
    expect(svc.isTaskRunning('Workspace', 'build')).toBe(true);
    (tasks as any).__endEmitter.fire({ execution });
    expect(svc.isTaskRunning('Workspace', 'build')).toBe(false);
  });
});
