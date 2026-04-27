import { Uri, workspace } from 'vscode';
import { DependencyOrchestrator } from '../src/services/DependencyOrchestrator';
import type { RunConfig } from '../src/shared/types';

// Lightweight fakes for just enough surface to exercise the plan + resolve
// logic. The orchestrator's start/stop code paths need a real ExecutionService
// mock which is more invasive — we only test the pure pieces here.
function cfg(id: string, name: string, deps: Array<{ ref: string; delaySeconds?: number }> = []): RunConfig {
  return {
    id,
    name,
    type: 'custom-command',
    projectPath: '',
    workspaceFolder: 'ws',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: { command: 'echo', cwd: '', shell: 'default', interactive: false },
    dependsOn: deps,
  } as RunConfig;
}

function mkOrch(configs: RunConfig[]): DependencyOrchestrator {
  const byId = new Map(configs.map(c => [c.id, { folderKey: '/ws', config: c, valid: true as const }]));
  const svc = {
    getById: (id: string) => byId.get(id),
    list: () => Array.from(byId.values()),
  } as any;
  const noop = {} as any;
  const native = {
    getLaunches: () => [],
    getTasks: async () => [],
    isLaunchRunning: () => false,
    isTaskRunning: () => false,
    onRunningChanged: () => ({ dispose: () => {} }),
  } as any;
  return new DependencyOrchestrator(svc, noop, noop, noop, native);
}

describe('DependencyOrchestrator.plan', () => {
  beforeEach(() => {
    (workspace as any).workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
  });
  afterEach(() => {
    (workspace as any).workspaceFolders = [];
  });

  test('flat list: deps appear in the order the user arranged them', () => {
    const root = cfg('a', 'A', [
      { ref: 'rcm:b', delaySeconds: 5 },
      { ref: 'rcm:c' },
    ]);
    const b = cfg('b', 'B');
    const c = cfg('c', 'C');
    const orch = mkOrch([root, b, c]);
    const result = orch.plan(root);
    expect(result.cycle).toBeNull();
    expect(result.steps.map(s => s.ref)).toEqual(['rcm:b', 'rcm:c']);
    expect(result.steps[0].delaySeconds).toBe(5);
  });

  test('nested: a dep with its own deps gets its children walked first', () => {
    const root = cfg('a', 'A', [{ ref: 'rcm:b' }]);
    const b = cfg('b', 'B', [{ ref: 'rcm:c' }]);
    const c = cfg('c', 'C');
    const orch = mkOrch([root, b, c]);
    const result = orch.plan(root);
    expect(result.cycle).toBeNull();
    // Depth-first: c before b, so c starts first.
    expect(result.steps.map(s => s.ref)).toEqual(['rcm:c', 'rcm:b']);
  });

  test('cycle detection stops the walk and reports the offending ref', () => {
    const a = cfg('a', 'A', [{ ref: 'rcm:b' }]);
    const b = cfg('b', 'B', [{ ref: 'rcm:a' }]); // loops back
    const orch = mkOrch([a, b]);
    const result = orch.plan(a);
    expect(result.cycle).not.toBeNull();
    if (result.cycle) {
      expect(result.cycle.ref).toBe('rcm:a');
      expect(result.cycle.path[result.cycle.path.length - 1]).toBe('rcm:a');
    }
  });

  test('diamond: a dep shared by two branches is walked only once', () => {
    const a = cfg('a', 'A', [{ ref: 'rcm:b' }, { ref: 'rcm:c' }]);
    const b = cfg('b', 'B', [{ ref: 'rcm:d' }]);
    const c = cfg('c', 'C', [{ ref: 'rcm:d' }]);
    const d = cfg('d', 'D');
    const orch = mkOrch([a, b, c, d]);
    const result = orch.plan(a);
    expect(result.cycle).toBeNull();
    const refs = result.steps.map(s => s.ref);
    // d must appear before b (and before c). Exactly one d entry.
    expect(refs.filter(r => r === 'rcm:d').length).toBe(1);
    expect(refs.indexOf('rcm:d')).toBeLessThan(refs.indexOf('rcm:b'));
  });

  test('unresolved ref is left in the plan as an entry with no resolved binding', () => {
    const root = cfg('a', 'A', [{ ref: 'rcm:ghost' }]);
    const orch = mkOrch([root]);
    const result = orch.plan(root);
    expect(result.cycle).toBeNull();
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].resolved).toBeNull();
  });
});
