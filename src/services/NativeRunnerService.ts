import * as vscode from 'vscode';
import { log } from '../utils/logger';

// Describes one entry in .vscode/launch.json — either a plain debug config
// or a "compound" that bundles several. We carry the raw JSON verbatim so the
// virtual-document view can pretty-print it without us re-serialising.
export interface NativeLaunch {
  // Unique key across all folders: `${folderKey}::${name}` — the "name" field
  // in launch.json must itself be unique within one folder (VS Code's own rule).
  key: string;
  folderKey: string;
  folderName: string;
  name: string;
  // Either a regular config with a `type`, or a compound referencing names.
  kind: 'config' | 'compound';
  // For display in the tooltip / summary.
  launchType?: string;
  // Names of the launch configs this compound wraps (compound.configurations).
  compoundMembers?: string[];
  // preLaunchTask / postDebugTask point at task names in tasks.json.
  preLaunchTask?: string;
  postDebugTask?: string;
  // Raw JSON snippet for the view-source command.
  raw: any;
}

export interface NativeTask {
  key: string;              // `${folderKey}::${source}::${name}`
  folderKey: string;
  folderName: string;
  name: string;
  source: string;           // 'Workspace', 'npm', 'gradle', …
  type: string;             // 'shell', 'gradle', 'npm', …
  // Only present when VS Code could resolve the task to a concrete command.
  // We show the underlying Task object to executeTask; callers don't need it.
  handle: vscode.Task;
  // Raw JSON for workspace tasks (tasks.json). Other sources (gradle, npm) have
  // no JSON representation — we synthesise a descriptive stub.
  raw: any;
  // Names of tasks this one depends on — parsed from the `dependsOn` field of
  // the raw tasks.json entry. Empty for auto-detected tasks (they don't have
  // dependsOn). Surfacing this lets the tree render the dependency chain.
  dependsOn: string[];
}

export type DependencyRef =
  | { kind: 'task'; key: string; name: string }
  | { kind: 'launch'; key: string; name: string };

// NativeRunnerService bridges the extension's tree with VS Code's native run
// mechanisms. It does NOT rewrite any .vscode file. Responsibilities:
//
//   1. Enumerate launch configs (+ compounds) via
//      `workspace.getConfiguration('launch', folder)`. Re-enumerated on every
//      getLaunches() call — compile is cheap and users edit launch.json
//      directly; we don't want cache staleness to surprise them.
//   2. Enumerate tasks via `vscode.tasks.fetchTasks()`. This also returns
//      auto-detected tasks (npm, gradle, maven, …), not just tasks.json.
//   3. Start a launch by name (`debug.startDebugging`). Start a task by
//      `vscode.tasks.executeTask(handle)`. Both return a handle we track.
//   4. Observe running state via `debug.onDidStartDebugSession` /
//      `onDidTerminateDebugSession` and `tasks.onDidStartTask` /
//      `tasks.onDidEndTask`. This also picks up sessions the user started
//      from the native Run & Debug panel — those fire the same events.
//   5. Provide `stop()` for both kinds.
export class NativeRunnerService {
  // Running debug sessions keyed by launch name (as shown in launch.json).
  // Value is the DebugSession we can pass to stopDebugging.
  private runningLaunches = new Map<string, vscode.DebugSession>();
  // Running task executions keyed by `${source}::${name}`. Source + name
  // disambiguates the many auto-detected tasks that share a short name.
  private runningTasks = new Map<string, vscode.TaskExecution>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onRunningChanged = this.emitter.event;
  private subs: vscode.Disposable[] = [];

  constructor() {
    this.subs.push(
      vscode.debug.onDidStartDebugSession(s => {
        this.runningLaunches.set(s.configuration.name ?? s.name, s);
        this.emitter.fire();
      }),
      vscode.debug.onDidTerminateDebugSession(s => {
        const name = s.configuration.name ?? s.name;
        if (this.runningLaunches.get(name) === s) {
          this.runningLaunches.delete(name);
          this.emitter.fire();
        }
      }),
      vscode.tasks.onDidStartTask(e => {
        const key = taskKey(e.execution.task);
        this.runningTasks.set(key, e.execution);
        this.emitter.fire();
      }),
      vscode.tasks.onDidEndTask(e => {
        const key = taskKey(e.execution.task);
        if (this.runningTasks.get(key) === e.execution) {
          this.runningTasks.delete(key);
          this.emitter.fire();
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.subs) d.dispose();
    this.subs = [];
    this.emitter.dispose();
  }

  // --- enumeration --------------------------------------------------------

  getLaunches(): NativeLaunch[] {
    const out: NativeLaunch[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const cfg = vscode.workspace.getConfiguration('launch', folder.uri);
      const configurations = (cfg.get('configurations') as any[] | undefined) ?? [];
      const compounds = (cfg.get('compounds') as any[] | undefined) ?? [];
      for (const c of configurations) {
        if (!c || typeof c !== 'object' || typeof c.name !== 'string') continue;
        out.push({
          key: `${folder.uri.fsPath}::${c.name}`,
          folderKey: folder.uri.fsPath,
          folderName: folder.name,
          name: c.name,
          kind: 'config',
          launchType: typeof c.type === 'string' ? c.type : undefined,
          preLaunchTask: typeof c.preLaunchTask === 'string' ? c.preLaunchTask : undefined,
          postDebugTask: typeof c.postDebugTask === 'string' ? c.postDebugTask : undefined,
          raw: c,
        });
      }
      for (const c of compounds) {
        if (!c || typeof c !== 'object' || typeof c.name !== 'string') continue;
        out.push({
          key: `${folder.uri.fsPath}::${c.name}`,
          folderKey: folder.uri.fsPath,
          folderName: folder.name,
          name: c.name,
          kind: 'compound',
          compoundMembers: Array.isArray(c.configurations) ? c.configurations.filter((x: any) => typeof x === 'string') : [],
          preLaunchTask: typeof c.preLaunchTask === 'string' ? c.preLaunchTask : undefined,
          raw: c,
        });
      }
    }
    return out;
  }

  async getTasks(): Promise<NativeTask[]> {
    let tasks: vscode.Task[] = [];
    try {
      tasks = await vscode.tasks.fetchTasks();
    } catch (e) {
      log.warn(`fetchTasks failed: ${(e as Error).message}`);
      return [];
    }
    const out: NativeTask[] = [];
    const workspaceTasksByFolder = await this.readWorkspaceTasksJson();
    for (const t of tasks) {
      const folder = workspaceFolderOf(t);
      const folderKey = folder?.uri.fsPath ?? '__global__';
      const folderName = folder?.name ?? '(global)';
      const raw = t.source === 'Workspace'
        ? (workspaceTasksByFolder.get(folderKey)?.find(j => j?.label === t.name) ?? { label: t.name })
        : { label: t.name, source: t.source, type: t.definition?.type };
      const dependsOn = extractDependsOn(raw);
      out.push({
        key: `${folderKey}::${t.source}::${t.name}`,
        folderKey,
        folderName,
        name: t.name,
        source: t.source,
        type: t.definition?.type ?? 'unknown',
        handle: t,
        raw,
        dependsOn,
      });
    }
    return out;
  }

  // --- state ---------------------------------------------------------------

  isLaunchRunning(name: string): boolean {
    return this.runningLaunches.has(name);
  }

  isTaskRunning(source: string, name: string): boolean {
    return this.runningTasks.has(`${source}::${name}`);
  }

  // --- actions -------------------------------------------------------------

  async runLaunch(launch: NativeLaunch): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === launch.folderKey);
    if (!folder) {
      vscode.window.showErrorMessage(`Workspace folder not found for launch "${launch.name}"`);
      return;
    }
    log.info(`Launch (native): "${launch.name}" in ${folder.name}`);
    // Second arg accepts the name verbatim; VS Code resolves it from the
    // folder's launch.json. Bypasses our own detection path entirely.
    try {
      const ok = await vscode.debug.startDebugging(folder, launch.name);
      if (!ok) {
        vscode.window.showWarningMessage(`Failed to start launch "${launch.name}" — see Debug Console.`);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Launch "${launch.name}" failed: ${(e as Error).message}`);
    }
  }

  async stopLaunch(name: string): Promise<void> {
    const s = this.runningLaunches.get(name);
    if (!s) return;
    log.info(`Stop launch (native): "${name}"`);
    await vscode.debug.stopDebugging(s);
  }

  async runTask(task: NativeTask): Promise<void> {
    log.info(`Run task (native): "${task.name}" (${task.source})`);
    try {
      await vscode.tasks.executeTask(task.handle);
    } catch (e) {
      vscode.window.showErrorMessage(`Task "${task.name}" failed: ${(e as Error).message}`);
    }
  }

  async stopTask(source: string, name: string): Promise<void> {
    const exec = this.runningTasks.get(`${source}::${name}`);
    if (!exec) return;
    log.info(`Stop task (native): "${name}" (${source})`);
    exec.terminate();
  }

  // --- dependency resolution ----------------------------------------------

  // Flattens the deps of a launch config: preLaunchTask + postDebugTask +
  // compound.configurations (each a launch config name). Deduplicated.
  dependenciesOf(launch: NativeLaunch, allLaunches: NativeLaunch[]): DependencyRef[] {
    const out: DependencyRef[] = [];
    const seen = new Set<string>();
    const push = (ref: DependencyRef) => { if (!seen.has(ref.key)) { seen.add(ref.key); out.push(ref); } };

    if (launch.preLaunchTask) {
      push({ kind: 'task', key: `${launch.folderKey}::task::${launch.preLaunchTask}`, name: launch.preLaunchTask });
    }
    if (launch.postDebugTask) {
      push({ kind: 'task', key: `${launch.folderKey}::task::${launch.postDebugTask}`, name: launch.postDebugTask });
    }
    for (const member of launch.compoundMembers ?? []) {
      const target = allLaunches.find(l => l.folderKey === launch.folderKey && l.name === member);
      if (target) push({ kind: 'launch', key: target.key, name: target.name });
    }
    return out;
  }

  // --- helpers -------------------------------------------------------------

  // Loads the raw JSON task definitions from each folder's .vscode/tasks.json
  // so the virtual document can show them verbatim. Auto-detected tasks
  // (npm/gradle/…) have no JSON and are skipped.
  private async readWorkspaceTasksJson(): Promise<Map<string, any[]>> {
    const out = new Map<string, any[]>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(stripJsonComments(new TextDecoder().decode(buf)));
        if (Array.isArray(parsed?.tasks)) out.set(folder.uri.fsPath, parsed.tasks);
      } catch {
        /* no tasks.json — fine */
      }
    }
    return out;
  }
}

// `dependsOn` in tasks.json accepts either a string (single task name), an
// array of strings, or an array of { type, task } objects (cross-workspace /
// typed references). We flatten to plain names for display — the user can
// see the full structure in the read-only view.
function extractDependsOn(raw: any): string[] {
  const dep = raw?.dependsOn;
  if (!dep) return [];
  if (typeof dep === 'string') return [dep];
  if (Array.isArray(dep)) {
    return dep
      .map(d => (typeof d === 'string' ? d : typeof d?.task === 'string' ? d.task : null))
      .filter((x): x is string => x !== null);
  }
  return [];
}

function workspaceFolderOf(t: vscode.Task): vscode.WorkspaceFolder | undefined {
  // TaskScope is either a WorkspaceFolder or a TaskScope enum; the folder case
  // has .uri, the enum case doesn't.
  const s = t.scope as any;
  if (s && typeof s === 'object' && s.uri) return s as vscode.WorkspaceFolder;
  return undefined;
}

function taskKey(t: vscode.Task): string {
  return `${t.source}::${t.name}`;
}

// Minimal comment stripper so we can parse VS Code's JSONC files. Handles the
// common cases (// and /* */) without claiming to be a real JSONC parser —
// launch.json / tasks.json in practice only use these two forms.
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (escape) { escape = false; }
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Also strip trailing commas — jsonc-parser handles them but JSON.parse doesn't.
  return out.replace(/,(\s*[}\]])/g, '$1');
}
