import * as vscode from 'vscode';
import type { NativeRunnerService, NativeLaunch, NativeTask } from '../services/NativeRunnerService';
import { log } from '../utils/logger';

// The "Launch & Tasks" section is a SEPARATE VS Code view, sibling to the
// main "Configurations" view. Putting it under the same root tree was wrong —
// VS Code's own Run & Debug layout stacks Variables / Breakpoints / Watch /
// Call Stack as independent views, each with its own collapsible title bar.
// We follow that convention so users get the same behavior they know.

export type NativeNode =
  | { kind: 'launch'; launch: NativeLaunch }
  | { kind: 'task'; task: NativeTask }
  // Collapsed-by-default container for workspace tasks. Launches stay at the
  // top level (matches Run & Debug's mental model of "launches are the primary
  // entry points, tasks are their infrastructure"), tasks tuck into a group
  // so a tasks.json with 40 entries doesn't bury the launches.
  | { kind: 'tasksGroup'; count: number }
  // Dep children — rendered under a parent launch / task. Expanded recursively
  // so a task-depends-on-task-depends-on-task chain renders as three levels.
  // `depth` is capped so a malformed cyclic dependsOn doesn't recurse forever.
  | { kind: 'depTask'; parent: NativeNode; task: NativeTask; depth: number }
  | { kind: 'depLaunch'; parent: NativeNode; launch: NativeLaunch; depth: number }
  // A reference to a task by name that we couldn't resolve (e.g. the task
  // was renamed). Rendered as a greyed-out node for discoverability.
  | { kind: 'depMissing'; parent: NativeNode; name: string; taskKind: 'task' | 'launch'; depth: number };

// Tasks deeper than this nesting get truncated with a stub child to keep the
// tree bounded when someone declares a cycle in tasks.json.
const MAX_DEP_DEPTH = 8;

export class NativeRunnerTreeProvider implements vscode.TreeDataProvider<NativeNode> {
  private emitter = new vscode.EventEmitter<NativeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tasksCache: NativeTask[] | undefined;
  private tasksFetching = false;

  constructor(private readonly native: NativeRunnerService) {
    native.onRunningChanged(() => this.refresh());
  }

  refresh(): void {
    // Invalidating the tasks cache on every refresh would cause fetchTasks to
    // run after every debug session state change — expensive. We only reset
    // it when the user explicitly hits the refresh button (extension.ts
    // re-creates the provider indirectly via the onChange wiring).
    this.emitter.fire(undefined);
  }

  // Called by extension.ts when the Refresh button fires so a hand-edited
  // launch.json / tasks.json gets picked up without reopening the window.
  invalidate(): void {
    this.tasksCache = undefined;
    this.refresh();
  }

  getTreeItem(n: NativeNode): vscode.TreeItem {
    if (n.kind === 'tasksGroup') {
      const item = new vscode.TreeItem('Tasks', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `(${n.count})`;
      item.iconPath = new vscode.ThemeIcon('tools');
      item.contextValue = 'nativeTasksGroup';
      item.tooltip = 'Workspace tasks from .vscode/tasks.json. Auto-detected tasks (npm/gradle/…) show up only where referenced.';
      return item;
    }
    if (n.kind === 'launch' || n.kind === 'depLaunch') {
      return this.renderLaunch(n.kind === 'depLaunch' ? n.launch : n.launch, n.kind === 'depLaunch');
    }
    if (n.kind === 'task' || n.kind === 'depTask') {
      return this.renderTask(n.kind === 'depTask' ? n.task : n.task, n.kind === 'depTask');
    }
    // depMissing
    const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.None);
    item.description = n.taskKind === 'task' ? 'task (not found)' : 'launch (not found)';
    item.tooltip = `The ${n.taskKind} "${n.name}" is referenced but no matching entry was found. It may have been renamed or removed.`;
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    return item;
  }

  getChildren(parent?: NativeNode): NativeNode[] {
    if (!parent) return this.rootChildren();
    if (parent.kind === 'launch' || parent.kind === 'depLaunch') {
      return this.launchChildren(parent);
    }
    if (parent.kind === 'task' || parent.kind === 'depTask') {
      return this.taskChildren(parent);
    }
    return [];
  }

  // --- rendering helpers --------------------------------------------------

  private renderLaunch(launch: NativeLaunch, isDep: boolean): vscode.TreeItem {
    const running = this.native.isLaunchRunning(launch.name);
    const hasDeps = Boolean(
      launch.preLaunchTask ||
      launch.postDebugTask ||
      (launch.compoundMembers?.length ?? 0) > 0,
    );
    const state = hasDeps && !isDep
      ? vscode.TreeItemCollapsibleState.Collapsed
      : hasDeps && isDep
      ? vscode.TreeItemCollapsibleState.Collapsed // dep launches can themselves have deps
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(launch.name, state);
    if (running) {
      item.iconPath = new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('charts.green'));
      item.description = `${launch.kind === 'compound' ? 'compound' : launch.launchType ?? 'launch'} · running`;
    } else {
      item.iconPath = new vscode.ThemeIcon(launch.kind === 'compound' ? 'run-all' : 'debug-alt');
      item.description = isDep
        ? (launch.kind === 'compound' ? 'compound · member' : `${launch.launchType ?? 'launch'} · member`)
        : (launch.kind === 'compound' ? 'compound' : launch.launchType ?? 'launch');
    }
    item.tooltip = new vscode.MarkdownString(
      `**${launch.name}** _(${launch.kind})_\n\n` +
      `Folder: ${launch.folderName}\n\n` +
      (launch.launchType ? `Type: \`${launch.launchType}\`\n\n` : '') +
      (launch.preLaunchTask ? `preLaunchTask: \`${launch.preLaunchTask}\`\n\n` : '') +
      (launch.postDebugTask ? `postDebugTask: \`${launch.postDebugTask}\`\n\n` : '') +
      ((launch.compoundMembers?.length ?? 0) > 0 ? `Members: ${launch.compoundMembers!.map(m => `\`${m}\``).join(', ')}\n\n` : '') +
      'Click to view the JSON (read-only). Inline buttons: Run / Stop / Edit.',
    );
    item.contextValue = running ? 'nativeLaunchRunning' : 'nativeLaunchIdle';
    item.command = {
      command: 'runConfig.viewNativeLaunch',
      title: 'View',
      arguments: [{ kind: 'nativeLaunch', launch }],
    };
    return item;
  }

  private renderTask(task: NativeTask, isDep: boolean): vscode.TreeItem {
    const running = this.native.isTaskRunning(task.source, task.name);
    const hasDeps = task.dependsOn.length > 0;
    const state = hasDeps
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(task.name, state);
    if (running) {
      item.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
      item.description = `${task.source} · running`;
    } else {
      item.iconPath = new vscode.ThemeIcon('tools');
      item.description = isDep ? `${task.source} · dependency` : task.source;
    }
    item.tooltip = new vscode.MarkdownString(
      `**${task.name}** _(task)_\n\n` +
      `Folder: ${task.folderName}\n\n` +
      `Source: \`${task.source}\`\n\n` +
      `Type: \`${task.type}\`` +
      (hasDeps ? `\n\ndependsOn: ${task.dependsOn.map(d => `\`${d}\``).join(', ')}` : ''),
    );
    item.contextValue = running ? 'nativeTaskRunning' : 'nativeTaskIdle';
    item.command = {
      command: 'runConfig.viewNativeTask',
      title: 'View',
      arguments: [{ kind: 'nativeTask', task }],
    };
    return item;
  }

  // --- children expansion -------------------------------------------------

  private rootChildren(): NativeNode[] {
    const launches = this.native.getLaunches();
    if (this.tasksCache === undefined && !this.tasksFetching) {
      this.tasksFetching = true;
      this.native.getTasks()
        .then(tasks => { this.tasksCache = tasks; })
        .catch(e => { log.warn(`fetchTasks failed: ${(e as Error).message}`); this.tasksCache = []; })
        .finally(() => { this.tasksFetching = false; this.refresh(); });
    }
    const tasks = this.tasksCache ?? [];
    const out: NativeNode[] = [];
    for (const l of launches) out.push({ kind: 'launch', launch: l });
    // Only surface workspace-defined tasks at the top level — listing every
    // auto-detected npm/gradle/maven task would overwhelm the sidebar. The
    // dependencies expand on-demand when a launch or a visible task refers
    // to them, so auto-detected tasks can still show up via that path.
    for (const t of tasks) {
      if (t.source === 'Workspace') out.push({ kind: 'task', task: t });
    }
    return out;
  }

  private launchChildren(parent: Extract<NativeNode, { kind: 'launch' | 'depLaunch' }>): NativeNode[] {
    const launch = parent.launch;
    const depth = parent.kind === 'depLaunch' ? parent.depth + 1 : 1;
    if (depth > MAX_DEP_DEPTH) return [];
    const allLaunches = this.native.getLaunches();
    const allTasks = this.tasksCache ?? [];
    const out: NativeNode[] = [];

    const pushTaskRef = (name: string) => {
      const task = allTasks.find(t => t.folderKey === launch.folderKey && t.name === name);
      if (task) out.push({ kind: 'depTask', parent, task, depth });
      else out.push({ kind: 'depMissing', parent, name, taskKind: 'task', depth });
    };
    const pushLaunchRef = (name: string) => {
      const target = allLaunches.find(l => l.folderKey === launch.folderKey && l.name === name);
      if (target) out.push({ kind: 'depLaunch', parent, launch: target, depth });
      else out.push({ kind: 'depMissing', parent, name, taskKind: 'launch', depth });
    };

    if (launch.preLaunchTask) pushTaskRef(launch.preLaunchTask);
    if (launch.postDebugTask) pushTaskRef(launch.postDebugTask);
    for (const m of launch.compoundMembers ?? []) pushLaunchRef(m);
    return out;
  }

  private taskChildren(parent: Extract<NativeNode, { kind: 'task' | 'depTask' }>): NativeNode[] {
    const task = parent.task;
    const depth = parent.kind === 'depTask' ? parent.depth + 1 : 1;
    if (depth > MAX_DEP_DEPTH) return [];
    const allTasks = this.tasksCache ?? [];
    const out: NativeNode[] = [];
    for (const name of task.dependsOn) {
      const found = allTasks.find(t => t.folderKey === task.folderKey && t.name === name);
      if (found) out.push({ kind: 'depTask', parent, task: found, depth });
      else out.push({ kind: 'depMissing', parent, name, taskKind: 'task', depth });
    }
    return out;
  }
}
