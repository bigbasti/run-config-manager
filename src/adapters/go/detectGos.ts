import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

// A detected Go installation with optional version info.
export interface GoInstall {
  // Absolute path to the Go installation root (the directory containing bin/go).
  path: string;
  // Version string e.g. '1.22.3'. Filled by probeGosStreaming after the initial
  // list is emitted. Undefined until the version probe completes.
  version?: string;
}

// Returns a deduplicated list of Go installation root paths, ordered by
// detection priority (highest confidence first). The caller is responsible
// for kicking off version probes in a second pass.
//
// Detection sources, in priority order:
//   1. $GOROOT env var (explicit override by the user)
//   2. `which go` / `where go` resolved to its install root
//   3. Version managers: gvm, asdf, mise, goenv
//   4. Standard fixed locations (Homebrew, /usr/local/go, Windows paths)
export async function detectGos(): Promise<string[]> {
  const candidates: string[] = [];

  // 1. GOROOT env var
  if (process.env.GOROOT) {
    candidates.push(process.env.GOROOT);
  }

  // 2. `which go` / `where go`
  try {
    const whichResult = await runCommand(
      process.platform === 'win32' ? 'where' : 'which',
      ['go'],
    );
    if (whichResult) {
      for (const line of whichResult.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
        const installRoot = goHomeFromBin(line);
        if (installRoot) candidates.push(installRoot);
      }
    }
  } catch { /* which/where not available or go not on PATH */ }

  // 3. Version managers
  const home = os.homedir();

  // gvm: ~/.gvm/gos/<version>
  const gvmDir = path.join(home, '.gvm', 'gos');
  if (fs.existsSync(gvmDir)) {
    for (const entry of safeDirEntries(gvmDir)) {
      candidates.push(path.join(gvmDir, entry));
    }
  }

  // asdf: ~/.asdf/installs/go/<version>
  const asdfGoDir = path.join(home, '.asdf', 'installs', 'go');
  if (fs.existsSync(asdfGoDir)) {
    for (const entry of safeDirEntries(asdfGoDir)) {
      candidates.push(path.join(asdfGoDir, entry));
    }
  }

  // mise: ~/.local/share/mise/installs/go/<version>
  const miseGoDir = path.join(home, '.local', 'share', 'mise', 'installs', 'go');
  if (fs.existsSync(miseGoDir)) {
    for (const entry of safeDirEntries(miseGoDir)) {
      candidates.push(path.join(miseGoDir, entry));
    }
  }

  // goenv: ~/.goenv/versions/<version>
  const goenvDir = path.join(home, '.goenv', 'versions');
  if (fs.existsSync(goenvDir)) {
    for (const entry of safeDirEntries(goenvDir)) {
      candidates.push(path.join(goenvDir, entry));
    }
  }

  // 4. Standard fixed locations
  if (process.platform === 'darwin') {
    candidates.push(
      '/usr/local/go',
      '/opt/homebrew/opt/go/libexec',    // Homebrew on Apple Silicon
      '/usr/local/opt/go/libexec',        // Homebrew on Intel
    );
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/local/go',
      '/usr/lib/go',
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      'C:\\Go',
      'C:\\Program Files\\Go',
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'go'),
      path.join(os.homedir(), 'scoop', 'apps', 'go', 'current'),
      'C:\\ProgramData\\chocolatey\\lib\\golang\\tools\\go',
    );
  }

  // Validate and deduplicate
  return dedupeGos(candidates.filter(isValidGoInstall));
}

// Returns true if the directory has a usable `go` binary.
function isValidGoInstall(dir: string): boolean {
  if (!dir) return false;
  const bin = process.platform === 'win32'
    ? path.join(dir, 'bin', 'go.exe')
    : path.join(dir, 'bin', 'go');
  try {
    const stat = fs.statSync(bin);
    return stat.isFile();
  } catch {
    return false;
  }
}

// Given the absolute path to a `go` binary, returns its installation root
// (the directory whose `bin/` subdirectory contains the binary).
export function goHomeFromBin(goBin: string): string | null {
  // Resolve symlinks to get the canonical path.
  let resolved = goBin;
  try { resolved = fs.realpathSync(goBin); } catch { /* use original */ }

  const dir = path.dirname(resolved);
  if (path.basename(dir).toLowerCase() === 'bin') {
    return path.dirname(dir);
  }
  // Windows: go.exe may live directly in the install root on some setups.
  if (process.platform === 'win32' && path.basename(resolved).toLowerCase() === 'go.exe') {
    return dir;
  }
  return null;
}

// Deduplicate by resolving symlinks (so /usr/local/opt/go/libexec and a
// symlink to the same directory don't appear twice).
function dedupeGos(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    let real = p;
    try { real = fs.realpathSync(p); } catch { /* use original */ }
    if (!seen.has(real)) {
      seen.add(real);
      result.push(p);
    }
  }
  return result;
}

function safeDirEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(e => {
      try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

// Runs a command with a timeout, returns trimmed stdout or null on failure.
export function runCommand(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise(resolve => {
    const proc = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout.trim() || null);
    });
    proc.on('error', () => resolve(null));
  });
}
