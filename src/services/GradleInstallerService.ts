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

// Gradle installer using the official `services.gradle.org/versions/all`
// JSON endpoint. That's the same API the Gradle wrapper itself uses, so
// it's authoritative and stable.
//
// Each entry carries:
//   - version
//   - downloadUrl    (zip, all platforms)
//   - checksumUrl    (sha256 of the zip)
//   - rcFor / milestoneFor (set when the release is a pre-release)
//   - nightly        (true for nightly builds)
//   - current        (the latest GA — used to highlight the default)
//
// We filter to GA-only by default (no RC, milestone, nightly) so the
// dropdown stays sane.

const GRADLE_VERSIONS_URL = 'https://services.gradle.org/versions/all';

export interface GradleVersion {
  version: string;
  downloadUrl: string;
  checksumUrl: string;
  // True when the version is a published GA (no RC / milestone /
  // nightly markers).
  isGa: boolean;
  // True when this is the most-recent GA according to services.gradle.org.
  current: boolean;
}

export interface GradleProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  fraction: number | null;
  detail?: string;
}

export interface GradleInstallResult {
  // Absolute path that contains bin/gradle — value to drop into
  // typeOptions.gradlePath on the form.
  gradleHome: string;
  version: string;
}

export class GradleInstallerService {
  private active: { abort: () => void } | undefined;
  private cache: GradleVersion[] | null = null;

  getInstallRoot(): string {
    return userInstallRoot('gradles');
  }

  async listVersions(): Promise<GradleVersion[]> {
    if (this.cache) return this.cache;
    log.debug(`Gradle versions: ${GRADLE_VERSIONS_URL}`);
    const raw = await httpGetJson<RawVersion[]>(GRADLE_VERSIONS_URL);
    const list = parseGradleVersions(raw);
    this.cache = list;
    log.info(`Gradle: ${list.length} GA version(s) available`);
    return list;
  }

  async install(
    version: GradleVersion,
    onProgress: (p: GradleProgress) => void,
  ): Promise<GradleInstallResult> {
    if (this.active) throw new Error('Another Gradle install is already running.');

    const installRoot = this.getInstallRoot();
    await fs.promises.mkdir(installRoot, { recursive: true });

    const dirName = `gradle-${version.version}`;
    const targetDir = path.join(installRoot, dirName);
    if (await pathExists(targetDir)) {
      log.info(`Gradle already installed at ${targetDir}`);
      return { gradleHome: targetDir, version: version.version };
    }

    const archivePath = path.join(installRoot, `${dirName}.zip`);
    const cancellation = makeCancellation();
    this.active = { abort: cancellation.abort };
    let cleanupArchive = true;
    try {
      log.info(`Gradle: fetching expected SHA-256 from ${version.checksumUrl}`);
      const expectedSha = await fetchExpectedSha(version.checksumUrl);
      if (!expectedSha) {
        throw new Error(`services.gradle.org did not return a SHA-256 for ${version.version} — refusing to install unverified.`);
      }

      const sizeOnDisk = await fileSize(archivePath);
      if (sizeOnDisk !== null && sizeOnDisk > 0) {
        log.info(`Gradle: reusing ${archivePath} (${humanSize(sizeOnDisk, sizeOnDisk)})`);
        onProgress({ state: 'downloading', fraction: 1, detail: humanSize(sizeOnDisk, sizeOnDisk) });
      } else {
        log.info(`Gradle download: ${version.downloadUrl} → ${archivePath}`);
        onProgress({ state: 'downloading', fraction: 0, detail: humanSize(0, 0) });
        await downloadFile(version.downloadUrl, archivePath, 0, (loaded, total) => {
          const fraction = total > 0 ? Math.min(1, loaded / total) : null;
          onProgress({ state: 'downloading', fraction, detail: humanSize(loaded, total) });
        }, cancellation.signal);
      }

      onProgress({ state: 'verifying', fraction: null });
      const actual = await hashOfFile(archivePath, 'sha256');
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new Error(`Checksum mismatch — expected ${expectedSha}, got ${actual}. Archive deleted.`);
      }

      onProgress({ state: 'extracting', fraction: null });
      // Gradle ships only zip downloads (cross-platform).
      await extractArchive(archivePath, targetDir, 'zip', cancellation.signal);
      // Archive layout: gradle-X.Y.Z/...; flatten one level.
      await flattenSingleNestedDir(targetDir);

      const gradleHome = await locateGradleHome(targetDir);
      if (!gradleHome) {
        throw new Error('Extracted archive did not contain bin/gradle — install aborted.');
      }
      log.info(`Gradle installed: ${gradleHome}`);
      return { gradleHome, version: version.version };
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
    log.info('Gradle install: cancellation requested');
    this.active.abort();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Shape of one entry in services.gradle.org/versions/all. Only the
// fields we read are documented here; the API returns more (broken,
// activeRc, milestoneFor, snapshot) but we don't need them.
interface RawVersion {
  version: string;
  downloadUrl: string;
  checksumUrl: string;
  rcFor: string;
  milestoneFor: string;
  nightly: boolean;
  snapshot: boolean;
  current: boolean;
  broken: boolean;
}

// Filter to GA-only entries and order newest-first. The endpoint already
// orders newest-first, but we re-sort by parsed semver to be defensive
// (and correct for the rare GA backport case).
export function parseGradleVersions(raw: unknown): GradleVersion[] {
  if (!Array.isArray(raw)) return [];
  const out: GradleVersion[] = [];
  for (const entry of raw as RawVersion[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.broken) continue;
    if (entry.nightly || entry.snapshot) continue;
    if (entry.rcFor) continue;
    if (entry.milestoneFor) continue;
    if (typeof entry.version !== 'string') continue;
    if (typeof entry.downloadUrl !== 'string' || !entry.downloadUrl) continue;
    if (typeof entry.checksumUrl !== 'string' || !entry.checksumUrl) continue;
    out.push({
      version: entry.version,
      downloadUrl: entry.downloadUrl,
      checksumUrl: entry.checksumUrl,
      isGa: true,
      current: entry.current === true,
    });
  }
  out.sort((a, b) => compareVersions(b.version, a.version));
  return out;
}

async function fetchExpectedSha(url: string): Promise<string | null> {
  try {
    const text = await httpGetText(url);
    // services.gradle.org returns a 64-char hex digest, no surrounding
    // text. parseGradleSha is forgiving in case the format ever changes.
    return parseGradleSha(text);
  } catch (e) {
    log.warn(`Gradle SHA-256 fetch failed: ${(e as Error).message}`);
    return null;
  }
}

export function parseGradleSha(text: string): string | null {
  const m = text.match(/[a-fA-F0-9]{64}/);
  return m ? m[0].toLowerCase() : null;
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

async function locateGradleHome(root: string): Promise<string | null> {
  const candidates: string[] = [root];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) candidates.push(path.join(root, e.name));
    }
  } catch { /* not a dir */ }
  for (const c of candidates) {
    const sh = path.join(c, 'bin', 'gradle');
    const bat = path.join(c, 'bin', 'gradle.bat');
    try {
      const a = await fs.promises.stat(sh).catch(() => null);
      const b = await fs.promises.stat(bat).catch(() => null);
      if (a?.isFile() || b?.isFile()) return c;
    } catch { /* skip */ }
  }
  return null;
}

export { CancelledError };
