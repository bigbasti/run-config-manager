import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';
import { userInstallRoot } from '../../services/archiveInstall';

export interface NodeInfo {
  // Absolute path to the install directory. Contains `bin/node` on
  // POSIX and `node.exe` directly at the root on Windows.
  path: string;
  // Populated by probeNodeVersion; empty until the version probe runs.
  version?: string;
}

// Returns the list of Node install directories detected on this
// machine. Each entry is guaranteed to have a usable node binary.
// Versions are NOT populated — call `probeNodeVersion(path)` for each
// in parallel.
//
// Detection sources, in priority order:
//   1. Env vars (NODE_HOME, NVM_DIR).
//   2. `which node` / `where node` resolved through symlinks.
//   3. The extension's own install root (~/.rcm/nodes/*).
//   4. Version managers: nvm, volta, asdf, fnm, n.
//   5. Fixed filesystem roots.
export async function detectNodes(): Promise<string[]> {
  const found: string[] = [];

  // 1. Env vars.
  if (process.env.NODE_HOME) found.push(process.env.NODE_HOME);
  if (process.env.NVM_DIR) {
    const nvmVersions = path.join(process.env.NVM_DIR, 'versions', 'node');
    for (const c of await listChildDirs(nvmVersions)) found.push(c);
  }

  // 2. `which node` / `where node`.
  for (const p of await whichNode()) found.push(p);

  // 3. Extension's own install root.
  for (const p of await listChildDirs(userInstallRoot('nodes'))) found.push(p);

  // 4. Version managers.
  for (const p of await scanVersionManagerDirs()) found.push(p);

  // 5. Fixed roots.
  for (const p of await scanFixedRoots()) found.push(p);

  const out = await dedupeRealNodes(found);
  log.debug(`detectNodes: found ${out.length} unique Node install(s)`);
  return out;
}

// Spawn-and-collect with a hard timeout, mirroring the helper in
// detectJdks.ts. Used by the version probe.
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

async function whichNode(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await runCommand(cmd, ['node'], 1500);
    if (!out) return [];
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const homes: string[] = [];
    for (const nodeBin of lines) {
      let real: string;
      try { real = await fs.promises.realpath(nodeBin); }
      catch { real = nodeBin; }
      const home = nodeHomeFromBin(real);
      if (home) homes.push(home);
    }
    return homes;
  } catch (e) {
    log.debug(`whichNode failed: ${(e as Error).message}`);
    return [];
  }
}

async function scanVersionManagerDirs(): Promise<string[]> {
  const home = os.homedir();
  const out: string[] = [];

  // nvm: ~/.nvm/versions/node/<v>
  for (const p of await listChildDirs(path.join(home, '.nvm', 'versions', 'node'))) {
    out.push(p);
  }
  // volta: ~/.volta/tools/image/node/<v>
  for (const p of await listChildDirs(path.join(home, '.volta', 'tools', 'image', 'node'))) {
    out.push(p);
  }
  // asdf: ~/.asdf/installs/nodejs/<v>
  for (const p of await listChildDirs(path.join(home, '.asdf', 'installs', 'nodejs'))) {
    out.push(p);
  }
  // fnm: ~/.fnm/node-versions/v<ver>/installation
  for (const p of await listChildDirs(path.join(home, '.fnm', 'node-versions'))) {
    out.push(path.join(p, 'installation'));
  }
  // n: ~/.n/versions/node/<v> (also ~/n on some setups)
  for (const p of await listChildDirs(path.join(home, '.n', 'versions', 'node'))) {
    out.push(p);
  }
  for (const p of await listChildDirs(path.join(home, 'n', 'versions', 'node'))) {
    out.push(p);
  }

  return out;
}

async function scanFixedRoots(): Promise<string[]> {
  const out: string[] = [];

  const linuxOpt = await listChildDirs('/opt');
  for (const c of linuxOpt) {
    if (path.basename(c).toLowerCase().startsWith('node')) out.push(c);
  }

  const homebrew = await listChildDirs('/opt/homebrew/opt');
  for (const c of homebrew) {
    if (path.basename(c).toLowerCase().startsWith('node')) out.push(c);
  }
  const usrLocalOpt = await listChildDirs('/usr/local/opt');
  for (const c of usrLocalOpt) {
    if (path.basename(c).toLowerCase().startsWith('node')) out.push(c);
  }

  // Windows default Program Files install.
  out.push('C:\\Program Files\\nodejs');
  out.push('C:\\Program Files (x86)\\nodejs');

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

// Walk upward from a node binary path to its install home (the dir
// that contains bin/node on POSIX, or contains node.exe directly on
// Windows). Returns null when the path doesn't fit either layout.
function nodeHomeFromBin(nodeBin: string): string | null {
  const dir = path.dirname(nodeBin);
  if (process.platform === 'win32') {
    // node.exe lives at the install root itself.
    return dir;
  }
  if (path.basename(dir).toLowerCase() === 'bin') return path.dirname(dir);
  return null;
}

async function dedupeRealNodes(paths: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const nodeBin = path.join(
      p,
      process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'),
    );
    let exists = false;
    try {
      const stat = await fs.promises.stat(nodeBin);
      exists = stat.isFile();
    } catch { /* nope */ }
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

// ---------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------

export async function probeNodeVersion(nodeHome: string): Promise<{ version?: string }> {
  try {
    const nodeBin = path.join(
      nodeHome,
      process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'),
    );
    const out = await runCommand(nodeBin, ['--version'], 2000);
    if (!out) return {};
    const v = parseNodeVersion(out);
    return v ? { version: v } : {};
  } catch (e) {
    log.debug(`probeNodeVersion(${nodeHome}) failed: ${(e as Error).message}`);
    return {};
  }
}

// Parses `v20.10.0` (with optional trailing whitespace) into "20.10.0".
// Returns undefined for non-version content.
export function parseNodeVersion(text: string): string | undefined {
  const m = text.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return m ? m[1] : undefined;
}
