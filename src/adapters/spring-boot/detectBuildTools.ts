import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

// Returns a list of Gradle and Maven install directories (each contains
// `bin/gradle` / `bin/mvn` or the Windows .bat / .cmd variants).
// Mirrors the JDK / Tomcat detectors:
//   - Real fs (not vscode.workspace.fs) so `realpath` works for shims.
//   - which / where to follow PATH-resolved symlinks.
//   - sdkman / asdf / brew / scoop / our own install dir / wrapper cache.
//   - Linux distro paths and Windows fixed paths.
//   - Symlink dedupe by realpath so a shim and its target collapse to one
//     entry.
export interface BuildToolDetection {
  gradleInstalls: string[];
  mavenInstalls: string[];
}

export async function detectBuildTools(): Promise<BuildToolDetection> {
  const gradle: string[] = [];
  const maven: string[] = [];

  // 1. Env vars first — when set, that's typically the install the user
  // actively prefers. We push it as-is; validation happens at dedupe.
  if (process.env.GRADLE_HOME) gradle.push(process.env.GRADLE_HOME);
  if (process.env.MAVEN_HOME) maven.push(process.env.MAVEN_HOME);
  if (process.env.M2_HOME) maven.push(process.env.M2_HOME);

  // 2. PATH lookup — resolves shims (sdkman, asdf, scoop) to the real
  // install root by walking <real>/bin/<tool> upward.
  for (const p of await whichTool('gradle')) gradle.push(p);
  for (const p of await whichTool('mvn')) maven.push(p);

  // 3. Version-manager directories (children of the candidate
  // distribution dirs). The `current` symlink lands here too — it gets
  // collapsed onto its target during the realpath dedupe.
  const home = os.homedir();
  for (const p of await listChildDirs(path.join(home, '.sdkman', 'candidates', 'gradle'))) gradle.push(p);
  for (const p of await listChildDirs(path.join(home, '.sdkman', 'candidates', 'maven'))) maven.push(p);
  for (const p of await listChildDirs(path.join(home, '.asdf', 'installs', 'gradle'))) gradle.push(p);
  for (const p of await listChildDirs(path.join(home, '.asdf', 'installs', 'maven'))) maven.push(p);

  // 4. Gradle wrapper cache. The wrapper downloads distros to
  // ~/.gradle/wrapper/dists/<distName>/<hash>/<inner>. Each `<inner>`
  // (typically `gradle-<version>`) is a real install. We surface them so
  // a project that's been built once already exposes its bundled Gradle
  // version without an explicit `apt install gradle` step.
  for (const p of await scanGradleWrapperDists(path.join(home, '.gradle', 'wrapper', 'dists'))) {
    gradle.push(p);
  }

  // 5. Our own install location — anything we put under ~/.rcm via the
  // download dialog should always show up.
  for (const p of await listChildDirs(path.join(rcmInstallDir(), 'gradles'))) gradle.push(p);
  for (const p of await listChildDirs(path.join(rcmInstallDir(), 'mavens'))) maven.push(p);

  // 6. Homebrew on macOS — both Apple Silicon (/opt/homebrew) and Intel
  // (/usr/local) prefixes. Brew installs `gradle` / `maven` under
  // <prefix>/opt/<formula>/libexec.
  if (process.platform === 'darwin') {
    for (const p of await scanBrewBuildTools('gradle')) gradle.push(p);
    for (const p of await scanBrewBuildTools('maven')) maven.push(p);
  }

  // 7. Linux distro paths.
  for (const p of await scanFixedRoots(['/opt/gradle', '/usr/share', '/usr/lib', '/snap'], /^(gradle[-_].*|gradle)$/i)) gradle.push(p);
  for (const p of await scanFixedRoots(['/opt/maven', '/opt', '/usr/share', '/usr/lib'], /^(apache-maven[-.]?\S*|maven\S*)$/i)) maven.push(p);

  // 8. Windows fixed paths + scoop / chocolatey.
  if (process.platform === 'win32') {
    for (const p of await scanFixedRoots(['C:\\Program Files\\Gradle', 'C:\\gradle'], /.*/)) gradle.push(p);
    for (const p of await scanFixedRoots(['C:\\Program Files\\Apache\\Maven', 'C:\\Program Files\\Apache', 'C:\\maven'], /.*/)) maven.push(p);
    // Scoop installs are content-addressed under %USERPROFILE%\scoop\apps\<tool>\current.
    const scoopApps = process.env.SCOOP
      ? path.join(process.env.SCOOP, 'apps')
      : path.join(home, 'scoop', 'apps');
    gradle.push(path.join(scoopApps, 'gradle', 'current'));
    maven.push(path.join(scoopApps, 'maven', 'current'));
    // Chocolatey lib dirs (e.g. C:\ProgramData\chocolatey\lib\gradle\tools\gradle-X.Y.Z).
    const choco = process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey';
    for (const p of await listChildDirs(path.join(choco, 'lib', 'gradle', 'tools'))) gradle.push(p);
    for (const p of await listChildDirs(path.join(choco, 'lib', 'maven', 'tools'))) maven.push(p);
  }

  // Validate + dedupe. Each candidate must have the expected binary;
  // realpath collapses symlinks. Surface the original path the user
  // would recognize.
  const out: BuildToolDetection = {
    gradleInstalls: await dedupeRealInstalls(gradle, gradleBinaryNames()),
    mavenInstalls: await dedupeRealInstalls(maven, mavenBinaryNames()),
  };
  log.debug(`detectBuildTools: gradle=${out.gradleInstalls.length}, maven=${out.mavenInstalls.length}`);
  return out;
}

// ---------------------------------------------------------------------------
// Detection sources
// ---------------------------------------------------------------------------

async function whichTool(tool: 'gradle' | 'mvn'): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await runCommand(cmd, [tool], 1500);
    if (!out) return [];
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const homes: string[] = [];
    for (const bin of lines) {
      let real: string;
      try { real = await fs.promises.realpath(bin); }
      catch { real = bin; }
      const home = installHomeFromBin(real);
      if (home) homes.push(home);
    }
    return homes;
  } catch (e) {
    log.debug(`whichTool(${tool}) failed: ${(e as Error).message}`);
    return [];
  }
}

async function scanBrewBuildTools(tool: 'gradle' | 'maven'): Promise<string[]> {
  const prefixes = ['/opt/homebrew/opt', '/usr/local/opt'];
  const out: string[] = [];
  for (const prefix of prefixes) {
    let entries;
    try { entries = await fs.promises.readdir(prefix, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const re = tool === 'gradle' ? /^gradle(?:@\d+)?$/i : /^maven(?:@\d+)?$/i;
      if (!re.test(e.name)) continue;
      out.push(path.join(prefix, e.name, 'libexec'));
    }
  }
  return out;
}

async function scanFixedRoots(roots: string[], nameFilter: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (!nameFilter.test(e.name)) continue;
      out.push(path.join(root, e.name));
    }
  }
  return out;
}

// Walks the wrapper cache layout: `<dists>/<distName>/<hash>/<inner>`.
// `<inner>` is typically `gradle-<version>` and is the real install
// root we want. Multiple `<distName>` per project, multiple hashes
// per distro — we surface every leaf install we find.
async function scanGradleWrapperDists(distsRoot: string): Promise<string[]> {
  const out: string[] = [];
  let distDirs: string[];
  try { distDirs = await fs.promises.readdir(distsRoot); } catch { return out; }
  for (const dist of distDirs) {
    const distPath = path.join(distsRoot, dist);
    let hashes: string[];
    try { hashes = await fs.promises.readdir(distPath); } catch { continue; }
    for (const hash of hashes) {
      const hashPath = path.join(distPath, hash);
      let inners: string[];
      try { inners = await fs.promises.readdir(hashPath); } catch { continue; }
      for (const inner of inners) {
        // Only `gradle-<version>` directories — skip lock files (`.ok`,
        // `.lck`) and other artefacts the wrapper drops alongside the
        // extracted distro.
        if (!/^gradle-\d/.test(inner)) continue;
        out.push(path.join(hashPath, inner));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation + dedupe
// ---------------------------------------------------------------------------

function gradleBinaryNames(): string[] {
  return process.platform === 'win32'
    ? ['bin/gradle.bat', 'bin/gradle']
    : ['bin/gradle'];
}
function mavenBinaryNames(): string[] {
  return process.platform === 'win32'
    ? ['bin/mvn.cmd', 'bin/mvn.bat', 'bin/mvn']
    : ['bin/mvn'];
}

async function dedupeRealInstalls(paths: string[], binaryNames: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    let foundBin: string | null = null;
    for (const rel of binaryNames) {
      try {
        const stat = await fs.promises.stat(path.join(p, rel));
        if (stat.isFile()) { foundBin = rel; break; }
      } catch { /* try next */ }
    }
    if (!foundBin) continue;
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
// Helpers
// ---------------------------------------------------------------------------

function installHomeFromBin(bin: string): string | null {
  // .../<home>/bin/<tool> → .../<home>
  const binDir = path.dirname(bin);
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

// Mirrors archiveInstall.userInstallRoot — duplicated locally so the
// detect path stays free of installer dependencies.
function rcmInstallDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'rcm');
  }
  return path.join(os.homedir(), '.rcm');
}

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
