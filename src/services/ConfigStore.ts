import * as vscode from 'vscode';
import * as os from 'os';
import type { RunFile, InvalidConfigEntry } from '../shared/types';
import { parseRunFile, stringifyRunFile, RunConfigSchema } from '../shared/schema';
import { deriveKnownFolders } from '../shared/folderPath';
import { log } from '../utils/logger';
import { migrateSpringBootConfig } from './migrateSpringBoot';
import { EXTENSION_VERSION } from '../utils/extensionVersion';
import { runMigrations } from './migrations';
import { archiveRunJson } from './configBackup';

const EMPTY: RunFile = { version: EXTENSION_VERSION, configurations: [], groups: [] };

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

export interface ConfigStoreOpts {
  /** Where migration backups go. Defaults to the real home directory. */
  backupHomeDir?: string;
  /** Injected clock for backup filenames, for deterministic tests. */
  now?: () => Date;
}

export class ConfigStore {
  private entries = new Map<string, FolderEntry>();
  private emitter = new vscode.EventEmitter<string>();
  private backupHomeDir: string;
  private now: () => Date;

  onChange = this.emitter.event;

  constructor(opts?: ConfigStoreOpts) {
    this.backupHomeDir = opts?.backupHomeDir ?? safeHomeDir();
    this.now = opts?.now ?? (() => new Date());
  }

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
    } catch (e) {
      if (!isFileNotFound(e)) {
        // A read that failed for any reason other than "not there" is
        // transient — most often the sliver between writeFile(tmp) and
        // rename, where run.json genuinely doesn't exist for an instant.
        // Collapsing that to EMPTY would let the next write from any
        // caller (a user edit, the docker healer) persist the emptiness
        // and destroy the user's configurations.
        log.warn(`Could not read ${uri.fsPath}, keeping the previously loaded configurations: ${(e as Error).message}`);
        return;
      }
      entry.file = EMPTY;
      entry.invalid = [];
      entry.lastError = undefined;
      this.emitter.fire(key);
      return;
    }

    // Fast path: strict parse. Apply per-row migrations first so legacy
    // spring-boot configs keep validating.
    const migrated = migrateRaw(raw);
    const parsed = parseRunFile(migrated);
    if (parsed.ok) {
      // Migration step (legacy): when an older run.json is missing
      // the top-level `groups` array, derive it from every prefix of
      // every config.group so empty / pre-existing folders still
      // render. After the first save the file gains the field on
      // disk.
      if (!parsed.value.groups) {
        parsed.value.groups = deriveKnownFolders(
          parsed.value.configurations.map(c => c.group),
        );
      }

      // Migration step: walk the registered version migrations. The
      // runner stamps `version` onto the result and reports whether
      // anything actually changed. We persist back only when the
      // content changed OR the on-disk version didn't already match
      // the extension — pure version-bump-only rewrites would touch
      // every workspace's run.json on every release, which would be
      // git-noise for users who get nothing functional from the bump.
      const onDiskVersion = parsed.value.version;
      const result = runMigrations(parsed.value, EXTENSION_VERSION);
      const versionStale = onDiskVersion !== result.finalVersion;
      entry.file = result.file;
      entry.invalid = [];
      entry.lastError = undefined;
      log.debug(
        `Loaded ${uri.fsPath}: ${result.file.configurations.length} configuration(s), ` +
        `${result.file.groups?.length ?? 0} folder(s), version ${result.finalVersion}` +
        (result.contentChanged ? ' (migrated)' : ''),
      );
      this.emitter.fire(key);
      // Persist when something on disk needs updating. Skip when the
      // file is brand-new / empty — no value in writing a version
      // stamp into an empty run.json before the user has any configs.
      if ((result.contentChanged || versionStale) && entry.file.configurations.length > 0) {
        // A migration rewrote the user's configurations. Keep a copy of
        // exactly what was on disk first, so a migration bug is
        // recoverable. Only on contentChanged — a bare version stamp
        // isn't worth a backup, and would otherwise produce one file
        // per release for every workspace.
        if (result.contentChanged) {
          await archiveRunJson({
            homeDir: this.backupHomeDir,
            folderName: entry.folder.name,
            contents: raw,
            now: this.now(),
          });
        }
        // Fire-and-forget: write() schedules its own debounce, and we
        // don't want load() to depend on the file being on disk.
        this.write(key, entry.file).catch(e =>
          log.warn(`Post-migration save failed for ${uri.fsPath}: ${(e as Error).message}`),
        );
      }
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
      const per = RunConfigSchema.safeParse(migrateSpringBootConfig(item));
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

    entry.file = {
      version: EXTENSION_VERSION,
      configurations: validList,
      groups: deriveKnownFolders(validList.map(c => c.group)),
    };
    entry.invalid = invalidList;
    entry.lastError =
      invalidList.length > 0
        ? `Found ${invalidList.length} invalid configuration(s). See the sidebar.`
        : parsed.error;

    log.debug(`Loaded ${uri.fsPath}: ${validList.length} valid, ${invalidList.length} invalid`);
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
    const text = stringifyRunFile(file);
    // Skip the physical write when the file already holds exactly these
    // bytes. Touching run.json wakes the FileSystemWatcher, which
    // reloads, which may write again — so a no-op write is the raw
    // material of a rewrite loop. In-memory state and onChange still
    // proceed, so callers can't tell the difference.
    if (!(await this.matchesOnDisk(target, text))) {
      const encoded = new TextEncoder().encode(text);
      await vscode.workspace.fs.writeFile(tmp, encoded);
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    }
    entry.file = file;
    if (opts?.removeInvalidIds?.length) {
      entry.invalid = entry.invalid.filter(e => !opts.removeInvalidIds!.includes(e.id));
    }
    entry.lastError = undefined;
    this.emitter.fire(key);
  }

  // True when `target` exists and already decodes to exactly `text`.
  // Any read failure counts as "different" so we fall through to the
  // write rather than silently dropping it.
  private async matchesOnDisk(target: vscode.Uri, text: string): Promise<boolean> {
    try {
      const buf = await vscode.workspace.fs.readFile(target);
      return new TextDecoder().decode(buf) === text;
    } catch {
      return false;
    }
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

// Apply row-level migrations before strict schema parsing so legacy configs
// don't get flagged invalid. The raw text stays unchanged on disk; only the
// in-memory parsed value is migrated.
function migrateRaw(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.configurations)) return raw;
    // Pre-schema coercion: legacy run.json files used `version: 1`
    // (a number literal — the format predates the migration system).
    // The schema now expects a semver string. We deliberately map the
    // legacy literal to "0.0.0" so every registered migration runs on
    // first load; mapping it to "1.0.0" would make the migrator treat
    // the file as current and skip everything.
    //
    // Only genuine pre-semver forms qualify: the bare number, a missing
    // version, and the hand-written strings "1" / "1.0". A complete
    // three-part semver is a real version and must be left alone —
    // swallowing "1.0.0" here made every file written by the 1.0.0
    // extension look permanently stale, so reload() wrote it back, the
    // watcher fired, and run.json rewrote itself in a loop forever.
    if (parsed.version === 1
        || parsed.version === undefined
        || parsed.version === null
        || parsed.version === '1'
        || parsed.version === '1.0') {
      parsed.version = '0.0.0';
    } else if (typeof parsed.version === 'number') {
      // Any other bare-number version (e.g. version: 2, future
      // pre-semver experiment) → coerce by treating as the major.
      parsed.version = `${parsed.version}.0.0`;
    }
    parsed.configurations = parsed.configurations.map(migrateSpringBootConfig);
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

// "The file isn't there" arrives spelled several ways depending on who
// raised it: vscode.FileSystemError uses `code`/`name` of "FileNotFound"
// (some providers say "EntryNotFound"), while a raw Node error says
// "ENOENT". Getting this wrong in the strict direction is the dangerous
// one — a real deletion that we fail to recognise would leave the tree
// showing configurations that no longer exist — so match generously and
// fall back to the message.
function isFileNotFound(e: unknown): boolean {
  const err = e as { code?: string; name?: string; message?: string } | undefined;
  const tokens = [err?.code, err?.name, err?.message].filter(Boolean).join(' ');
  return /FileNotFound|EntryNotFound|ENOENT|NotFound/i.test(tokens);
}

// os.homedir() throws on exotic setups with no HOME and no passwd entry.
// The backup path treats "" as "nowhere to write", which is exactly right.
function safeHomeDir(): string {
  try {
    return os.homedir() || '';
  } catch {
    return '';
  }
}
