import * as vscode from 'vscode';

// Scans the project directory (up to SCAN_DEPTH levels) for Go files that
// contain both `package main` and `func main()`. Returns workspace-relative
// paths like './cmd/server/main.go'. Useful for populating the "Package"
// dropdown with detected main entry points.
//
// We return the *directory* (package path) rather than the file, because
// `go run` takes a package path, not an individual file.
const SCAN_DEPTH = 4;
const MAX_FILES = 500;

export async function findGoMains(projectRoot: vscode.Uri): Promise<string[]> {
  const pkgDirs = new Set<string>();
  let filesScanned = 0;

  async function scanDir(dirUri: vscode.Uri, depth: number): Promise<void> {
    if (depth > SCAN_DEPTH || filesScanned >= MAX_FILES) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (filesScanned >= MAX_FILES) break;
      // Skip hidden dirs and vendor/testdata
      if (name.startsWith('.') || name === 'vendor' || name === 'testdata') continue;
      if (type === vscode.FileType.Directory) {
        await scanDir(vscode.Uri.joinPath(dirUri, name), depth + 1);
      } else if (type === vscode.FileType.File && name.endsWith('.go') && !name.endsWith('_test.go')) {
        filesScanned++;
        const fileUri = vscode.Uri.joinPath(dirUri, name);
        if (await isMainFile(fileUri)) {
          // Store the directory as the package path, relative to projectRoot.
          const dirPath = dirUri.fsPath;
          const rootPath = projectRoot.fsPath;
          let rel = dirPath === rootPath ? '.' : dirPath.startsWith(rootPath + '/')
            ? './' + dirPath.slice(rootPath.length + 1)
            : dirPath;
          pkgDirs.add(rel);
        }
      }
    }
  }

  await scanDir(projectRoot, 0);
  return Array.from(pkgDirs).sort();
}

// Returns true if the file declares `package main` and has a `func main()`.
async function isMainFile(fileUri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(bytes);
    // Quick scan — don't try to parse Go AST, just check both markers.
    return /^\s*package\s+main\b/m.test(text) && /\bfunc\s+main\s*\(\s*\)/m.test(text);
  } catch {
    return false;
  }
}
