import * as vscode from 'vscode';

// Scans the project for Quarkus profiles. Quarkus, unlike Spring Boot, uses a
// single `application.properties` with `%<profile>.` prefixed keys (or, more
// rarely, a top-level `"%<profile>":` block in YAML). It also supports separate
// `application-<profile>.{properties,yml,yaml}` files. We gather names from all
// three sources and dedupe.
export async function findQuarkusProfiles(projectRoot: vscode.Uri): Promise<string[]> {
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
    // application-<profile>.{properties,yml,yaml}
    const m = name.match(/^application-([^.]+)\.(properties|yml|yaml)$/);
    if (m) {
      out.add(m[1]);
      continue;
    }
    // Parse the base application.* files for %<profile>. prefixes.
    if (/^application\.(properties|yml|yaml)$/.test(name)) {
      const text = await readText(vscode.Uri.joinPath(dir, name));
      if (!text) continue;
      // Properties: `%dev.foo=…` or `%"dev,test".foo=…` (Quarkus accepts a
      // multi-profile form; we extract individual names for the picker).
      for (const m of text.matchAll(/^\s*%([\w,"\s-]+?)\./gm)) {
        for (const p of splitProfileList(m[1])) out.add(p);
      }
      // YAML: top-level `"%dev":` block.
      for (const m of text.matchAll(/^\s*"?%([\w,\s-]+?)"?\s*:\s*$/gm)) {
        for (const p of splitProfileList(m[1])) out.add(p);
      }
    }
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

function splitProfileList(raw: string): string[] {
  return raw
    .replace(/["\s]/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
