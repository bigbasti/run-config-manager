import * as vscode from 'vscode';

// Best-effort resolution of the port Spring Boot will listen on, given:
//   - the project folder (to locate application-*.properties / yml),
//   - the active profiles (comma-separated string from typeOptions.profiles).
//
// Precedence (Spring Boot's own rules, simplified):
//   1. The last active profile's application-<profile>.properties / yml wins.
//   2. Otherwise fall back to application.properties / yml.
//   3. Otherwise 8080 (Spring Boot default).
//
// We only parse `server.port=<n>` — YAML subtrees and random placeholders
// are out of scope. Returns null when nothing usable is found.
export async function readServerPort(
  projectRoot: vscode.Uri,
  activeProfiles: string,
): Promise<number | null> {
  const profiles = activeProfiles.split(',').map(s => s.trim()).filter(Boolean);

  // Try active profiles in reverse so the last one wins (matches Spring semantics).
  for (const p of [...profiles].reverse()) {
    const port = await readFromProfile(projectRoot, p);
    if (port !== null) return port;
  }
  // Fall back to the generic application.properties / yml.
  return readFromProfile(projectRoot, null);
}

async function readFromProfile(projectRoot: vscode.Uri, profile: string | null): Promise<number | null> {
  const names = profile
    ? [`application-${profile}.properties`, `application-${profile}.yml`, `application-${profile}.yaml`]
    : ['application.properties', 'application.yml', 'application.yaml'];

  // Search all src/main/resources directories under the project. Supports
  // multi-module projects where the submodule has its own resources.
  const resourceDirs = await findResourceDirs(projectRoot);

  for (const dir of resourceDirs) {
    for (const name of names) {
      const uri = vscode.Uri.joinPath(dir, name);
      const text = await readText(uri);
      if (text === null) continue;
      const port = extractServerPort(text, name);
      if (port !== null) return port;
    }
  }
  return null;
}

async function findResourceDirs(root: vscode.Uri): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  await walk(root, out, 0);
  return out;
}

const EXCLUDE = new Set(['node_modules', 'target', 'build', 'out', '.gradle', '.idea', '.vscode', '.git']);
const MAX_DEPTH = 8;

async function walk(dir: vscode.Uri, out: vscode.Uri[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.Directory) continue;
    if (EXCLUDE.has(name)) continue;
    const child = vscode.Uri.joinPath(dir, name);
    if (name === 'resources' && (dir.fsPath.endsWith('/src/main') || dir.fsPath.endsWith('\\src\\main'))) {
      out.push(child);
      continue;
    }
    await walk(child, out, depth + 1);
  }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch { return null; }
}

// Extract `server.port`. Handles properties format and a minimal YAML form
// (top-level `server:` → `  port: 1234`). We deliberately don't evaluate
// ${} placeholders — those would need env at launch, and the caller only
// uses this result as a hint to poll.
function extractServerPort(text: string, fileName: string): number | null {
  if (fileName.endsWith('.properties')) {
    const m = text.match(/^\s*server\.port\s*[=:]\s*(\d+)\s*$/m);
    if (m) return parseInt(m[1], 10);
    return null;
  }
  // YAML: find `server:` at column 0, then `  port: <n>` indented under it.
  const lines = text.split(/\r?\n/);
  let inServer = false;
  for (const raw of lines) {
    if (/^server:\s*$/.test(raw)) { inServer = true; continue; }
    if (inServer) {
      if (/^\S/.test(raw)) { inServer = false; continue; }  // exited the block
      const m = raw.match(/^\s+port:\s*(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    // Flat form: server.port: 1234
    const m = raw.match(/^server\.port:\s*(\d+)\s*$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
