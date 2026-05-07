import { Uri } from 'vscode';
import { GroupService } from '../src/services/GroupService';
import type { RunConfig } from '../src/shared/types';

// Minimal fake — just the surface GroupService uses.
class FakeSvc {
  private refs: Array<{ folderKey: string; config: RunConfig; valid: true }> = [];
  // Per-folder known-folder list (mirrors RunFile.groups).
  private folders = new Map<string, string[]>();
  seed(folderKey: string, configs: RunConfig[]) {
    for (const c of configs) this.refs.push({ folderKey, config: c, valid: true });
  }
  list() { return this.refs; }
  async update(folderKey: string, cfg: RunConfig): Promise<void> {
    const idx = this.refs.findIndex(r => r.folderKey === folderKey && r.config.id === cfg.id);
    if (idx === -1) throw new Error(`not found: ${cfg.id}`);
    this.refs[idx] = { folderKey, config: cfg, valid: true };
  }
  getAll() { return this.refs.map(r => r.config); }
  knownFolders(folderKey: string): string[] {
    return [...(this.folders.get(folderKey) ?? [])];
  }
  async setKnownFolders(folderKey: string, paths: string[]): Promise<void> {
    this.folders.set(folderKey, [...new Set(paths)].sort());
  }
}

function cfg(id: string, name: string, group?: string): RunConfig {
  return {
    id, name, type: 'custom-command',
    projectPath: '', workspaceFolder: 'ws',
    env: {}, programArgs: '', vmArgs: '',
    typeOptions: { command: 'echo', cwd: '', shell: 'default', interactive: false },
    ...(group ? { group } : {}),
  } as RunConfig;
}

describe('GroupService', () => {
  let fake: FakeSvc;
  let groups: GroupService;
  beforeEach(() => {
    fake = new FakeSvc();
    groups = new GroupService(fake as any);
  });

  test('list() returns sorted unique group names', () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Frontend'),
      cfg('c', 'C', 'Backend'),
      cfg('d', 'D'),
    ]);
    expect(groups.list('/ws')).toEqual(['Backend', 'Frontend']);
  });

  test('list() ignores ungrouped configs', () => {
    fake.seed('/ws', [cfg('a', 'A'), cfg('b', 'B')]);
    expect(groups.list('/ws')).toEqual([]);
  });

  test('members() returns configs in that group', () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Frontend'),
      cfg('c', 'C', 'Backend'),
    ]);
    const members = groups.members('/ws', 'Backend');
    expect(members.map(c => c.id)).toEqual(['a', 'c']);
  });

  test('addToGroup() sets the group field', async () => {
    fake.seed('/ws', [cfg('a', 'A')]);
    await groups.addToGroup('/ws', 'a', 'Backend');
    expect(fake.getAll()[0].group).toBe('Backend');
  });

  test('addToGroup() trims whitespace', async () => {
    fake.seed('/ws', [cfg('a', 'A')]);
    await groups.addToGroup('/ws', 'a', '  Backend  ');
    expect(fake.getAll()[0].group).toBe('Backend');
  });

  test('addToGroup() rejects empty names', async () => {
    fake.seed('/ws', [cfg('a', 'A')]);
    await expect(groups.addToGroup('/ws', 'a', '   ')).rejects.toThrow(/empty/i);
  });

  test('removeFromGroup() clears the group field', async () => {
    fake.seed('/ws', [cfg('a', 'A', 'Backend')]);
    await groups.removeFromGroup('/ws', 'a');
    expect(fake.getAll()[0].group).toBeUndefined();
  });

  test('renameGroup() updates every member', async () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Old'),
      cfg('b', 'B', 'Old'),
      cfg('c', 'C', 'Other'),
    ]);
    await groups.renameGroup('/ws', 'Old', 'New');
    const all = fake.getAll();
    expect(all.find(c => c.id === 'a')?.group).toBe('New');
    expect(all.find(c => c.id === 'b')?.group).toBe('New');
    expect(all.find(c => c.id === 'c')?.group).toBe('Other');
  });

  test('deleteGroup() clears field on every member, configs survive', async () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Backend'),
      cfg('c', 'C', 'Other'),
    ]);
    await groups.deleteGroup('/ws', 'Backend');
    const all = fake.getAll();
    // All 3 configs still exist — only the grouping was removed.
    expect(all.length).toBe(3);
    expect(all.find(c => c.id === 'a')?.group).toBeUndefined();
    expect(all.find(c => c.id === 'b')?.group).toBeUndefined();
    expect(all.find(c => c.id === 'c')?.group).toBe('Other');
    // And 'Backend' is no longer a known group.
    expect(groups.list('/ws')).toEqual(['Other']);
  });

  test('statusOfConfig() is undefined by default', () => {
    fake.seed('/ws', [cfg('a', 'A', 'G')]);
    expect(groups.statusOfConfig('a')).toBeUndefined();
  });

  test('runGroup sequential: member with dependsOn routes through orchestrator (not direct exec.run)', async () => {
    // Regression test: running a group used to bypass DependencyOrchestrator,
    // so members' `dependsOn` chains were silently ignored — the member
    // would try to start without its deps and either stall or fail.
    const withDep = {
      ...cfg('a', 'A', 'G'),
      dependsOn: [{ ref: 'rcm:dep1' }],
    } as RunConfig;
    const plain = cfg('b', 'B', 'G');
    fake.seed('/ws', [withDep, plain]);

    const execRunCalls: string[] = [];
    const orchRunCalls: string[] = [];
    const exec = {
      isRunning: () => false,
      isStarted: () => true, // short-circuits waitUntilRunning
      run: (c: RunConfig) => { execRunCalls.push(c.id); return Promise.resolve(); },
    } as any;
    const dbg = { isRunning: () => false } as any;
    const docker = { isRunning: () => false } as any;
    const orchestrator = {
      run: (c: RunConfig) => { orchRunCalls.push(c.id); return Promise.resolve(); },
    } as any;
    const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;

    await groups.runGroup('/ws', 'G', 'sequential', folder, { exec, dbg, docker, orchestrator });

    // Member 'a' has dependsOn → orchestrator.run called; exec.run NOT called for it.
    expect(orchRunCalls).toContain('a');
    expect(execRunCalls).not.toContain('a');
    // Member 'b' has no deps → falls through to exec.run directly.
    expect(execRunCalls).toContain('b');
    expect(orchRunCalls).not.toContain('b');
  });

  test('addFolder records the path and every ancestor', async () => {
    await groups.addFolder('/ws', 'Backend/API/Internal');
    expect(fake.knownFolders('/ws').sort()).toEqual([
      'Backend', 'Backend/API', 'Backend/API/Internal',
    ]);
  });

  test('addToGroup ensures parent folders exist', async () => {
    fake.seed('/ws', [cfg('a', 'A')]);
    await groups.addToGroup('/ws', 'a', 'Backend/API');
    expect(fake.knownFolders('/ws').sort()).toEqual(['Backend', 'Backend/API']);
    expect(fake.getAll()[0].group).toBe('Backend/API');
  });

  test('childFolders returns direct subfolders only', async () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Backend/API'),
      cfg('c', 'C', 'Backend/API/Internal'),
      cfg('d', 'D', 'Frontend'),
    ]);
    expect(groups.childFolders('/ws', '').sort()).toEqual(['Backend', 'Frontend']);
    expect(groups.childFolders('/ws', 'Backend').sort()).toEqual(['Backend/API']);
    expect(groups.childFolders('/ws', 'Backend/API').sort()).toEqual(['Backend/API/Internal']);
    expect(groups.childFolders('/ws', 'Backend/API/Internal')).toEqual([]);
  });

  test('members(recursive) walks the entire subtree', () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Backend/API'),
      cfg('c', 'C', 'Backend/API/Internal'),
      cfg('d', 'D', 'Frontend'),
    ]);
    const flat = groups.members('/ws', 'Backend');
    expect(flat.map(c => c.id)).toEqual(['a']);
    const recursive = groups.members('/ws', 'Backend', { recursive: true });
    expect(recursive.map(c => c.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('moveConfig reassigns the group field', async () => {
    fake.seed('/ws', [cfg('a', 'A', 'Backend')]);
    await groups.moveConfig('/ws', 'a', 'Backend/API');
    expect(fake.getAll()[0].group).toBe('Backend/API');
  });

  test('moveConfig with empty path clears the group (back to top-level)', async () => {
    fake.seed('/ws', [cfg('a', 'A', 'Backend')]);
    await groups.moveConfig('/ws', 'a', '');
    expect(fake.getAll()[0].group).toBeUndefined();
  });

  test('deleteFolder cascades: subfolders removed, configs ungrouped', async () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Backend/API'),
      cfg('c', 'C', 'Backend/API/Internal'),
      cfg('d', 'D', 'Frontend'),
    ]);
    await groups.addFolder('/ws', 'Backend/API/Internal');
    await groups.deleteFolder('/ws', 'Backend');
    const all = fake.getAll();
    // Configs in the Backend subtree are ungrouped — Frontend untouched.
    expect(all.find(c => c.id === 'a')?.group).toBeUndefined();
    expect(all.find(c => c.id === 'b')?.group).toBeUndefined();
    expect(all.find(c => c.id === 'c')?.group).toBeUndefined();
    expect(all.find(c => c.id === 'd')?.group).toBe('Frontend');
    // Backend + descendants removed from the known list.
    expect(fake.knownFolders('/ws')).toEqual([]);
  });

  test('renameGroup rewrites every descendant path', async () => {
    fake.seed('/ws', [
      cfg('a', 'A', 'Backend'),
      cfg('b', 'B', 'Backend/API'),
      cfg('c', 'C', 'Backend/API/Internal'),
    ]);
    await groups.addFolder('/ws', 'Backend/API/Internal');
    await groups.renameGroup('/ws', 'Backend', 'Server');
    const all = fake.getAll();
    expect(all.find(c => c.id === 'a')?.group).toBe('Server');
    expect(all.find(c => c.id === 'b')?.group).toBe('Server/API');
    expect(all.find(c => c.id === 'c')?.group).toBe('Server/API/Internal');
    expect(fake.knownFolders('/ws').sort()).toEqual([
      'Server', 'Server/API', 'Server/API/Internal',
    ]);
  });

  test('addToGroup rejects invalid folder paths', async () => {
    fake.seed('/ws', [cfg('a', 'A')]);
    await expect(groups.addToGroup('/ws', 'a', '/leading')).rejects.toThrow(/separator/i);
    await expect(groups.addToGroup('/ws', 'a', 'trailing/')).rejects.toThrow(/separator/i);
    await expect(groups.addToGroup('/ws', 'a', 'A//B')).rejects.toThrow(/separator/i);
  });

  test('runGroup parallel: member with dependsOn also routes through orchestrator', async () => {
    const withDep = {
      ...cfg('a', 'A', 'G'),
      dependsOn: [{ ref: 'rcm:dep1' }],
    } as RunConfig;
    fake.seed('/ws', [withDep]);

    const orchRunCalls: string[] = [];
    const exec = { isRunning: () => false, run: jest.fn() } as any;
    const dbg = { isRunning: () => false } as any;
    const docker = { isRunning: () => false } as any;
    const orchestrator = {
      run: (c: RunConfig) => { orchRunCalls.push(c.id); return Promise.resolve(); },
    } as any;
    const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;

    await groups.runGroup('/ws', 'G', 'parallel', folder, { exec, dbg, docker, orchestrator });

    expect(orchRunCalls).toEqual(['a']);
    expect(exec.run).not.toHaveBeenCalled();
  });
});
