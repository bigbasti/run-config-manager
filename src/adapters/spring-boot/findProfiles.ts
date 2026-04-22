import * as vscode from 'vscode';

// Scans the project for Spring profile-specific resource files:
//   src/main/resources/application-<profile>.properties
//   src/main/resources/application-<profile>.yml
//   src/main/resources/application-<profile>.yaml
// Walks every module's src/main/resources under the build root, so multi-module
// projects surface profiles from any module.
export async function findSpringProfiles(projectRoot: vscode.Uri): Promise<string[]> {
  const found = new Set<string>();
  await walk(projectRoot, found, 0);
  return Array.from(found).sort();
}

const EXCLUDE_DIRS = new Set([
  'node_modules', 'target', 'build', 'out', '.gradle',
  '.idea', '.vscode', '.git', 'dist', 'bin',
]);
const MAX_DEPTH = 10;

async function walk(dir: vscode.Uri, out: Set<string>, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    if (kind === vscode.FileType.Directory) {
      if (EXCLUDE_DIRS.has(name)) continue;
      const child = vscode.Uri.joinPath(dir, name);
      // When we hit `resources`, scan its direct children for profile files.
      if (name === 'resources') {
        await scanResources(child, out);
        continue;
      }
      await walk(child, out, depth + 1);
    }
  }
}

async function scanResources(dir: vscode.Uri, out: Set<string>): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.File) continue;
    const m = name.match(/^application-([^.]+)\.(properties|yml|yaml)$/);
    if (m) out.add(m[1]);
  }
}
