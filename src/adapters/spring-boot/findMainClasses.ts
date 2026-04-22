import * as vscode from 'vscode';

export interface MainClassCandidate {
  fqn: string;
  file: string;
  isSpringBoot: boolean;
}

const EXCLUDE_DIRS = new Set([
  'node_modules', 'target', 'build', 'out', '.gradle',
  '.idea', '.vscode', '.git', 'dist', 'bin',
]);

const MAX_FILES = 2000;
const MAX_DEPTH = 10;

export async function findMainClasses(projectRoot: vscode.Uri): Promise<MainClassCandidate[]> {
  const sourceDirs: vscode.Uri[] = [];
  await collectSourceDirs(projectRoot, sourceDirs, 0);

  const candidates: MainClassCandidate[] = [];
  let scanned = 0;
  outer: for (const dir of sourceDirs) {
    for await (const file of walkFiles(dir, 0)) {
      if (scanned >= MAX_FILES) break outer;
      scanned++;
      const name = file.fsPath.split('/').pop() ?? '';
      if (!name.endsWith('.java') && !name.endsWith('.kt')) continue;
      const cand = await examineFile(file);
      if (cand) candidates.push(cand);
    }
  }

  candidates.sort((a, b) => {
    if (a.isSpringBoot !== b.isSpringBoot) return a.isSpringBoot ? -1 : 1;
    return a.fqn.localeCompare(b.fqn);
  });
  return candidates;
}

async function collectSourceDirs(dir: vscode.Uri, out: vscode.Uri[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.Directory) continue;
    if (EXCLUDE_DIRS.has(name)) continue;
    const child = vscode.Uri.joinPath(dir, name);
    if (name === 'java' || name === 'kotlin') {
      // Path shape: <...>/src/main/(java|kotlin)
      const segments = dir.fsPath.split('/');
      const parent = segments[segments.length - 1];
      const grandparent = segments[segments.length - 2];
      if (parent === 'main' && grandparent === 'src') {
        out.push(child);
        continue;
      }
    }
    await collectSourceDirs(child, out, depth + 1);
  }
}

async function* walkFiles(dir: vscode.Uri, depth: number): AsyncGenerator<vscode.Uri> {
  if (depth > MAX_DEPTH) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    const child = vscode.Uri.joinPath(dir, name);
    if (kind === vscode.FileType.Directory) {
      if (EXCLUDE_DIRS.has(name)) continue;
      yield* walkFiles(child, depth + 1);
    } else if (kind === vscode.FileType.File) {
      yield child;
    }
  }
}

async function examineFile(file: vscode.Uri): Promise<MainClassCandidate | null> {
  let text: string;
  try {
    const buf = await vscode.workspace.fs.readFile(file);
    text = new TextDecoder().decode(buf);
  } catch {
    return null;
  }

  const hasSpringBoot = /@SpringBootApplication\b/.test(text);
  // Java: public static void main(String[] args). Kotlin: top-level `fun main(`.
  const hasMain = /public\s+static\s+void\s+main\s*\(/.test(text) || /\bfun\s+main\s*\(/.test(text);
  if (!hasSpringBoot && !hasMain) return null;

  const pkgMatch = text.match(/^\s*package\s+([\w.]+)\s*;?/m);
  const pkg = pkgMatch?.[1] ?? '';
  const fileName = file.fsPath.split('/').pop() ?? '';
  const className = fileName.replace(/\.(java|kt)$/, '');
  const fqn = pkg ? `${pkg}.${className}` : className;
  return { fqn, file: file.fsPath, isSpringBoot: hasSpringBoot };
}
