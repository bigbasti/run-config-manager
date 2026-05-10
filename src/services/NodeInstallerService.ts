import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import {
  CancelledError,
  makeCancellation,
  httpGetJson,
  httpGetText,
  downloadFile,
  hashOfFile,
  extractArchive,
  flattenSingleNestedDir,
  fileSize,
  pathExists,
  userInstallRoot,
  humanSize,
} from './archiveInstall';

// Node installer using nodejs.org's official `dist/index.json` listing —
// the same data Node's own version managers consume. Each entry is
// keyed by version and lists the platforms it ships for; we synthesize
// the per-platform asset URLs from that.
//
// The dropdown shows GA-only entries (no `-rc`, `-nightly`, `-test`)
// sorted newest-first. LTS lines are flagged so the picker can
// surface them visibly.

const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';

export interface NodeVersion {
  version: string;       // e.g. "v20.10.0"
  downloadUrl: string;
  checksumUrl: string;
  filename: string;      // archive filename — used to match in SHASUMS256
  isLts: boolean;
  // True for the latest LTS in this listing.
  currentLts: boolean;
  // True for the most recent GA in this listing (highlighted as default).
  current: boolean;
}

export interface NodeProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  fraction: number | null;
  detail?: string;
}

export interface NodeInstallResult {
  // Absolute path to the install root — the directory containing
  // bin/node (POSIX) or node.exe (Windows).
  nodeHome: string;
  version: string;
}

// Raw shape of a row in nodejs.org's index.json. `lts` is either a
// string codename (e.g. "Hydrogen", "Iron") for LTS lines or `false`
// for non-LTS releases.
interface RawNodeRelease {
  version: string;
  date: string;
  files: string[];
  lts: string | false;
}

export class NodeInstallerService {
  private active: { abort: () => void } | undefined;

  getInstallRoot(): string {
    return userInstallRoot('nodes');
  }

  async listVersions(): Promise<NodeVersion[]> {
    log.debug(`NodeInstallerService.listVersions: GET ${NODE_INDEX_URL}`);
    const raw = await httpGetJson<RawNodeRelease[]>(NODE_INDEX_URL);
    const releases = parseNodeReleases(raw);
    log.debug(`NodeInstallerService.listVersions: ${releases.length} GA release(s)`);
    return releases.map(r => {
      const asset = pickNodeAsset(r.version, process.platform, process.arch);
      return {
        version: r.version,
        downloadUrl: asset.url,
        checksumUrl: `https://nodejs.org/dist/${r.version}/SHASUMS256.txt`,
        filename: asset.filename,
        isLts: r.isLts,
        currentLts: r.currentLts,
        current: r.current,
      };
    });
  }

  async install(
    v: NodeVersion,
    onProgress: (p: NodeProgress) => void,
  ): Promise<NodeInstallResult> {
    if (this.active) throw new Error('Another Node install is already running.');

    const root = this.getInstallRoot();
    await fs.promises.mkdir(root, { recursive: true });

    // Final install dir is the archive root after extraction —
    // node-v<version>-<platform>-<arch>.
    const installDir = path.join(root, v.filename.replace(/\.(tar\.xz|tar\.gz|zip)$/i, ''));

    if (await pathExists(installDir)) {
      log.info(`Node ${v.version} already installed at ${installDir} — reusing`);
      return { nodeHome: installDir, version: v.version };
    }

    const tmp = path.join(root, '.download', v.filename);
    await fs.promises.mkdir(path.dirname(tmp), { recursive: true });

    const cancellation = makeCancellation();
    this.active = { abort: cancellation.abort };
    try {
      onProgress({ state: 'downloading', fraction: 0, detail: humanSize(0, 0) });
      await downloadFile(v.downloadUrl, tmp, 0, (loaded, total) => {
        const fraction = total > 0 ? Math.min(1, loaded / total) : null;
        onProgress({ state: 'downloading', fraction, detail: humanSize(loaded, total) });
      }, cancellation.signal);

      onProgress({ state: 'verifying', fraction: null });
      const sha = parseNodeShasum(
        await httpGetText(v.checksumUrl),
        v.filename,
      );
      if (!sha) throw new Error(`Could not find checksum for ${v.filename} in SHASUMS256.txt`);
      const actual = await hashOfFile(tmp, 'sha256');
      if (actual.toLowerCase() !== sha.toLowerCase()) {
        try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        throw new Error(`Checksum mismatch for ${v.filename}: expected ${sha}, got ${actual}`);
      }
      const dlSize = await fileSize(tmp) ?? 0;
      log.debug(`Node ${v.version}: checksum OK (${humanSize(dlSize, dlSize)})`);

      onProgress({ state: 'extracting', fraction: null });
      const archiveType: 'tar.gz' | 'zip' = v.filename.endsWith('.zip') ? 'zip' : 'tar.gz';
      await extractArchive(tmp, installDir, archiveType, cancellation.signal);
      await flattenSingleNestedDir(installDir);
      try { await fs.promises.unlink(tmp); } catch { /* ignore */ }

      const nodeBin = path.join(
        installDir,
        process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'),
      );
      if (!(await pathExists(nodeBin))) {
        // Tried to extract but the expected node binary isn't where we
        // expected. Most often this is an unfamiliar archive layout
        // we couldn't flatten; clean up and surface a clear failure.
        try { await fs.promises.rm(installDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(`Extracted archive doesn't contain a usable Node binary at ${nodeBin}`);
      }

      log.info(`Node ${v.version} installed at ${installDir}`);
      return { nodeHome: installDir, version: v.version };
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
      await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this.active = undefined;
    }
  }

  cancel(): void {
    if (!this.active) return;
    log.info('Node install: cancellation requested');
    this.active.abort();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

const GA_RE = /^v\d+\.\d+\.\d+$/;

export function parseNodeReleases(raw: unknown): Array<{
  version: string;
  isLts: boolean;
  currentLts: boolean;
  current: boolean;
}> {
  if (!Array.isArray(raw)) return [];
  const ga = raw.filter((r: any) => typeof r?.version === 'string' && GA_RE.test(r.version));
  // Already roughly newest-first in the nodejs.org listing, but sort
  // explicitly to be safe.
  ga.sort((a: any, b: any) => compareSemver(b.version, a.version));
  let currentMarked = false;
  let currentLtsMarked = false;
  return ga.map((r: any) => {
    const isLts = typeof r.lts === 'string' && r.lts.length > 0;
    const current = !currentMarked;
    if (current) currentMarked = true;
    const currentLts = isLts && !currentLtsMarked;
    if (currentLts) currentLtsMarked = true;
    return { version: r.version, isLts, currentLts, current };
  });
}

export function pickNodeAsset(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): { filename: string; url: string } {
  // Map (platform, arch) → (folderTag, archiveExt).
  // Source: nodejs.org/dist/<v>/ filenames.
  let folder: string;
  let ext: string;
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64' || arch === 'armv7l')) {
    folder = `linux-${arch}`;
    ext = 'tar.gz';
  } else if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    folder = `darwin-${arch}`;
    ext = 'tar.gz';
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    folder = `win-${arch}`;
    ext = 'zip';
  } else {
    throw new Error(`Unsupported platform/arch for Node download: ${platform}/${arch}`);
  }
  const filename = `node-${version}-${folder}.${ext}`;
  return { filename, url: `https://nodejs.org/dist/${version}/${filename}` };
}

export function parseNodeShasum(text: string, filename: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+(.+)$/);
    if (m && m[2] === filename) return m[1];
  }
  return null;
}

// Loose semver compare adequate for nodejs.org's GA versions
// ("v20.10.0" vs "v18.19.1"). Returns negative when a < b.
function compareSemver(a: string, b: string): number {
  const ax = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  const bx = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const av = ax[i] ?? 0, bv = bx[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export { CancelledError };
