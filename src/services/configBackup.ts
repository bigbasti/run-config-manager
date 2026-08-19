import * as vscode from 'vscode';
import { log } from '../utils/logger';

// Backups live outside the workspace on purpose: a migration that goes
// wrong shouldn't leave repair material inside the repo the user is
// about to commit, and a workspace that gets deleted shouldn't take the
// only copy of its configs with it.
export const BACKUP_DIR_NAME = '.run-configs';

// Anything outside this set is replaced, so a workspace called
// "my project/sub" can't escape the backup directory or produce a name
// Windows refuses to create.
const UNSAFE = /[^A-Za-z0-9._-]/g;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `dds2_run.json_2026-08-19_09-13-33`
 *
 * Local time, not UTC — the timestamp exists so a user can line a backup
 * up against "the thing that broke around 9am", and they think in local
 * time. Pure: the caller supplies the clock.
 */
export function backupFileName(folderName: string, when: Date): string {
  const safe = folderName.replace(UNSAFE, '_') || 'workspace';
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return `${safe}_run.json_${date}_${time}`;
}

export interface ArchiveRequest {
  /** Absolute path to the user's home directory. */
  homeDir: string;
  /** Workspace folder name, used to tell backups from different projects apart. */
  folderName: string;
  /** The exact bytes currently on disk, before any migration touched them. */
  contents: string;
  /** Injected clock, for deterministic tests. */
  now?: Date;
}

/**
 * Copy the pre-migration run.json into `~/.run-configs/`.
 *
 * Best-effort by design: a read-only home directory, a missing HOME, or
 * a permissions problem must not stop the user's configurations from
 * loading. Failures are logged and swallowed.
 *
 * @returns the path written, or undefined if nothing was archived.
 */
export async function archiveRunJson(req: ArchiveRequest): Promise<string | undefined> {
  const { homeDir, folderName, contents } = req;
  if (!homeDir) {
    log.warn('run.json backup skipped: no home directory available.');
    return undefined;
  }
  const when = req.now ?? new Date();
  const dir = vscode.Uri.file(`${homeDir}/${BACKUP_DIR_NAME}`);
  const target = vscode.Uri.joinPath(dir, backupFileName(folderName, when));
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(contents));
    log.info(`Archived pre-migration run.json to ${target.fsPath}`);
    return target.fsPath;
  } catch (e) {
    log.warn(`run.json backup failed (${target.fsPath}): ${(e as Error).message}`);
    return undefined;
  }
}
