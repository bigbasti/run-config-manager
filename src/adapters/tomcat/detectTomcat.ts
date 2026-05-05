import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

// Locate Tomcat installations across every place the common install
// tools (sdkman, asdf, brew, snap, our own installer) might park them.
// Returns a deduped list of CATALINA_HOME directories — each contains
// bin/catalina.{sh,bat} and conf/server.xml.
//
// Detection sources, in priority order:
//   1. Env vars: CATALINA_HOME / TOMCAT_HOME (and the dirs they point at).
//   2. `which catalina.sh` / `where catalina.bat` — resolves shims.
//   3. Version managers: sdkman, asdf.
//   4. The extension's own install location (~/.rcm/tomcats/...).
//   5. Homebrew prefixes (Apple Silicon + Intel).
//   6. Linux distro paths (/usr/share, /var/lib, /usr/lib, /opt, /snap).
//   7. Windows fixed paths (Program Files Apache Software Foundation, …).
//   8. Per-user roots in $HOME (manual unzip into ~/apache-tomcat-…).
//
// Symlinks are resolved at the end so a shim and its resolved target
// don't both appear.
export async function detectTomcatInstalls(): Promise<string[]> {
  const found: string[] = [];

  // 1. Env vars first — if the user already configured one, that's the
  // most authoritative signal.
  if (process.env.CATALINA_HOME) found.push(process.env.CATALINA_HOME);
  if (process.env.TOMCAT_HOME) found.push(process.env.TOMCAT_HOME);

  // 2. PATH lookup. catalina.sh on Unix-likes; catalina.bat on Windows.
  for (const p of await whichCatalina()) found.push(p);

  // 3. Version-manager directories. Each contains
  // <root>/<distribution>/<install dir>; we list children of the
  // distribution dirs, plus the optional `current` symlink that sdkman
  // and asdf use to expose the active install.
  for (const p of await scanVersionManagerDirs()) found.push(p);

  // 4. Our own install location — anything we put in ~/.rcm/tomcats
  // should always show up regardless of platform.
  for (const p of await listChildDirs(path.join(rcmInstallDir(), 'tomcats'))) {
    found.push(p);
  }

  // 5. Homebrew on macOS — both Apple Silicon (/opt/homebrew) and Intel
  // (/usr/local) prefixes. brew installs `tomcat` and `tomcat@N`
  // formulae under <prefix>/opt/<formula>/libexec.
  if (process.platform === 'darwin') {
    for (const p of await scanBrewTomcats()) found.push(p);
  }

  // 6 + 7 + 8. Fixed roots across all platforms.
  for (const p of await scanFixedRoots()) found.push(p);

  // Validate each candidate is actually a Tomcat install (bin/catalina +
  // conf/server.xml) and dedupe by realpath. Symlinked entries (e.g.
  // /usr/local/bin/catalina.sh → /opt/homebrew/Cellar/tomcat/.../libexec)
  // collapse onto a single canonical path.
  const out = await dedupeRealTomcats(found);
  log.debug(`detectTomcatInstalls: found ${out.length} install(s)`);
  return out;
}

// ---------------------------------------------------------------------------
// Detection sources
// ---------------------------------------------------------------------------

async function whichCatalina(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const target = process.platform === 'win32' ? 'catalina.bat' : 'catalina.sh';
  try {
    const out = await runCommand(cmd, [target], 1500);
    if (!out) return [];
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const homes: string[] = [];
    for (const catalinaBin of lines) {
      // Resolve symlinks: sdkman/asdf shim → the real install. Walk up
      // <home>/bin/catalina.* to <home>.
      let real: string;
      try { real = await fs.promises.realpath(catalinaBin); }
      catch { real = catalinaBin; }
      const home = catalinaHomeFromBin(real);
      if (home) homes.push(home);
    }
    return homes;
  } catch (e) {
    log.debug(`whichCatalina failed: ${(e as Error).message}`);
    return [];
  }
}

async function scanVersionManagerDirs(): Promise<string[]> {
  const home = os.homedir();
  // sdkman: ~/.sdkman/candidates/tomcat/<version>  (and ./current → version)
  // asdf:   ~/.asdf/installs/tomcat/<version>
  const containers = [
    path.join(home, '.sdkman', 'candidates', 'tomcat'),
    path.join(home, '.asdf', 'installs', 'tomcat'),
  ];
  const out: string[] = [];
  for (const dir of containers) {
    for (const candidate of await listChildDirs(dir)) {
      out.push(candidate);
    }
  }
  return out;
}

async function scanBrewTomcats(): Promise<string[]> {
  // Homebrew arranges Tomcat as <prefix>/opt/<formula>/libexec/ where
  // <formula> is `tomcat` or `tomcat@<N>` (versioned formulae for older
  // majors stay around even after the unversioned formula moves on).
  // We probe both prefixes and every formula matching the pattern.
  const prefixes = ['/opt/homebrew/opt', '/usr/local/opt'];
  const out: string[] = [];
  for (const prefix of prefixes) {
    let entries;
    try { entries = await fs.promises.readdir(prefix, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (!/^tomcat(?:@\d+)?$/i.test(e.name)) continue;
      // Brew installs the actual files under libexec — that's the
      // CATALINA_HOME shape.
      out.push(path.join(prefix, e.name, 'libexec'));
    }
  }
  return out;
}

async function scanFixedRoots(): Promise<string[]> {
  const home = os.homedir();
  // Each entry is a directory whose children we scan for tomcat installs.
  const roots: string[] = [
    '/opt',
    '/usr/share',
    '/usr/lib',
    '/var/lib',
    '/snap',                                        // snap classic confined
    'C:\\Program Files\\Apache Software Foundation',
    'C:\\Program Files (x86)\\Apache Software Foundation',
    'C:\\apache-tomcat',
    home,                                           // ~/apache-tomcat-X.Y.Z
  ];

  const out: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      // Don't probe random homedir contents — match on the name first to
      // avoid statting hundreds of unrelated dirs.
      if (!/tomcat/i.test(e.name)) continue;
      out.push(path.join(root, e.name));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation + dedupe
// ---------------------------------------------------------------------------

async function dedupeRealTomcats(paths: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    if (!(await looksLikeTomcat(p))) continue;
    let real: string;
    try { real = await fs.promises.realpath(p); }
    catch { real = p; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    // Surface the original path (prettier for jenv-style or homebrew
    // symlinked entries the user would recognize).
    out.push(p);
  }
  return out;
}

async function looksLikeTomcat(dir: string): Promise<boolean> {
  // Minimum signal: conf/server.xml plus one of bin/catalina.{sh,bat}.
  // We use the real fs (not vscode.workspace.fs) for parity with the JDK
  // detector — that switch let us pick up jenv-style installs reliably.
  const serverXml = path.join(dir, 'conf', 'server.xml');
  try {
    const s = await fs.promises.stat(serverXml);
    if (!s.isFile()) return false;
  } catch { return false; }
  for (const bin of [path.join(dir, 'bin', 'catalina.sh'), path.join(dir, 'bin', 'catalina.bat')]) {
    try {
      const s = await fs.promises.stat(bin);
      if (s.isFile()) return true;
    } catch { /* try next */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catalinaHomeFromBin(catalinaBin: string): string | null {
  // .../<home>/bin/catalina.{sh,bat} → .../<home>
  const binDir = path.dirname(catalinaBin);
  if (path.basename(binDir).toLowerCase() !== 'bin') return null;
  return path.dirname(binDir);
}

async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Mirrors archiveInstall.userInstallRoot — duplicated here on purpose so
// the detect path doesn't pull the installer module into its dependency
// graph (kept lean for snappy form-open).
function rcmInstallDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'rcm');
  }
  return path.join(os.homedir(), '.rcm');
}

// Spawn-and-collect with a timeout. Returns stdout text or undefined on
// any failure / non-zero exit. Mirrors the helper in detectJdks; kept
// local to avoid a circular import via the installer module.
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
  });
}

// ----------------------------------------------------------------------------
// Artifact discovery (UNCHANGED — kept here so callers' single import still
// works. Scans the project for built WARs and exploded web apps.)
// ----------------------------------------------------------------------------

export interface ArtifactCandidate {
  path: string;                            // absolute path
  kind: 'war' | 'exploded';
  label: string;                           // short, for the dropdown
  mtime: number;                           // milliseconds since epoch for sort
}

export async function findTomcatArtifacts(projectRoot: vscode.Uri): Promise<ArtifactCandidate[]> {
  const out: ArtifactCandidate[] = [];

  const buildLibs = vscode.Uri.joinPath(projectRoot, 'build', 'libs');
  const buildExplodedWeb = vscode.Uri.joinPath(projectRoot, 'build', 'exploded');
  const mavenTarget = vscode.Uri.joinPath(projectRoot, 'target');

  await scanDir(buildLibs, out);
  await scanDir(buildExplodedWeb, out);
  await scanDir(mavenTarget, out);

  const seen = new Map<string, ArtifactCandidate>();
  for (const c of out) {
    const existing = seen.get(c.path);
    if (!existing || existing.kind === 'war' && c.kind === 'exploded') {
      seen.set(c.path, c);
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => (b.mtime - a.mtime) || a.label.localeCompare(b.label),
  );
}

async function scanDir(dir: vscode.Uri, out: ArtifactCandidate[]): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    const full = `${dir.fsPath}/${name}`;
    if (kind === vscode.FileType.File && name.endsWith('.war')) {
      const mtime = await statMtime(vscode.Uri.file(full));
      out.push({ path: full, kind: 'war', label: `${name} (war)`, mtime });
    } else if (kind === vscode.FileType.Directory) {
      try {
        const webInf = vscode.Uri.file(`${full}/WEB-INF`);
        await vscode.workspace.fs.stat(webInf);
        const mtime = await statMtime(webInf);
        out.push({ path: full, kind: 'exploded', label: `${name} (exploded)`, mtime });
      } catch { /* not a webapp dir */ }
    }
  }
}

async function statMtime(uri: vscode.Uri): Promise<number> {
  try {
    const s = await vscode.workspace.fs.stat(uri);
    return s.mtime;
  } catch {
    return 0;
  }
}
