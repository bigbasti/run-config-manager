import { GroupService } from '../src/services/GroupService';
import type { RunConfig } from '../src/shared/types';

// Minimal fake — just the three methods GroupService uses.
class FakeSvc {
  private refs: Array<{ folderKey: string; config: RunConfig; valid: true }> = [];
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
});
