import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import {
  CancelledError,
  makeCancellation,
  httpGetText,
  downloadFile,
  hashOfFile,
  extractArchive,
  flattenSingleNestedDir,
  fileSize,
  pathExists,
  userInstallRoot,
  currentPlatform,
  humanSize,
} from './archiveInstall';

// Apache Maven installer. Mirrors the Tomcat installer's data-driven
// approach: discovery scrapes Apache's directory listings, so when
// Maven 4 GA lands (or 5, eventually) it appears in the dropdown
// without any code change.
//
// Sources:
//   - https://archive.apache.org/dist/maven/                  (top-level)
//   - https://archive.apache.org/dist/maven/maven-N/          (versions)
//   - https://archive.apache.org/dist/maven/maven-N/X.Y.Z/binaries/<filename>
//
// Verification: every Apache binary ships with a `.sha512`. Mandatory.
// We use archive.apache.org rather than downloads.apache.org because the
// latter only carries currently-supported releases (so Maven 3.8.x
// disappears once 3.9.x is the line in maintenance), while archive.* is
// permanent — much friendlier for "I want exactly the version my CI
// uses".

const ARCHIVE_BASE = 'https://archive.apache.org/dist/maven';

export interface MavenMajor {
  // Number used in the URL path: maven-3, maven-4 (maven-1 / maven-2 are
  // EOL but still listed by the directory; we don't filter — users
  // pinning legacy CI builds may need them).
  major: number;
  label: string;
}

export interface MavenPackage {
  major: number;
  version: string;
  url: string;
  sha512Url: string;
  archiveType: 'tar.gz' | 'zip';
  filename: string;
  versionLabel: string;
}

export interface MavenProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  fraction: number | null;
  detail?: string;
}

export interface MavenInstallResult {
  // Absolute path that contains bin/mvn — the value to drop into
  // typeOptions.mavenPath on the form.
  mavenHome: string;
  version: string;
  major: number;
}

export class MavenInstallerService {
  private active: { abort: () => void } | undefined;
  private versionCache = new Map<number, MavenPackage[]>();

  getInstallRoot(): string {
    return userInstallRoot('mavens');
  }

  async listMajors(): Promise<MavenMajor[]> {
    log.debug(`Maven majors: ${ARCHIVE_BASE}/`);
    const html = await httpGetText(`${ARCHIVE_BASE}/`);
    const majors = parseMajorListing(html);
    log.info(`Maven majors: ${majors.map(m => m.major).join(', ')}`);
    return majors;
  }

  async listVersions(major: number): Promise<MavenPackage[]> {
    const cached = this.versionCache.get(major);
    if (cached) return cached;

    const url = `${ARCHIVE_BASE}/maven-${major}/`;
    log.debug(`Maven versions for ${major}: ${url}`);
    const html = await httpGetText(url);
    const versions = parseVersionListing(html);
    const archiveType: 'tar.gz' | 'zip' = currentPlatform() === 'windows' ? 'zip' : 'tar.gz';

    const packages: MavenPackage[] = versions.map(v => {
      const filename = `apache-maven-${v}-bin.${archiveType}`;
      const binUrl = `${ARCHIVE_BASE}/maven-${major}/${v}/binaries/${filename}`;
      return {
        major,
        version: v,
        url: binUrl,
        sha512Url: `${binUrl}.sha512`,
        archiveType,
        filename,
        versionLabel: v,
      };
    });
    packages.sort((a, b) => compareVersions(b.version, a.version));
    this.versionCache.set(major, packages);
    log.info(`Maven ${major}: ${packages.length} version(s) available`);
    return packages;
  }

  async install(
    pkg: MavenPackage,
    onProgress: (p: MavenProgress) => void,
  ): Promise<MavenInstallResult> {
    if (this.active) throw new Error('Another Maven install is already running.');

    const installRoot = this.getInstallRoot();
    await fs.promises.mkdir(installRoot, { recursive: true });

    const dirName = `apache-maven-${pkg.version}`;
    const targetDir = path.join(installRoot, dirName);
    if (await pathExists(targetDir)) {
      log.info(`Maven already installed at ${targetDir}`);
      return { mavenHome: targetDir, version: pkg.version, major: pkg.major };
    }

    const archivePath = path.join(installRoot, `${dirName}.${pkg.archiveType}`);
    const cancellation = makeCancellation();
    this.active = { abort: cancellation.abort };
    let cleanupArchive = true;
    try {
      log.info(`Maven: fetching expected SHA-512 from ${pkg.sha512Url}`);
      const expectedSha = await fetchExpectedSha(pkg.sha512Url);
      if (!expectedSha) {
        throw new Error(`Apache did not return a SHA-512 for ${pkg.filename} — refusing to install unverified.`);
      }

      const sizeOnDisk = await fileSize(archivePath);
      if (sizeOnDisk !== null && sizeOnDisk > 0) {
        log.info(`Maven: reusing ${archivePath} (${humanSize(sizeOnDisk, sizeOnDisk)})`);
        onProgress({ state: 'downloading', fraction: 1, detail: humanSize(sizeOnDisk, sizeOnDisk) });
      } else {
        log.info(`Maven download: ${pkg.url} → ${archivePath}`);
        onProgress({ state: 'downloading', fraction: 0, detail: humanSize(0, 0) });
        await downloadFile(pkg.url, archivePath, 0, (loaded, total) => {
          const fraction = total > 0 ? Math.min(1, loaded / total) : null;
          onProgress({ state: 'downloading', fraction, detail: humanSize(loaded, total) });
        }, cancellation.signal);
      }

      onProgress({ state: 'verifying', fraction: null });
      const actual = await hashOfFile(archivePath, 'sha512');
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new Error(`Checksum mismatch — expected ${expectedSha}, got ${actual}. Archive deleted.`);
      }

      onProgress({ state: 'extracting', fraction: null });
      await extractArchive(archivePath, targetDir, pkg.archiveType, cancellation.signal);
      // Apache archives extract into apache-maven-X.Y.Z/, flatten one
      // level so targetDir/bin/mvn is the canonical layout.
      await flattenSingleNestedDir(targetDir);

      const mavenHome = await locateMavenHome(targetDir);
      if (!mavenHome) {
        throw new Error('Extracted archive did not contain bin/mvn — install aborted.');
      }
      log.info(`Maven installed: ${mavenHome}`);
      return { mavenHome, version: pkg.version, major: pkg.major };
    } catch (e) {
      if (cleanupArchive) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      }
      await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this.active = undefined;
      if (cleanupArchive) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      }
    }
  }

  cancel(): void {
    if (!this.active) return;
    log.info('Maven install: cancellation requested');
    this.active.abort();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Apache's `dist/maven/` index lists `maven-1/`, `maven-2/`, `maven-3/`,
// `maven-4/`, plus various non-server projects (`enforcer/`, `wagon/`,
// etc.). We require the canonical `maven-<digits>/` form so siblings are
// filtered out.
export function parseMajorListing(html: string): MavenMajor[] {
  const seen = new Set<number>();
  const re = /href="maven-(\d+)\/"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) seen.add(n);
  }
  return Array.from(seen)
    .sort((a, b) => b - a)
    .map(major => ({ major, label: `Maven ${major}` }));
}

// Per-major listing has `<a href="X.Y.Z/">`. Strip pre-release versions
// (`alpha`, `beta`, `rc`) so the dropdown shows GA only — Maven 4's
// release line is in `4.0.0-beta-X` form at the time of writing.
export function parseVersionListing(html: string): string[] {
  const versions = new Set<string>();
  const re = /href="(\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+)?)\/"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = m[1];
    // Filter out pre-release tags. Case-insensitive — Apache uses both
    // `RC1` and `rc1` historically.
    if (/-(alpha|beta|rc|m\d+|preview)/i.test(v)) continue;
    versions.add(v);
  }
  return Array.from(versions);
}

export function parseShaFile(text: string): string | null {
  const m = text.match(/[a-fA-F0-9]{128}/);
  return m ? m[0].toLowerCase() : null;
}

async function fetchExpectedSha(url: string): Promise<string | null> {
  try {
    const text = await httpGetText(url);
    return parseShaFile(text);
  } catch (e) {
    log.warn(`Maven SHA-512 fetch failed: ${(e as Error).message}`);
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => /^\d+$/.test(n) ? parseInt(n, 10) : 0);
  const pb = b.split(/[.-]/).map(n => /^\d+$/.test(n) ? parseInt(n, 10) : 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function locateMavenHome(root: string): Promise<string | null> {
  const candidates: string[] = [root];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) candidates.push(path.join(root, e.name));
    }
  } catch { /* not a dir */ }
  for (const c of candidates) {
    const sh = path.join(c, 'bin', 'mvn');
    const cmd = path.join(c, 'bin', 'mvn.cmd');
    try {
      const a = await fs.promises.stat(sh).catch(() => null);
      const b = await fs.promises.stat(cmd).catch(() => null);
      if (a?.isFile() || b?.isFile()) return c;
    } catch { /* skip */ }
  }
  return null;
}

export { CancelledError };
