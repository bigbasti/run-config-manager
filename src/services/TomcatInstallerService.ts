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

// Apache Tomcat installer. Discovery is fully data-driven — we never
// hard-code major version numbers — so when Tomcat 12 lands on
// `https://downloads.apache.org/tomcat/` it shows up automatically.
//
// Sources:
//   - https://downloads.apache.org/tomcat/                  (current majors)
//   - https://downloads.apache.org/tomcat/tomcat-N/         (versions per major)
//   - https://downloads.apache.org/tomcat/tomcat-N/vX.Y.Z/  (the binary)
//
// Verification: every binary ships with a `.sha512` file alongside it.
// Mandatory — Apache always provides one, no missing-checksum prompt.
//
// Install location: `~/.rcm/tomcats/apache-tomcat-X.Y.Z/`. Per-user, no
// admin/sudo needed. Matches the JDK installer's pattern.

const APACHE_BASE = 'https://downloads.apache.org/tomcat';

export interface TomcatMajor {
  // The number used in the URL path: tomcat-9, tomcat-10, tomcat-11, …
  major: number;
  // Display label for the dropdown.
  label: string;
}

export interface TomcatPackage {
  major: number;
  // "10.1.35" — used in the URL and as the install directory suffix.
  version: string;
  // Download URL of the archive.
  url: string;
  // URL of the SHA-512 file alongside the archive.
  sha512Url: string;
  // tar.gz on Unix-like, zip on Windows.
  archiveType: 'tar.gz' | 'zip';
  // Filename Apache uses (apache-tomcat-10.1.35.tar.gz).
  filename: string;
  // Display label for the version dropdown.
  versionLabel: string;
}

export interface TomcatProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  fraction: number | null;
  detail?: string;
}

export interface TomcatInstallResult {
  // Absolute path that contains bin/catalina.sh — the value to drop into
  // tomcatHome on the form.
  tomcatHome: string;
  version: string;
  major: number;
}

export class TomcatInstallerService {
  private active: { abort: () => void } | undefined;
  // Cache the version listing per major so flipping the dropdown back
  // and forth doesn't re-hit Apache.
  private versionCache = new Map<number, TomcatPackage[]>();

  // Where freshly downloaded Tomcats land. Surfaced to the UI so the
  // dialog can show the install path before the user clicks.
  getInstallRoot(): string {
    return userInstallRoot('tomcats');
  }

  // Lists the currently-supported major lines by scraping the top-level
  // tomcat directory. Filters out non-server subprojects (tomcat-native,
  // tomcat-connectors, taglibs, …) by requiring the trailing digit.
  async listMajors(): Promise<TomcatMajor[]> {
    log.debug(`Tomcat majors: ${APACHE_BASE}/`);
    const html = await httpGetText(`${APACHE_BASE}/`);
    const majors = parseMajorListing(html);
    log.info(`Tomcat majors: ${majors.map(m => m.major).join(', ')}`);
    return majors;
  }

  // Lists released versions on a given major line. Filters out
  // pre-release and milestone tags so the dropdown only shows GA
  // releases.
  async listVersions(major: number): Promise<TomcatPackage[]> {
    const cached = this.versionCache.get(major);
    if (cached) return cached;

    const url = `${APACHE_BASE}/tomcat-${major}/`;
    log.debug(`Tomcat versions for ${major}: ${url}`);
    const html = await httpGetText(url);
    const versions = parseVersionListing(html);
    const archiveType: 'tar.gz' | 'zip' = currentPlatform() === 'windows' ? 'zip' : 'tar.gz';

    const packages: TomcatPackage[] = versions.map(v => {
      const filename = `apache-tomcat-${v}.${archiveType}`;
      const binUrl = `${APACHE_BASE}/tomcat-${major}/v${v}/bin/${filename}`;
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
    // Newest version first so the dropdown's default selection is the
    // current release on that line.
    packages.sort((a, b) => compareVersions(b.version, a.version));
    this.versionCache.set(major, packages);
    log.info(`Tomcat ${major}: ${packages.length} version(s) available`);
    return packages;
  }

  async install(
    pkg: TomcatPackage,
    onProgress: (p: TomcatProgress) => void,
  ): Promise<TomcatInstallResult> {
    if (this.active) throw new Error('Another Tomcat install is already running.');

    const installRoot = this.getInstallRoot();
    await fs.promises.mkdir(installRoot, { recursive: true });

    const dirName = `apache-tomcat-${pkg.version}`;
    const targetDir = path.join(installRoot, dirName);
    if (await pathExists(targetDir)) {
      // Already installed — short-circuit. We don't try to validate; the
      // user can delete the directory if they want a fresh copy.
      log.info(`Tomcat already installed at ${targetDir}`);
      return { tomcatHome: targetDir, version: pkg.version, major: pkg.major };
    }

    const archivePath = path.join(installRoot, `${dirName}.${pkg.archiveType}`);
    const cancellation = makeCancellation();
    this.active = { abort: cancellation.abort };
    let cleanupArchive = true;
    try {
      // Fetch the .sha512 first so we know the expected hash before we
      // commit to a long download. Cheap (a few hundred bytes).
      log.info(`Tomcat: fetching expected SHA-512 from ${pkg.sha512Url}`);
      const expectedSha = await fetchExpectedSha(pkg.sha512Url, pkg.filename);
      if (!expectedSha) {
        throw new Error(`Apache did not return a SHA-512 for ${pkg.filename} — refusing to install unverified.`);
      }

      // Reuse a previously-downloaded archive if it's the right size. The
      // hash check below catches corruption either way.
      const sizeOnDisk = await fileSize(archivePath);
      if (sizeOnDisk !== null && sizeOnDisk > 0) {
        log.info(`Tomcat: reusing ${archivePath} (${humanSize(sizeOnDisk, sizeOnDisk)})`);
        onProgress({ state: 'downloading', fraction: 1, detail: humanSize(sizeOnDisk, sizeOnDisk) });
      } else {
        log.info(`Tomcat download: ${pkg.url} → ${archivePath}`);
        onProgress({ state: 'downloading', fraction: 0, detail: humanSize(0, 0) });
        await downloadFile(pkg.url, archivePath, 0, (loaded, total) => {
          const fraction = total > 0 ? Math.min(1, loaded / total) : null;
          onProgress({ state: 'downloading', fraction, detail: humanSize(loaded, total) });
        }, cancellation.signal);
      }

      onProgress({ state: 'verifying', fraction: null });
      const actual = await hashOfFile(archivePath, 'sha512');
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new Error(
          `Checksum mismatch — expected ${expectedSha}, got ${actual}. Archive deleted.`,
        );
      }

      onProgress({ state: 'extracting', fraction: null });
      await extractArchive(archivePath, targetDir, pkg.archiveType, cancellation.signal);
      // Apache archives extract into apache-tomcat-X.Y.Z/, so the JDK-style
      // "single nested directory" flatten brings bin/catalina.sh up to
      // targetDir. Skip the flatten if we somehow already see bin/ at top
      // level (defensive).
      await flattenSingleNestedDir(targetDir);

      const tomcatHome = await locateTomcatHome(targetDir);
      if (!tomcatHome) {
        throw new Error('Extracted archive did not contain bin/catalina.sh — install aborted.');
      }
      log.info(`Tomcat installed: ${tomcatHome}`);
      return { tomcatHome, version: pkg.version, major: pkg.major };
    } catch (e) {
      // Clean up partial state on every failure path. We always wipe the
      // target dir; archive is wiped unless something downstream
      // explicitly asked us to keep it.
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
    log.info('Tomcat install: cancellation requested');
    this.active.abort();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Apache directory listings render as plain HTML tables. Each subdir is
// linked via `<a href="tomcat-N/">` (or `tomcat-N-something/` for the
// non-server subprojects). The trailing digit + slash is the
// distinguishing pattern for major lines.
export function parseMajorListing(html: string): TomcatMajor[] {
  // We deliberately only accept "tomcat-<digits>/" — that's the canonical
  // form for major-server lines. Subprojects (tomcat-native,
  // tomcat-connectors, taglibs) don't match.
  const seen = new Set<number>();
  const re = /href="tomcat-(\d+)\/"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) seen.add(n);
  }
  // Highest first — newest line at the top of the dropdown.
  return Array.from(seen)
    .sort((a, b) => b - a)
    .map(major => ({ major, label: `Tomcat ${major}` }));
}

// Per-major listing has `<a href="vX.Y.Z/">` for every release. We strip
// `-M\d+` / `-RC\d+` / `-alpha`/`-beta` style markers so the dropdown
// only shows GA releases.
export function parseVersionListing(html: string): string[] {
  const versions = new Set<string>();
  const re = /href="v([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+)?)\/"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = m[1];
    if (/-(?:M\d+|RC\d+|alpha|beta)/i.test(v)) continue;
    versions.add(v);
  }
  return Array.from(versions);
}

// SHA-512 file format: hex digest (sometimes whitespace-padded), often
// followed by a space and the filename. Take the first run of hex chars
// and normalize lowercase.
export function parseShaFile(text: string): string | null {
  const m = text.match(/[a-fA-F0-9]{128}/);
  return m ? m[0].toLowerCase() : null;
}

async function fetchExpectedSha(url: string, _filename: string): Promise<string | null> {
  try {
    const text = await httpGetText(url);
    return parseShaFile(text);
  } catch (e) {
    log.warn(`Tomcat SHA-512 fetch failed: ${(e as Error).message}`);
    return null;
  }
}

// Numeric semver-ish compare for plain "X.Y.Z" strings. Apache versions
// don't carry build metadata; this is enough.
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10));
  const pb = b.split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function locateTomcatHome(root: string): Promise<string | null> {
  // Same shape as locateJdkHome but for Tomcat: bin/catalina.sh on
  // Unix-likes, bin/catalina.bat on Windows. Either presence proves we're
  // looking at a Tomcat install root.
  const candidates: string[] = [root];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) candidates.push(path.join(root, e.name));
    }
  } catch { /* not a dir */ }
  for (const c of candidates) {
    const sh = path.join(c, 'bin', 'catalina.sh');
    const bat = path.join(c, 'bin', 'catalina.bat');
    try {
      const a = await fs.promises.stat(sh).catch(() => null);
      const b = await fs.promises.stat(bat).catch(() => null);
      if (a?.isFile() || b?.isFile()) return c;
    } catch { /* skip */ }
  }
  return null;
}

// Re-export so EditorPanel can identify cancellations.
export { CancelledError };
