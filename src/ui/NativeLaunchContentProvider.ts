import * as vscode from 'vscode';
import type { NativeRunnerService, NativeLaunch, NativeTask } from '../services/NativeRunnerService';

// Virtual document scheme for "View source" on a launch or task. The extension
// registers a TextDocumentContentProvider for this scheme; VS Code opens the
// document as a read-only editor (all virtual docs are read-only by default).
export const SCHEME = 'rcm-launch-view';

// Builds a URI the user can open via vscode.window.showTextDocument. The
// path carries only a short, human-readable suffix (shown in the editor tab).
// The actual identifiers travel on the query string. Earlier versions packed
// folderKey into the path via encodeURIComponent — VS Code's Uri.path
// canonicalisation decodes percent-escaped slashes back to literal '/'s,
// which then get mis-split into multiple segments and the provider can't find
// anything. The query string survives that round-trip intact.
export function launchViewUri(folderKey: string, name: string): vscode.Uri {
  const safe = encodeURIComponent(name);
  const q = new URLSearchParams({ folderKey, name }).toString();
  return vscode.Uri.parse(`${SCHEME}:/launch/${safe}.jsonc?${q}`);
}

export function taskViewUri(folderKey: string, source: string, name: string): vscode.Uri {
  const safe = encodeURIComponent(name);
  const q = new URLSearchParams({ folderKey, source, name }).toString();
  return vscode.Uri.parse(`${SCHEME}:/task/${safe}.jsonc?${q}`);
}

export class NativeLaunchContentProvider implements vscode.TextDocumentContentProvider {
  // Emits whenever one of our documents needs redrawing (e.g. launch.json
  // changed on disk while a view is open).
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly native: NativeRunnerService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Identifiers live on the query; the path is purely cosmetic for the
    // editor tab label. See launchViewUri / taskViewUri for why.
    const q = new URLSearchParams(uri.query ?? '');
    const folderKey = q.get('folderKey') ?? '';
    const name = q.get('name') ?? '';
    const kind = uri.path.startsWith('/launch') ? 'launch'
               : uri.path.startsWith('/task')   ? 'task'
               : null;
    if (kind === 'launch') return renderLaunch(folderKey, name, this.native);
    if (kind === 'task') {
      const source = q.get('source') ?? '';
      return renderTask(folderKey, source, name, this.native);
    }
    return `// Unknown rcm-launch-view URI: ${uri.toString()}`;
  }
}

function renderLaunch(folderKey: string, name: string, native: NativeRunnerService): string {
  const launches = native.getLaunches();
  const launch = launches.find(l => l.folderKey === folderKey && l.name === name);
  if (!launch) {
    return `// Launch configuration "${name}" not found in ${folderKey}.\n// launch.json may have changed since this view was opened — close and re-open the item from the tree.\n`;
  }

  const sections: string[] = [];
  sections.push(headerFor(launch));
  sections.push(JSON.stringify(launch.raw, null, 2));

  // Append dependent tasks + referenced launches so everything relevant lives
  // in one read-only view.
  const deps = native.dependenciesOf(launch, launches);
  if (deps.length === 0) {
    return sections.join('\n');
  }

  sections.push('\n// -----------------------------------------------------------------');
  sections.push('// Dependencies referenced by this launch config (read-only view):');
  sections.push('// -----------------------------------------------------------------\n');

  for (const ref of deps) {
    if (ref.kind === 'launch') {
      const target = launches.find(l => l.folderKey === folderKey && l.name === ref.name);
      sections.push(`// Launch: "${ref.name}"`);
      sections.push(target ? JSON.stringify(target.raw, null, 2) : `// (not found in launch.json)`);
      sections.push('');
    } else {
      sections.push(`// Task: "${ref.name}"  (referenced via preLaunchTask / postDebugTask)`);
      sections.push('// Resolved at runtime by VS Code\'s task system. The tasks.json snippet below');
      sections.push('// is a best-effort match based on the task label.');
      sections.push('');
    }
  }
  // Task JSON snippets need an async lookup — fetch once and fill in.
  return sections.join('\n');
}

async function renderTask(folderKey: string, source: string, name: string, native: NativeRunnerService): Promise<string> {
  const tasks = await native.getTasks();
  const task = tasks.find(t => t.folderKey === folderKey && t.source === source && t.name === name);
  if (!task) {
    return `// Task "${name}" (${source}) not found.\n// It may be an auto-detected task that was unregistered.\n`;
  }
  return headerFor(task) + JSON.stringify(task.raw, null, 2);
}

function headerFor(item: NativeLaunch | NativeTask): string {
  if ('kind' in item) {
    return `// ${item.kind === 'compound' ? 'Compound' : 'Launch'} configuration — ${item.folderName}\n// Name: ${item.name}\n// Source: .vscode/launch.json\n\n`;
  }
  return `// Task — ${item.folderName}\n// Name: ${item.name}\n// Source: ${item.source}\n\n`;
}
