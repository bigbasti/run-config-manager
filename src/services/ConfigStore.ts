import * as vscode from 'vscode';
import type { RunFile, InvalidConfigEntry } from '../shared/types';
import { parseRunFile, stringifyRunFile, RunConfigSchema } from '../shared/schema';
import { log } from '../utils/logger';

const EMPTY: RunFile = { version: 1, configurations: [] };

interface FolderEntry {
  folder: vscode.WorkspaceFolder;
  file: RunFile;
  invalid: InvalidConfigEntry[];
  lastError?: string;
  watcher?: vscode.Disposable;
  debounce?: NodeJS.Timeout;
}

export interface WriteOpts {
  removeInvalidIds?: string[];
}

export class ConfigStore {
  private entries = new Map<string, FolderEntry>();
  private emitter = new vscode.EventEmitter<string>();

  onChange = this.emitter.event;

  async attach(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    for (const folder of folders) {
      await this.attachFolder(folder);
    }
  }

  private async attachFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.fsPath;
    const entry: FolderEntry = { folder, file: EMPTY, invalid: [] };
    this.entries.set(key, entry);
    await this.reload(key);

    const pattern = new vscode.RelativePattern(folder, '.vscode/run.json');
    const w = vscode.workspace.createFileSystemWatcher(pattern as any);
    const schedule = () => this.debounceReload(key);
    const d1 = w.onDidChange(schedule);
    const d2 = w.onDidCreate(schedule);
    const d3 = w.onDidDelete(schedule);
    entry.watcher = {
      dispose: () => { d1.dispose(); d2.dispose(); d3.dispose(); w.dispose(); },
    };
  }

  private debounceReload(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      void this.reload(key);
    }, 200);
  }

  async reload(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    const uri = vscode.Uri.joinPath(entry.folder.uri, '.vscode', 'run.json');
    let raw: string;
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      raw = new TextDecoder().decode(buf);
    } catch {
      entry.file = EMPTY;
      entry.invalid = [];
      entry.lastError = undefined;
      this.emitter.fire(key);
      return;
    }

    // Fast path: strict parse.
    const parsed = parseRunFile(raw);
    if (parsed.ok) {
      entry.file = parsed.value;
      entry.invalid = [];
      entry.lastError = undefined;
      this.emitter.fire(key);
      return;
    }

    // Slow path: attempt JSON.parse + per-entry salvage.
    let raw2: any;
    try {
      raw2 = JSON.parse(raw);
    } catch (e) {
      entry.lastError = `Invalid JSON: ${(e as Error).message}`;
      log.error(`Invalid JSON at ${uri.fsPath}: ${entry.lastError}`);
      vscode.window.showErrorMessage(`Invalid .vscode/run.json: ${entry.lastError}`);
      this.emitter.fire(key);
      return;
    }

    const configurations = Array.isArray(raw2?.configurations) ? raw2.configurations : null;
    if (!configurations) {
      entry.lastError = parsed.error;
      log.error(`Invalid run.json at ${uri.fsPath}: ${parsed.error}`);
      vscode.window.showErrorMessage(`Invalid .vscode/run.json: ${parsed.error}`);
      this.emitter.fire(key);
      return;
    }

    const validList: RunFile['configurations'] = [];
    const invalidList: InvalidConfigEntry[] = [];
    for (const item of configurations) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || typeof item.name !== 'string') {
        log.warn(`Dropping unrecoverable entry from ${uri.fsPath} (missing id or name).`);
        continue;
      }
      const per = RunConfigSchema.safeParse(item);
      if (per.success) {
        validList.push(per.data);
      } else {
        const issue = per.error.issues[0];
        invalidList.push({
          id: item.id,
          name: item.name,
          rawText: JSON.stringify(item, null, 2),
          error: `${issue.path.join('.')}: ${issue.message}`,
        });
      }
    }

    entry.file = { version: 1, configurations: validList };
    entry.invalid = invalidList;
    entry.lastError =
      invalidList.length > 0
        ? `Found ${invalidList.length} invalid configuration(s). See the sidebar.`
        : parsed.error;

    if (invalidList.length > 0) {
      log.warn(`${uri.fsPath}: ${invalidList.length} invalid entr${invalidList.length === 1 ? 'y' : 'ies'}`);
      vscode.window.showWarningMessage(
        `${invalidList.length} invalid run configuration${invalidList.length === 1 ? '' : 's'} — see the sidebar for actions.`,
      );
    }
    this.emitter.fire(key);
  }

  getForFolder(key: string): RunFile {
    return this.entries.get(key)?.file ?? EMPTY;
  }

  invalidForFolder(key: string): InvalidConfigEntry[] {
    return this.entries.get(key)?.invalid ?? [];
  }

  lastError(key: string): string | undefined {
    return this.entries.get(key)?.lastError;
  }

  folderKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  getFolder(key: string): vscode.WorkspaceFolder | undefined {
    return this.entries.get(key)?.folder;
  }

  async write(key: string, file: RunFile, opts?: WriteOpts): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`No workspace folder attached for ${key}`);
    const dir = vscode.Uri.joinPath(entry.folder.uri, '.vscode');
    const target = vscode.Uri.joinPath(dir, 'run.json');
    const tmp = vscode.Uri.joinPath(dir, 'run.json.tmp');
    const encoded = new TextEncoder().encode(stringifyRunFile(file));
    await vscode.workspace.fs.writeFile(tmp, encoded);
    await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    entry.file = file;
    if (opts?.removeInvalidIds?.length) {
      entry.invalid = entry.invalid.filter(e => !opts.removeInvalidIds!.includes(e.id));
    }
    entry.lastError = undefined;
    this.emitter.fire(key);
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.watcher?.dispose();
      if (e.debounce) clearTimeout(e.debounce);
    }
    this.entries.clear();
    this.emitter.dispose();
  }
}
