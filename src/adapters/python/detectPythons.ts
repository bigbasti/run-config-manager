import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

export interface PythonInfo {
  // Absolute path to the install directory containing bin/python (POSIX)
  // or python.exe (Windows). Mirrors NodeInfo / JdkInfo.
  path: string;
  // Filled in by probePythonVersion; absent at first emit.
  version?: string;
}

// Returns Python install directories found on this machine. Each entry is
// guaranteed to have a usable python binary. Versions are NOT populated
// here — call probePythonVersion(path) separately, in parallel.
//
// Detection sources, in priority order (project-local venvs win the
// default-selection race in the streaming probe):
//   1. Project-local venvs (.venv / venv / env)
//   2. $VIRTUAL_ENV
//   3. `which python3` / `which python` resolved through symlinks
//   4. Version managers (pyenv, asdf, rye, uv, mise, conda)
//   5. Fixed roots (Linux, macOS framework paths, Windows)
export async function detectPythons(projectUri: vscode.Uri): Promise<string[]> {
  const found: string[] = [];

  // 1. Project-local venvs.
  for (const sub of ['.venv', 'venv', 'env']) {
    found.push(path.join(projectUri.fsPath, sub));
  }

  // 2. VIRTUAL_ENV.
  if (process.env.VIRTUAL_ENV) found.push(process.env.VIRTUAL_ENV);

  // 3. which python.
  for (const p of await whichPython()) found.push(p);

  // 4. Version managers.
  for (const p of await scanVersionManagerDirs()) found.push(p);

  // 5. Fixed roots.
  for (const p of await scanFixedRoots()) found.push(p);

  const out = await dedupeRealPythons(found);
  log.debug(`detectPythons: found ${out.length} unique Python install(s)`);
  return out;
}

// Spawn-and-collect with a hard timeout. Used by whichPython.
function runCommand(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(command, args, { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
  });
}

async function whichPython(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const homes: string[] = [];
  for (const probe of ['python3', 'python']) {
    try {
      const out = await runCommand(cmd, [probe], 1500);
      if (!out) continue;
      const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const bin of lines) {
        let real: string;
        try { real = await fs.promises.realpath(bin); }
        catch { real = bin; }
        const home = pythonHomeFromBin(real);
        if (home) homes.push(home);
      }
    } catch (e) {
      log.debug(`whichPython(${probe}) failed: ${(e as Error).message}`);
    }
  }
  return homes;
}

async function scanVersionManagerDirs(): Promise<string[]> {
  const home = os.homedir();
  const out: string[] = [];

  // pyenv: ~/.pyenv/versions/<v>
  for (const p of await listChildDirs(path.join(home, '.pyenv', 'versions'))) out.push(p);

  // asdf: ~/.asdf/installs/python/<v>
  for (const p of await listChildDirs(path.join(home, '.asdf', 'installs', 'python'))) out.push(p);

  // rye: ~/.rye/py/<v>/install AND ~/.local/share/rye/py/<v>/install
  for (const v of await listChildDirs(path.join(home, '.rye', 'py'))) {
    out.push(path.join(v, 'install'));
  }
  for (const v of await listChildDirs(path.join(home, '.local', 'share', 'rye', 'py'))) {
    out.push(path.join(v, 'install'));
  }

  // uv: ~/.local/share/uv/python/<v>
  for (const p of await listChildDirs(path.join(home, '.local', 'share', 'uv', 'python'))) {
    out.push(p);
  }

  // mise: ~/.local/share/mise/installs/python/<v>
  for (const p of await listChildDirs(path.join(home, '.local', 'share', 'mise', 'installs', 'python'))) {
    out.push(p);
  }

  // conda envs.
  for (const root of [
    path.join(home, '.conda', 'envs'),
    path.join(home, 'miniconda3', 'envs'),
    path.join(home, 'anaconda3', 'envs'),
  ]) {
    for (const p of await listChildDirs(root)) out.push(p);
  }

  return out;
}

async function scanFixedRoots(): Promise<string[]> {
  const out: string[] = [];
  // POSIX system locations — push the install DIR, not the bin path.
  // /usr is the dir containing bin/python3, /usr/local same.
  out.push('/usr', '/usr/local');

  // Homebrew (macOS)
  for (const p of await listChildDirs('/opt/homebrew/opt')) {
    if (path.basename(p).toLowerCase().startsWith('python')) {
      // The dir containing bin/python3.
      out.push(p);
    }
  }
  for (const p of await listChildDirs('/usr/local/opt')) {
    if (path.basename(p).toLowerCase().startsWith('python')) out.push(p);
  }

  // macOS Frameworks: /Library/Frameworks/Python.framework/Versions/<v>/
  for (const p of await listChildDirs('/Library/Frameworks/Python.framework/Versions')) {
    out.push(p);
  }

  // Windows.
  for (const root of [
    'C:\\Python', // Python313/, etc — handled via prefix scan below
  ]) void root;
  for (const root of [
    'C:\\',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ]) {
    for (const p of await listChildDirs(root)) {
      const base = path.basename(p).toLowerCase();
      if (base.startsWith('python')) out.push(p);
    }
  }
  // Windows per-user installs.
  if (process.env.LOCALAPPDATA) {
    for (const p of await listChildDirs(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'))) {
      out.push(p);
    }
  }

  return out;
}

async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Walk upward from a python binary path to its install home. POSIX:
// `<home>/bin/python` → `<home>`. Windows: `<home>/python.exe` → `<home>`.
function pythonHomeFromBin(pythonBin: string): string | null {
  const dir = path.dirname(pythonBin);
  if (process.platform === 'win32') {
    const base = path.basename(pythonBin).toLowerCase();
    if (base === 'python.exe' || base === 'python3.exe') return dir;
    return null;
  }
  if (path.basename(dir).toLowerCase() === 'bin') return path.dirname(dir);
  return null;
}

async function dedupeRealPythons(paths: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    // Validate: must have at least one python binary.
    const candidates = process.platform === 'win32'
      ? [path.join(p, 'python.exe'), path.join(p, 'python3.exe')]
      : [path.join(p, 'bin', 'python'), path.join(p, 'bin', 'python3')];
    let exists = false;
    for (const c of candidates) {
      try {
        const stat = await fs.promises.stat(c);
        if (stat.isFile()) { exists = true; break; }
      } catch { /* nope */ }
    }
    if (!exists) continue;

    let real: string;
    try { real = await fs.promises.realpath(p); }
    catch { real = p; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    out.push(p);
  }
  return out;
}
