import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { log } from '../utils/logger';

// Reusable building blocks for "fetch an archive over HTTPS, verify it,
// extract it under the user's home, and report progress as we go".
// Originally lived inside JdkInstallerService; pulled out for the Tomcat
// installer (and eventually anything else we want to bootstrap on the
// user's machine — Maven? Gradle?).
//
// Stays low-level on purpose: the caller decides on URL, target name,
// hash type, and the cancellation handling. We only deal in bytes/files.

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export interface CancellationSignal {
  readonly aborted: boolean;
  onAbort(cb: () => void): void;
}

export interface Cancellation {
  signal: CancellationSignal;
  abort: () => void;
}

export class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

export function makeCancellation(): Cancellation {
  let aborted = false;
  const callbacks: Array<() => void> = [];
  return {
    signal: {
      get aborted() { return aborted; },
      onAbort(cb) {
        if (aborted) cb();
        else callbacks.push(cb);
      },
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const cb of callbacks) try { cb(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const USER_AGENT = 'run-config-manager-vscode/1.0';

export function httpGet(
  url: string,
  onResponse: (res: import('http').IncomingMessage) => void,
  onError: (err: Error) => void,
): void {
  const req = https.request(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT } }, onResponse);
  req.on('error', onError);
  req.end();
}

// Follows up to `maxRedirects` 30x responses. Used for both directory
// listings and binary downloads; servers occasionally redirect to
// regional mirrors.
export function httpGetWithRedirects(
  url: string,
  onResponse: (res: import('http').IncomingMessage) => void,
  onError: (err: Error) => void,
  maxRedirects = 5,
): void {
  httpGet(url, res => {
    if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308)
        && res.headers.location && maxRedirects > 0) {
      const next = new URL(res.headers.location, url).toString();
      res.resume();
      httpGetWithRedirects(next, onResponse, onError, maxRedirects - 1);
      return;
    }
    onResponse(res);
  }, onError);
}

export function httpGetText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    httpGetWithRedirects(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }, reject);
  });
}

export function httpGetJson<T = unknown>(url: string): Promise<T> {
  return httpGetText(url).then(body => {
    try { return JSON.parse(body) as T; }
    catch (e) { throw new Error(`Could not parse JSON from ${url}: ${(e as Error).message}`); }
  });
}

// ---------------------------------------------------------------------------
// Download with progress + cancel
// ---------------------------------------------------------------------------

// Streams `url` to `destPath` while reporting progress. `expected` is used
// when the response omits Content-Length (some Apache mirrors do for
// older releases). On cancellation the partial file is removed.
export function downloadFile(
  url: string,
  destPath: string,
  expected: number,
  onProgress: (loaded: number, total: number) => void,
  signal: CancellationSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let aborted = false;
    let req: import('http').ClientRequest | undefined;
    const cleanupAndReject = (e: Error) => {
      try { file.close(); } catch { /* ignore */ }
      fs.promises.rm(destPath, { force: true }).catch(() => {}).finally(() => reject(e));
    };
    signal.onAbort(() => {
      aborted = true;
      try { req?.destroy(new CancelledError()); } catch { /* ignore */ }
      cleanupAndReject(new CancelledError());
    });
    httpGetWithRedirects(url, res => {
      if (res.statusCode !== 200) {
        cleanupAndReject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const total = Number(res.headers['content-length']) || expected || 0;
      let loaded = 0;
      res.on('data', chunk => {
        loaded += chunk.length;
        onProgress(loaded, total);
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(err => err ? cleanupAndReject(err) : resolve());
      });
      file.on('error', cleanupAndReject);
      res.on('error', cleanupAndReject);
    }, e => { if (!aborted) cleanupAndReject(e); });
  });
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export type HashAlgorithm = 'sha256' | 'sha512';

export function hashOfFile(filePath: string, algorithm: HashAlgorithm): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Shells out to platform tar/unzip. `tar -xzf` is universal on macOS and
// Linux; Windows 10+ ships tar too. PowerShell Expand-Archive is the
// fallback for older Windows .zip handling.
export async function extractArchive(
  archivePath: string,
  targetDir: string,
  archiveType: 'tar.gz' | 'zip',
  signal: CancellationSignal,
): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  if (archiveType === 'tar.gz') {
    await runTool('tar', ['-xzf', archivePath, '-C', targetDir], signal);
    return;
  }
  if (process.platform === 'win32') {
    try {
      await runTool('tar', ['-xf', archivePath, '-C', targetDir], signal);
      return;
    } catch (_e) {
      await runTool('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`,
      ], signal);
      return;
    }
  }
  try {
    await runTool('unzip', ['-q', '-o', archivePath, '-d', targetDir], signal);
  } catch {
    await runTool('tar', ['-xf', archivePath, '-C', targetDir], signal);
  }
}

function runTool(cmd: string, args: string[], signal: CancellationSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    signal.onAbort(() => { try { child.kill(); } catch { /* ignore */ } });
    let stderr = '';
    child.stderr.on('data', b => { stderr += b.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (signal.aborted) return reject(new CancelledError());
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

// If extraction produced exactly one nested directory under `targetDir`,
// hoist its contents up so `targetDir` itself becomes the install root.
// Used for both JDK archives (`jdk-21.0.2/...`) and Tomcat archives
// (`apache-tomcat-10.1.35/...`). macOS bundles (Contents/Home) are
// preserved — generic detection via `bundleProbe` lets the caller
// say "stop flattening when you see this child".
export async function flattenSingleNestedDir(
  targetDir: string,
  options: { skipIfChildHas?: string[] } = {},
): Promise<void> {
  const skipIfChildHas = options.skipIfChildHas ?? [];
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  // If the layout already looks flattened (top-level bin/, lib/, etc.) we
  // bail. We just check for any non-Contents directory at root — caller
  // can pass `skipIfChildHas` to force a stop on a specific bundle layout.
  const dirs = entries.filter(e => e.isDirectory());
  const files = entries.filter(e => e.isFile());
  if (dirs.length !== 1 || files.length > 0) return;

  const inner = path.join(targetDir, dirs[0].name);
  if (skipIfChildHas.length) {
    try {
      const innerEntries = await fs.promises.readdir(inner, { withFileTypes: true });
      const innerNames = new Set(innerEntries.map(e => e.name));
      for (const skip of skipIfChildHas) if (innerNames.has(skip)) return;
    } catch { return; }
  }

  const childNames = await fs.promises.readdir(inner);
  for (const name of childNames) {
    await fs.promises.rename(path.join(inner, name), path.join(targetDir, name));
  }
  await fs.promises.rmdir(inner);
  log.debug(`flattened nested dir: ${inner} → ${targetDir}`);
}

// ---------------------------------------------------------------------------
// Misc filesystem helpers
// ---------------------------------------------------------------------------

export async function fileSize(p: string): Promise<number | null> {
  try {
    const s = await fs.promises.stat(p);
    return s.isFile() ? s.size : null;
  } catch { return null; }
}

export async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.stat(p); return true; }
  catch { return false; }
}

// Per-user install root for things like `~/.rcm/<kind>/`. On Windows we
// use %LOCALAPPDATA% so the install lands in the no-elevation user-data
// area rather than a roaming profile.
export function userInstallRoot(kind: 'jdks' | 'tomcats'): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'rcm', kind);
  }
  return path.join(os.homedir(), '.rcm', kind);
}

// ---------------------------------------------------------------------------
// Platform identifiers
// ---------------------------------------------------------------------------

export type PlatformOs = 'linux' | 'mac' | 'windows';
export function currentPlatform(): PlatformOs {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

export type PlatformArch = 'x64' | 'aarch64' | 'x86';
export function currentArch(): PlatformArch {
  switch (process.arch) {
    case 'arm64': return 'aarch64';
    case 'x64': return 'x64';
    case 'ia32': return 'x86';
    default: return 'x64';
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function humanSize(loaded: number, total: number): string {
  const fmt = (n: number) => {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  };
  return total > 0 ? `${fmt(loaded)} / ${fmt(total)}` : fmt(loaded);
}
