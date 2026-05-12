import type * as vscode from 'vscode';

// Per-workspace persistence of which tree nodes the user expanded or
// collapsed. Keyed by the stable TreeItem id (`folder:<key>`,
// `typeGroup:<folderKey>:<type>`, `group:<folderKey>:<path>`). Nodes
// never touched by the user don't have an entry — those keep the
// default-expanded behavior the tree provider sets, so first-time
// renders look identical to before.
//
// VS Code DOES persist collapsibleState per `TreeItem.id` automatically,
// but its persistence loses to whatever the provider hands back on the
// next render — meaning if `getTreeItem` always sets `Expanded`, the
// stored state never wins. This store's job is to override the
// default with the user's last choice when one exists.
export type CollapseState = 'expanded' | 'collapsed';

const KEY = 'rcm.treeCollapseState.v1';

export class CollapseStateStore {
  private state: Record<string, CollapseState>;

  constructor(private readonly workspaceState: vscode.Memento) {
    this.state = workspaceState.get<Record<string, CollapseState>>(KEY) ?? {};
  }

  get(id: string): CollapseState | undefined {
    return this.state[id];
  }

  set(id: string, value: CollapseState): void {
    if (this.state[id] === value) return;
    this.state[id] = value;
    void this.workspaceState.update(KEY, this.state);
  }

  // Drop entries the tree no longer renders. Called on tree refresh so
  // the persisted map doesn't grow unboundedly across config rename
  // / delete cycles.
  prune(liveIds: Iterable<string>): void {
    const live = new Set(liveIds);
    let changed = false;
    for (const id of Object.keys(this.state)) {
      if (!live.has(id)) {
        delete this.state[id];
        changed = true;
      }
    }
    if (changed) void this.workspaceState.update(KEY, this.state);
  }
}
