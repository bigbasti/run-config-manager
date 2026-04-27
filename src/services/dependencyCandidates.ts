import type { RunConfig } from '../shared/types';
import type { NativeLaunch, NativeTask } from './NativeRunnerService';

// Stable-ref parsing/formatting — shared between the orchestrator and the
// form-options builder so both speak the same language.
export function rcmRef(id: string): string   { return `rcm:${id}`; }
export function launchRef(name: string): string { return `launch:${name}`; }
export function taskRef(source: string, name: string): string { return `task:${source}::${name}`; }

export interface ParsedRef {
  kind: 'rcm' | 'launch' | 'task';
  // The id (rcm), name (launch), or combined `source::name` for tasks.
  key: string;
  // Tasks only: the source (Workspace/npm/gradle/…).
  source?: string;
  // Tasks only: the task name (no source prefix).
  taskName?: string;
}

export function parseDependencyRef(ref: string): ParsedRef | null {
  if (ref.startsWith('rcm:')) return { kind: 'rcm', key: ref.slice(4) };
  if (ref.startsWith('launch:')) return { kind: 'launch', key: ref.slice(7) };
  if (ref.startsWith('task:')) {
    const rest = ref.slice(5);
    const sep = rest.indexOf('::');
    if (sep === -1) return null;
    const source = rest.slice(0, sep);
    const taskName = rest.slice(sep + 2);
    return { kind: 'task', key: rest, source, taskName };
  }
  return null;
}

// Builds the dropdown options the "Depends on" field consumes. Same data is
// used by the tree (to resolve a dep back into a display label) and the
// orchestrator (to check existence).
export interface BuildOptionsArgs {
  // All valid configs across the workspace — we only include those in the
  // same folder as the one being edited so deps stay local.
  folderConfigs: RunConfig[];
  // The config currently being edited — we skip it so users can't depend
  // on themselves. New configs (no id yet) pass undefined.
  excludeId?: string;
  launches: NativeLaunch[];
  tasks: NativeTask[];
  // Only include launches/tasks from this folder. Multi-root workspaces are
  // uncommon but we don't want to cross-link.
  folderKey: string;
}

export function buildDependencyOptions(args: BuildOptionsArgs): Array<{
  value: string; label: string; group: string; description?: string;
}> {
  const out: Array<{ value: string; label: string; group: string; description?: string }> = [];

  for (const cfg of args.folderConfigs) {
    if (args.excludeId && cfg.id === args.excludeId) continue;
    out.push({
      value: rcmRef(cfg.id),
      label: cfg.name,
      group: 'Run configurations',
      description: cfg.type,
    });
  }

  for (const l of args.launches) {
    if (l.folderKey !== args.folderKey) continue;
    out.push({
      value: launchRef(l.name),
      label: l.name,
      group: 'Launch configurations',
      description: l.kind === 'compound' ? 'compound' : (l.launchType ?? 'launch'),
    });
  }

  for (const t of args.tasks) {
    if (t.folderKey !== args.folderKey) continue;
    // Only surface Workspace-defined tasks — auto-detected ones (npm/gradle)
    // would explode the candidate list with little user value. Advanced
    // users can still type a literal `task:npm::start` ref into the config
    // JSON if they really need it.
    if (t.source !== 'Workspace') continue;
    out.push({
      value: taskRef(t.source, t.name),
      label: t.name,
      group: 'Tasks',
      description: t.source,
    });
  }

  return out;
}
