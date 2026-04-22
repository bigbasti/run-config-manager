import * as vscode from 'vscode';
import type { RunFile } from '../shared/types';
import { parseRunFile, stringifyRunFile } from '../shared/schema';
import { log } from '../utils/logger';

const EMPTY: RunFile = { version: 1, configurations: [] };

interface FolderEntry {
  folder: vscode.WorkspaceFolder;
  file: RunFile;
  lastError?: string;
  watcher?: vscode.Disposable;
  debounce?: NodeJS.Timeout;
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
    const entry: FolderEntry = { folder, file: EMPTY };
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
      entry.lastError = undefined;
      this.emitter.fire(key);
      return;
    }
    const parsed = parseRunFile(raw);
    if (!parsed.ok) {
      entry.lastError = parsed.error;
      log.error(`Invalid run.json at ${uri.fsPath}: ${parsed.error}`);
      vscode.window.showErrorMessage(`Invalid .vscode/run.json: ${parsed.error}`);
      this.emitter.fire(key);
      return;
    }
    entry.lastError = undefined;
    entry.file = parsed.value;
    this.emitter.fire(key);
  }

  getForFolder(key: string): RunFile {
    return this.entries.get(key)?.file ?? EMPTY;
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

  async write(key: string, file: RunFile): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`No workspace folder attached for ${key}`);
    const dir = vscode.Uri.joinPath(entry.folder.uri, '.vscode');
    const target = vscode.Uri.joinPath(dir, 'run.json');
    const tmp = vscode.Uri.joinPath(dir, 'run.json.tmp');
    const encoded = new TextEncoder().encode(stringifyRunFile(file));
    await vscode.workspace.fs.writeFile(tmp, encoded);
    await vscode.workspace.fs.rename(tmp, target);
    entry.file = file;
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
