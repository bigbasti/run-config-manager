import * as vscode from 'vscode';
import * as path from 'path';

export function resolveProjectUri(
  folder: vscode.WorkspaceFolder,
  projectPath: string,
): vscode.Uri {
  if (!projectPath) return folder.uri;
  return vscode.Uri.joinPath(folder.uri, projectPath);
}

export function relativeFromWorkspace(
  folder: vscode.WorkspaceFolder,
  target: vscode.Uri,
): string {
  const rel = path.relative(folder.uri.fsPath, target.fsPath);
  return rel.split(path.sep).join('/');
}
