import * as vscode from 'vscode';

// Walks up from the chosen project folder looking for the Gradle/Maven root.
// For Gradle: stops at the first ancestor containing settings.gradle[.kts] OR
// gradlew. For Maven: stops at the topmost ancestor whose pom.xml lists the
// current dir as a <module> (i.e., the reactor root). On failure returns the
// starting folder — callers treat that as "single-module / self-rooted".
export async function findGradleRoot(start: vscode.Uri): Promise<vscode.Uri> {
  let cur = start;
  for (let depth = 0; depth < 10; depth++) {
    if (
      (await exists(vscode.Uri.joinPath(cur, 'settings.gradle'))) ||
      (await exists(vscode.Uri.joinPath(cur, 'settings.gradle.kts'))) ||
      (await exists(vscode.Uri.joinPath(cur, 'gradlew')))
    ) {
      return cur;
    }
    const parent = parentOf(cur);
    if (!parent) return start;
    cur = parent;
  }
  return start;
}

// Maven reactor root: keep walking up as long as each parent has a pom.xml
// that lists the current directory as a <module>. This correctly resolves
// multi-module projects where /git/dds2/pom.xml declares api, data, etc.
export async function findMavenRoot(start: vscode.Uri): Promise<vscode.Uri> {
  let cur = start;
  for (let depth = 0; depth < 10; depth++) {
    const parent = parentOf(cur);
    if (!parent) return cur;
    const parentPom = vscode.Uri.joinPath(parent, 'pom.xml');
    const pomText = await readText(parentPom);
    if (!pomText) return cur;
    const childName = cur.fsPath.split('/').pop() ?? '';
    // Very loose regex: matches `<module>childName</module>` with optional whitespace.
    const re = new RegExp(`<module>\\s*${escapeRegex(childName)}\\s*</module>`);
    if (!re.test(pomText)) return cur;
    cur = parent;
  }
  return cur;
}

function parentOf(uri: vscode.Uri): vscode.Uri | null {
  const parts = uri.fsPath.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  return vscode.Uri.file('/' + parts.slice(0, -1).join('/'));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Given the Gradle root and a project path, compute the Gradle task prefix for
// the sub-module. Returns ':api' for /git/dds2/api when root is /git/dds2.
// Returns '' when rootPath === projectPath (root project).
export function gradleModulePrefix(rootFsPath: string, projectFsPath: string): string {
  if (rootFsPath === projectFsPath) return '';
  if (!projectFsPath.startsWith(rootFsPath + '/')) return '';
  const rel = projectFsPath.slice(rootFsPath.length + 1);
  return ':' + rel.split('/').join(':');
}
