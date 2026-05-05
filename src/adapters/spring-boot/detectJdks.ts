import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { log } from '../../utils/logger';

// Detected JDK installation: an absolute directory containing `bin/java`.
// `version` is filled in by a separate probe (release file → java -version)
// because spawning per-path is the slow part and we want detection to be
// streamable.
export interface JdkInfo {
  path: string;
  version?: string;
  // Distribution name (e.g. "Temurin", "OpenJDK", "Oracle"). Surfaced in
  // labels when present; not all detection paths can determine it.
  vendor?: string;
}

// Returns a list of JDK install directories. Each entry is guaranteed to
// have `bin/java` on disk. Versions are NOT populated here — call
// `probeJdkVersion(path)` separately, in parallel, for each entry.
//
// Detection sources, in priority order:
//   1. Java extension (redhat.java) — already curated by the user.
//   2. JAVA_HOME / JDK_HOME env vars.
//   3. `which java` / `where java` resolved to its physical home — picks up
//      jenv/asdf/sdkman shims by following symlinks to the real install.
//   4. macOS `/usr/libexec/java_home -V` — authoritative on macOS.
//   5. Windows registry HKLM\SOFTWARE\JavaSoft\JDK — covers installer paths
//      that don't land in Program Files\Java.
//   6. Version-manager directories: jenv, sdkman, asdf, Gradle toolchains.
//   7. Fixed filesystem roots across all platforms.
//
// Symlinks are resolved at the end so `~/.jenv/shims/java` and the real
// `~/.jenv/versions/21/bin/java` don't show up twice.
export async function detectJdks(): Promise<string[]> {
  const found: string[] = [];

  // 1. Java extension, if installed and active.
  try {
    const ext = vscode.extensions.getExtension('redhat.java');
    if (ext) {
      const api = ext.isActive ? await ext.activate() : await ext.activate();
      if (api) {
        if (Array.isArray((api as any).jdks)) {
          for (const j of (api as any).jdks) {
            if (j?.path) found.push(String(j.path));
          }
        } else if (typeof (api as any).getConfiguration === 'function') {
          const cfg = (api as any).getConfiguration();
          const runtimes = cfg?.get?.('java.configuration.runtimes') ?? [];
          for (const r of runtimes as any[]) {
            if (r?.path) found.push(String(r.path));
          }
        }
      }
    }
  } catch { /* ignore — fall through */ }

  // 2. Env vars.
  if (process.env.JAVA_HOME) found.push(process.env.JAVA_HOME);
  if (process.env.JDK_HOME) found.push(process.env.JDK_HOME);

  // 3. `which java` / `where java`. Use to resolve user shims (jenv, asdf,
  //    sdkman) — the binary the user would actually launch.
  for (const p of await whichJava()) found.push(p);

  // 4. macOS java_home -V.
  if (process.platform === 'darwin') {
    for (const p of await macJavaHome()) found.push(p);
  }

  // 5. Windows registry.
  if (process.platform === 'win32') {
    for (const p of await windowsRegistryJdks()) found.push(p);
  }

  // 6. Version-manager directories.
  for (const p of await scanVersionManagerDirs()) found.push(p);

  // 7. Fixed filesystem probes.
  for (const p of await scanFixedRoots()) found.push(p);

  // Validate each entry has bin/java, normalize, dedupe by realpath so
  // shims don't double up with their resolved targets.
  const out = await dedupeRealJdks(found);
  log.debug(`detectJdks: found ${out.length} unique JDK install(s)`);
  return out;
}

// ---------------------------------------------------------------------------
// Detection sources
// ---------------------------------------------------------------------------

async function whichJava(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await runCommand(cmd, ['java'], 1500);
    if (!out) return [];
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const homes: string[] = [];
    for (const javaBin of lines) {
      // Resolve symlinks: jenv shim → the actual JDK binary.
      let real: string;
      try { real = await fs.promises.realpath(javaBin); }
      catch { real = javaBin; }
      // Walk up from `bin/java` to the JDK home. macOS bundles add a
      // `Contents/Home` layer; we strip that too if we land on it.
      const home = jdkHomeFromBin(real);
      if (home) homes.push(home);
    }
    return homes;
  } catch (e) {
    log.debug(`whichJava failed: ${(e as Error).message}`);
    return [];
  }
}

async function macJavaHome(): Promise<string[]> {
  // /usr/libexec/java_home -V prints to stderr (oddly), one line per JDK
  // formatted like: "21, x86_64:\t\"OpenJDK 21\"\t/Library/.../Home"
  try {
    const out = await runCommand('/usr/libexec/java_home', ['-V'], 2000, /*captureStderr*/ true);
    if (!out) return [];
    const homes: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      // Path is the last whitespace-separated token on the line.
      const m = line.match(/(\/[^\t\n]*?Home)\s*$/);
      if (m) homes.push(m[1]);
    }
    return homes;
  } catch (e) {
    log.debug(`macJavaHome failed: ${(e as Error).message}`);
    return [];
  }
}

async function windowsRegistryJdks(): Promise<string[]> {
  // Enumerate every JavaSoft\JDK\<version> key, read its JavaHome value.
  // Covers Oracle, Adoptium, Microsoft Build of OpenJDK, and most
  // installers that register themselves.
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\JDK',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK',
  ];
  const homes: string[] = [];
  for (const key of keys) {
    try {
      const list = await runCommand('reg', ['query', key], 2000);
      if (!list) continue;
      const subkeys = list.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.startsWith('HKEY_LOCAL_MACHINE'))
        .filter(l => l !== key);
      for (const sub of subkeys) {
        try {
          const out = await runCommand('reg', ['query', sub, '/v', 'JavaHome'], 2000);
          if (!out) continue;
          const m = out.match(/JavaHome\s+REG_SZ\s+(.+)/i);
          if (m) homes.push(m[1].trim());
        } catch { /* skip this subkey */ }
      }
    } catch { /* root key doesn't exist — skip */ }
  }
  return homes;
}

async function scanVersionManagerDirs(): Promise<string[]> {
  const home = os.homedir();
  // Each entry is a directory whose immediate children are JDK homes.
  // jenv: ~/.jenv/versions/21
  // sdkman: ~/.sdkman/candidates/java/21.0.2-tem
  // asdf: ~/.asdf/installs/java/temurin-21.0.2
  // gradle toolchains: ~/.gradle/jdks/<digest>/<jdk-home>
  const containers = [
    path.join(home, '.jenv', 'versions'),
    path.join(home, '.sdkman', 'candidates', 'java'),
    path.join(home, '.asdf', 'installs', 'java'),
  ];

  const out: string[] = [];
  for (const dir of containers) {
    for (const candidate of await listChildDirs(dir)) {
      // Some asdf/sdkman layouts have an extra Contents/Home wrapping
      // (mac bundles unpacked). Try both the direct path and the bundle.
      const direct = candidate;
      const wrapped = path.join(candidate, 'Contents', 'Home');
      out.push(direct, wrapped);
    }
  }

  // Gradle toolchains: ~/.gradle/jdks/<digest>/<actual-jdk-home>
  // The digest is the immediate child; the JDK home is one level deeper.
  const gradleJdks = path.join(home, '.gradle', 'jdks');
  for (const digestDir of await listChildDirs(gradleJdks)) {
    for (const inner of await listChildDirs(digestDir)) {
      out.push(inner, path.join(inner, 'Contents', 'Home'));
    }
  }

  return out;
}

async function scanFixedRoots(): Promise<string[]> {
  const home = os.homedir();
  const roots: string[] = [
    '/usr/lib/jvm',
    '/opt',
    '/Library/Java/JavaVirtualMachines',
    path.join(home, 'Library', 'Java', 'JavaVirtualMachines'),
    '/opt/homebrew/opt',
    '/usr/local/opt',
    '/snap',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\Amazon Corretto',
  ];

  const out: string[] = [];
  for (const root of roots) {
    for (const candidate of await listChildDirs(root)) {
      // Direct child might be the JDK home; for macOS bundles it's nested
      // under Contents/Home.
      out.push(candidate, path.join(candidate, 'Contents', 'Home'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------

// Reads the JDK version for an install directory. Strategy:
//   1. Parse $home/release (a Java property file shipped by every JDK
//      since 9). Cheap, no spawn.
//   2. Fall back to spawning $home/bin/java -version, capping at 2s so a
//      stuck JDK (network-mounted, broken symlink) can't block detection.
// Returns undefined when both fail — the UI then just shows the path.
export async function probeJdkVersion(jdkHome: string): Promise<{ version?: string; vendor?: string }> {
  const fromRelease = await readReleaseFile(jdkHome);
  if (fromRelease.version) return fromRelease;

  // Fallback: spawn java -version. 2s is generous; a healthy JDK answers
  // in <100ms cold.
  try {
    const javaBin = path.join(jdkHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const out = await runCommand(javaBin, ['-version'], 2000, /*captureStderr*/ true);
    if (!out) return {};
    return parseJavaVersionStderr(out);
  } catch (e) {
    log.debug(`probeJdkVersion(${jdkHome}) failed: ${(e as Error).message}`);
    return {};
  }
}

// Parses the `release` property file shipped with every JDK ≥ 9. Lines
// look like: JAVA_VERSION="21.0.2", IMPLEMENTOR="Eclipse Adoptium".
export async function readReleaseFile(jdkHome: string): Promise<{ version?: string; vendor?: string }> {
  try {
    const text = await fs.promises.readFile(path.join(jdkHome, 'release'), 'utf8');
    const version = matchProp(text, 'JAVA_VERSION');
    const vendor = matchProp(text, 'IMPLEMENTOR');
    return {
      ...(version ? { version } : {}),
      ...(vendor ? { vendor } : {}),
    };
  } catch {
    return {};
  }
}

function matchProp(text: string, key: string): string | undefined {
  // Match KEY="value" or KEY=value (some older JDKs omit the quotes).
  const m = text.match(new RegExp(`^${key}=(?:"([^"]*)"|([^\\r\\n]*))`, 'm'));
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? '').trim() || undefined;
}

// Parses the stderr output of `java -version`, which looks like:
//   openjdk version "21.0.2" 2024-01-16
//   OpenJDK Runtime Environment Temurin-21.0.2+13 (build 21.0.2+13)
//   OpenJDK 64-Bit Server VM Temurin-21.0.2+13 (build 21.0.2+13, mixed mode)
export function parseJavaVersionStderr(stderr: string): { version?: string; vendor?: string } {
  const versionMatch = stderr.match(/version\s+"([^"]+)"/i);
  const version = versionMatch ? versionMatch[1] : undefined;
  // Try to read vendor — Temurin / Zulu / GraalVM / Corretto / Oracle.
  let vendor: string | undefined;
  const m = stderr.match(/(Temurin|Zulu|GraalVM|Corretto|Oracle|OpenJDK|Microsoft|Liberica|SapMachine)/i);
  if (m) vendor = m[1];
  return {
    ...(version ? { version } : {}),
    ...(vendor ? { vendor } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Walk upward from a `java` binary path to the JDK home (the directory
// that contains `bin/java`). On macOS, Apple bundles add a `Contents/Home`
// layer above bin/; we keep the home as the immediate parent of bin/.
function jdkHomeFromBin(javaBin: string): string | null {
  // .../jdk/bin/java → .../jdk
  const binDir = path.dirname(javaBin);
  if (path.basename(binDir).toLowerCase() !== 'bin') return null;
  return path.dirname(binDir);
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

async function dedupeRealJdks(paths: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    // Confirm it's a JDK home: must have bin/java (or java.exe on Windows).
    const javaBin = path.join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    let exists = false;
    try {
      const stat = await fs.promises.stat(javaBin);
      exists = stat.isFile();
    } catch { /* nope */ }
    if (!exists) continue;

    let real: string;
    try { real = await fs.promises.realpath(p); }
    catch { real = p; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    // Display the original path the user would recognize (e.g. the
    // ~/.jenv/versions/21 form rather than the resolved /private/var/...).
    out.push(p);
  }
  return out;
}

// Spawn-and-collect with a hard timeout. Returns the concatenated output
// (stdout by default, or stderr when captureStderr=true). Resolves to
// undefined on timeout / non-zero exit / spawn error so callers can chain
// fallbacks without try/catch noise.
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  captureStderr = false,
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

    const stream = captureStderr ? child.stderr : child.stdout;
    stream?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    // Some commands (java -version) write to stderr; some write to both.
    // When we capture stderr, also pump stdout into the buffer so we never
    // lose data the caller might want.
    if (captureStderr) {
      child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    }
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

// Re-exported execFile flavour for tests that want to stub child_process.
export const __testing = { execFile };
