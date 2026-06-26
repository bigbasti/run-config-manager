import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export function resolveProjectUri(
  folder: vscode.WorkspaceFolder,
  projectPath: string,
): vscode.Uri {
  if (!projectPath) return folder.uri;
  // A project may live outside the open workspace folder. Users can type (or
  // pick) an absolute path, or a `~`-relative path pointing at their home
  // directory. In those cases the path must be used as-is — joining it onto the
  // workspace folder would produce a bogus concatenated path (e.g.
  // /ws/app/Users/me/project) that breaks both detection and the run cwd.
  const expanded = expandHome(projectPath);
  if (path.isAbsolute(expanded)) {
    return vscode.Uri.file(expanded);
  }
  return vscode.Uri.joinPath(folder.uri, expanded);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function relativeFromWorkspace(
  folder: vscode.WorkspaceFolder,
  target: vscode.Uri,
): string {
  const rel = path.relative(folder.uri.fsPath, target.fsPath);
  return rel.split(path.sep).join('/');
}
