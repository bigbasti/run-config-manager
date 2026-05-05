import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import {
  CancelledError,
  makeCancellation,
  httpGet,
  httpGetJson,
  httpGetWithRedirects,
  downloadFile,
  hashOfFile,
  extractArchive,
  flattenSingleNestedDir,
  fileSize,
  pathExists,
  userInstallRoot,
  currentPlatform,
  currentArch,
  humanSize,
  type CancellationSignal,
} from './archiveInstall';

// Re-export so existing call sites (EditorPanel imports CancelledError
// from this module) keep working without an extra import.
export { CancelledError };

// JDK installer driven by the foojay Disco API (api.foojay.io). Disco is the
// de-facto JDK metadata service used by IntelliJ, Gradle toolchains and
// JBang — it lists ~20 distributions and returns vendor-hosted download
// URLs plus checksums, so we never have to hard-code a URL.
//
// Flow: list distributions → list packages for a distro → download the
// archive (with progress + cancel) → verify SHA256 → extract under
// $userHome/.rcm/jdks/<dir>. Returned `jdkHome` is the directory containing
// `bin/java`, ready to drop into the form's jdkPath dropdown.
//
// Per-user install location avoids needing sudo/admin and matches what
// detectJdks() already scans (jenv, sdkman, asdf live in $HOME too).

const DISCO_BASE = 'https://api.foojay.io/disco/v3.0';
const USER_AGENT = 'run-config-manager-vscode/1.0';

// Curated distro list — foojay surfaces 20+ but most users only ever pick
// from a handful, and the rest are vendor-specific (Trava, Bisheng,
// Mandrel, …). We expose the mainstream ones that ship a regular JDK
// across all three OSes. Note: `oracle_open_jdk` is the GPL build from
// jdk.java.net; Oracle's commercial JDK has no public auto-install API.
export const SUPPORTED_DISTROS: ReadonlyArray<{ apiName: string; label: string }> = [
  { apiName: 'temurin', label: 'Eclipse Temurin (Adoptium)' },
  { apiName: 'oracle_open_jdk', label: 'Oracle OpenJDK (open build)' },
  { apiName: 'zulu', label: 'Azul Zulu' },
  { apiName: 'corretto', label: 'Amazon Corretto' },
  { apiName: 'liberica', label: 'BellSoft Liberica' },
  { apiName: 'microsoft', label: 'Microsoft Build of OpenJDK' },
  { apiName: 'graalvm_ce17', label: 'GraalVM CE 17' },
  { apiName: 'graalvm_ce21', label: 'GraalVM CE 21' },
  { apiName: 'sap_machine', label: 'SapMachine' },
  { apiName: 'semeru', label: 'IBM Semeru (OpenJ9)' },
];

export interface JdkPackage {
  // Stable id from Disco — opaque, used to fetch the direct_download_uri.
  id: string;
  distro: string;
  // Display label for the version select: "21.0.2 (LTS)".
  versionLabel: string;
  // Major version sortable: 21, 17, 11, …
  majorVersion: number;
  // Original archive filename. We store under .rcm/jdks/<derived dir name>.
  filename: string;
  archiveType: 'tar.gz' | 'zip';
  // Bytes; foojay reports it. Used for the progress bar denominator.
  size: number;
  // Foojay returns either a direct URL or an "ephemeral" pkg-info endpoint
  // we have to resolve. Stored as resolved URL when known.
  directUrl?: string;
  // SHA256 from Disco. Mandatory — if missing we abort before download.
  sha256?: string;
  // True when foojay flags the LTS line. Surface in the UI so users pick
  // a stable version by default.
  lts: boolean;
}

export interface DownloadProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  // 0..1; null when state has no measurable progress (verifying is fast,
  // extracting often doesn't yield reliable byte counts via tar).
  fraction: number | null;
  // Optional text the UI can append: "12.4 MB / 187 MB".
  detail?: string;
}

export interface InstallResult {
  jdkHome: string;
  filename: string;
  versionLabel: string;
  distro: string;
}

// Thrown when the metadata we got back from foojay didn't include a
// SHA-256 for the chosen package. Distinct from a real checksum-mismatch:
// the caller (EditorPanel → dialog) intercepts this to ask the user
// whether to install anyway. Mismatch is never recoverable; this is.
export class ChecksumUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumUnavailableError';
  }
}

export class JdkInstallerService {
  // Currently-running download/extract op so the user can cancel. Only one
  // install at a time — the dialog disables the button while running.
  private active: { abort: () => void } | undefined;

  // Returns the curated list of distros. Kept as a method (instead of
  // exporting the constant) so the dialog goes through the same surface
  // every other call uses, simplifying tests.
  listDistributions(): ReadonlyArray<{ apiName: string; label: string }> {
    return SUPPORTED_DISTROS;
  }

  // Where freshly downloaded JDKs land. Surfaced to the UI so the dialog
  // can tell the user "we'll install to <path>" before they click.
  getInstallRoot(): string {
    return userInstallRoot('jdks');
  }

  // Lists JDK packages for a distro on the current platform. Filters
  // server-side via Disco query params so we don't pull 200+ entries we'd
  // throw away.
  async listPackages(distro: string): Promise<JdkPackage[]> {
    const op = currentPlatform();
    const arch = currentArch();
    const archiveType = op === 'windows' ? 'zip' : 'tar.gz';

    const qs = new URLSearchParams({
      distro,
      operating_system: op,
      architecture: arch,
      archive_type: archiveType,
      package_type: 'jdk',
      // Only the latest build of each major version — keeps the version
      // dropdown short. `available` filters to versions that actually have
      // a download URL (some EOL versions are listed but not hosted).
      latest: 'available',
      // Disco returns checksums when this is set.
      release_status: 'ga',
    });
    const url = `${DISCO_BASE}/packages?${qs.toString()}`;
    log.debug(`Disco list: ${url}`);
    const body = await httpGetJson(url);
    const packages = parseDiscoPackages(body, archiveType);
    log.info(`Disco: ${packages.length} packages for ${distro} on ${op}/${arch}`);
    return packages;
  }

  // Downloads, verifies, and extracts the package. Calls onProgress as
  // each phase advances. Cancellable via cancel(); a partial archive on
  // disk is removed.
  //
  // `allowUnverified`: when the package metadata didn't carry a SHA-256,
  // the caller must explicitly opt in (the dialog asks the user first).
  // When the metadata DOES carry a SHA-256 and it mismatches, this flag
  // is ignored — that's a tampering signal we never want to override.
  async install(
    pkg: JdkPackage,
    onProgress: (p: DownloadProgress) => void,
    options: { allowUnverified?: boolean } = {},
  ): Promise<InstallResult> {
    if (this.active) throw new Error('Another JDK install is already running.');

    const installRoot = userInstallRoot('jdks');
    await fs.promises.mkdir(installRoot, { recursive: true });

    // Friendly directory name: "<distro>-<major>" (e.g. azul-zulu-25,
    // amazon-corretto-21). Short, predictable, and matches what we show in
    // the dialog so the user doesn't see the unwieldy archive filename
    // tacked on. Computed by the same helper the UI calls — keeps
    // server-side and dialog labels in sync.
    const dirName = jdkInstallDirName(pkg);
    const targetDir = path.join(installRoot, dirName);
    if (await pathExists(targetDir)) {
      // Already installed — surface as success rather than re-downloading.
      const found = await locateJdkHome(targetDir);
      if (found) {
        log.info(`JDK already installed at ${found}`);
        return { jdkHome: found, filename: pkg.filename, versionLabel: pkg.versionLabel, distro: pkg.distro };
      }
      // Existing dir but no bin/java — wipe and re-extract.
      await fs.promises.rm(targetDir, { recursive: true, force: true });
    }

    const archivePath = path.join(installRoot, `${dirName}.${pkg.archiveType}`);
    const cancellation = makeCancellation();
    this.active = { abort: cancellation.abort };
    // Set in the catch when we want the archive preserved across the
    // user-confirmation round-trip; consulted by the finally.
    let keepArchive = false;
    try {
      // Resolve direct download URL. Disco normally returns it inline,
      // but for some distros (Zulu) it's an extra hop via /ids/<id>/redirect.
      const url = pkg.directUrl
        ?? await resolveDownloadUrl(pkg.id);
      if (!url) throw new Error('Disco did not return a download URL for this package.');

      // Re-use a previously-downloaded archive when its size matches the
      // expected one. The "missing checksum → user confirms" flow throws
      // mid-install, so without this short-circuit clicking "Install
      // anyway" would re-download the same 200+ MB. We compare by size
      // instead of just existence so a corrupt/partial leftover is
      // re-fetched rather than silently extracted.
      const existing = await fileSize(archivePath);
      const reuse = existing !== null && pkg.size > 0 && existing === pkg.size;
      if (reuse) {
        log.info(`JDK download: re-using existing archive ${archivePath} (${humanSize(existing, pkg.size)})`);
        // Emit a final 100%-style progress beat so the dialog's bar shows
        // the right state before we move on to verifying / extracting.
        onProgress({ state: 'downloading', fraction: 1, detail: humanSize(existing, pkg.size) });
      } else {
        if (existing !== null) {
          log.debug(`JDK download: existing archive size ${existing} != expected ${pkg.size}, re-downloading`);
          await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        }
        log.info(`JDK download: ${pkg.distro} ${pkg.versionLabel} → ${archivePath}`);
        onProgress({ state: 'downloading', fraction: 0, detail: humanSize(0, pkg.size) });
        await downloadFile(url, archivePath, pkg.size, (loaded, total) => {
          const fraction = total > 0 ? Math.min(1, loaded / total) : null;
          onProgress({
            state: 'downloading',
            fraction,
            detail: humanSize(loaded, total),
          });
        }, cancellation.signal);
      }

      // Verify SHA-256. Two distinct cases:
      //   (a) Metadata HAS a checksum and it mismatches — always abort.
      //       That's a tampering / wrong-file signal; no override path.
      //   (b) Metadata is MISSING a checksum — abort by default, but the
      //       caller can pass allowUnverified once the user has been told
      //       and clicks "Install anyway". Some Azul Zulu LTS packages
      //       arrive without a SHA in the foojay payload; we shouldn't
      //       leave the user dead-ended.
      if (pkg.sha256) {
        onProgress({ state: 'verifying', fraction: null });
        const actual = await hashOfFile(archivePath, 'sha256');
        if (actual.toLowerCase() !== pkg.sha256.toLowerCase()) {
          throw new Error(
            `Checksum mismatch — expected ${pkg.sha256}, got ${actual}. Archive deleted.`,
          );
        }
      } else if (!options.allowUnverified) {
        // Surface the unverified state distinctly so the dialog can present
        // the user-confirmation flow instead of just showing a generic
        // error message.
        throw new ChecksumUnavailableError(
          'No SHA-256 in metadata for this package — install would be unverified.',
        );
      } else {
        log.warn(`JDK install: proceeding without checksum verification (user-approved): ${pkg.filename}`);
      }

      onProgress({ state: 'extracting', fraction: null });
      await extractArchive(archivePath, targetDir, pkg.archiveType, cancellation.signal);

      // Most JDK archives extract to a single nested directory like
      // `zulu25.30-ca-jdk25.0.0-linux_x64/`. The user's expectation is
      // that `targetDir` IS the JDK home, not its parent — so we flatten
      // by hoisting the inner directory's contents up one level. macOS
      // bundles get a `Contents/Home` wrapper preserved (those structures
      // must stay intact for the OS to treat them as JDKs).
      // Most JDK archives extract into a single nested folder. macOS
      // bundle layouts (Contents/Home) must stay intact for the OS to
      // treat them as JDKs — `skipIfChildHas` handles that.
      await flattenSingleNestedDir(targetDir, { skipIfChildHas: ['Contents'] });
      const jdkHome = await locateJdkHome(targetDir);
      if (!jdkHome) {
        throw new Error('Extracted archive did not contain bin/java — install aborted.');
      }
      log.info(`JDK installed: ${jdkHome}`);
      return {
        jdkHome,
        filename: pkg.filename,
        versionLabel: pkg.versionLabel,
        distro: pkg.distro,
      };
    } catch (e) {
      // KEEP the archive when we hand control back for user confirmation
      // — clicking "Install anyway" should reuse it. Real failures wipe
      // both. We mark `keepArchive` and check it in the finally so the
      // success path can still clean up.
      keepArchive = e instanceof ChecksumUnavailableError;
      if (!keepArchive) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      }
      await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this.active = undefined;
      // Success or unrelated failure → delete archive. ChecksumUnavailable
      // → keep it, the caller will retry with allowUnverified=true.
      if (!keepArchive) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      }
    }
  }

  cancel(): void {
    if (!this.active) return;
    log.info('JDK install: cancellation requested');
    this.active.abort();
  }
}

// Pure parser for the foojay /packages response. Exported so unit tests
// can verify shape, sort order, and the checksum-type filter without
// needing to mock the HTTP layer.
//
// Foojay returns multiple packages per (distro, version) when there are
// variants — Zulu in particular ships standard, JavaFX-bundled, CRaC, and
// musl builds with the same `distribution_version`. We:
//   1. Drop musl (libc != glibc) on Linux — uncommon and the dropdown
//      shouldn't surface them by default; users on Alpine know to look.
//   2. Append a discriminator to the label whenever a (major, version)
//      pair has more than one survivor: "(JavaFX)", "(CRaC)", "(headless)".
//   3. Otherwise leave the label clean.
// Without this, Zulu 21 shows up three times with identical labels.
export function parseDiscoPackages(
  body: unknown,
  archiveType: 'tar.gz' | 'zip',
): JdkPackage[] {
  const result = (body && typeof body === 'object' && Array.isArray((body as any).result))
    ? ((body as any).result as any[])
    : [];

  // Pre-filter: drop alternate libc builds (musl) — they're an edge case
  // the dialog doesn't need to surface for the common path.
  const filtered = result.filter(p => {
    const lib = typeof p.lib_c_type === 'string' ? p.lib_c_type.toLowerCase() : '';
    if (lib && lib !== 'glibc' && lib !== 'libc' && lib !== 'c_std_lib') return false;
    return true;
  });

  // Build packages with a base label, plus the variant tags we'll fold
  // into the label only when collisions exist.
  type Working = JdkPackage & { variantTags: string[] };
  const working: Working[] = filtered.map(p => {
    const tags: string[] = [];
    if (p.javafx_bundled === true) tags.push('JavaFX');
    const features = Array.isArray(p.feature) ? p.feature : [];
    if (features.some((f: unknown) => typeof f === 'string' && /crac/i.test(f))) tags.push('CRaC');
    if (p.headless === true) tags.push('headless');
    // bundle_type can carry "jdk" / "jdk_fx" / "jdk_lite"; surface lite
    // because users would otherwise see "Java 21.0.2" twice for the
    // standard JDK and the lite variant.
    const bt = typeof p.bundle_type === 'string' ? p.bundle_type.toLowerCase() : '';
    if (bt.includes('lite')) tags.push('lite');

    return {
      id: String(p.id),
      distro: String(p.distribution),
      versionLabel: formatVersionLabel(p),
      majorVersion: Number(p.jdk_version ?? p.major_version ?? 0),
      filename: String(p.filename ?? ''),
      archiveType,
      size: Number(p.size ?? 0),
      directUrl: p.links?.pkg_download_redirect
        ?? p.links?.direct_download_uri
        ?? undefined,
      sha256: typeof p.checksum === 'string' && p.checksum_type?.toLowerCase() === 'sha256'
        ? p.checksum
        : undefined,
      lts: p.term_of_support === 'lts',
      variantTags: tags,
    };
  });

  // Disambiguate: any base label that appears more than once gets every
  // entry's tags appended. The first entry in a colliding group with no
  // tags ("the standard build") gets "(standard)" so it can't end up
  // looking identical to the variant entries.
  const labelCounts = new Map<string, number>();
  for (const w of working) labelCounts.set(w.versionLabel, (labelCounts.get(w.versionLabel) ?? 0) + 1);

  const packages: JdkPackage[] = working.map(w => {
    const collides = (labelCounts.get(w.versionLabel) ?? 0) > 1;
    let label = w.versionLabel;
    if (collides) {
      const suffix = w.variantTags.length > 0
        ? ` (${w.variantTags.join(', ')})`
        : ' (standard)';
      label = label + suffix;
    }
    // Strip working field on the way out.
    const { variantTags: _drop, ...rest } = w;
    void _drop;
    return { ...rest, versionLabel: label };
  });

  packages.sort((a, b) => {
    if (a.majorVersion !== b.majorVersion) return b.majorVersion - a.majorVersion;
    if (a.lts !== b.lts) return a.lts ? -1 : 1;
    return a.versionLabel.localeCompare(b.versionLabel);
  });
  return packages;
}

// ---------------------------------------------------------------------------
// Disco-specific helpers — generic HTTP/download/extract/hash now live in
// archiveInstall.ts and are imported at the top of this file.
// ---------------------------------------------------------------------------

// /packages?... returns metadata; the actual download lives behind a
// per-package /ids/<id>/redirect endpoint that issues a 302 to the vendor.
// This wrapper resolves that for cases where the inline link is missing.
async function resolveDownloadUrl(packageId: string): Promise<string | undefined> {
  const url = `${DISCO_BASE}/ids/${encodeURIComponent(packageId)}/redirect`;
  return new Promise(resolve => {
    httpGet(url, res => {
      // Disco returns the URL in the body for direct download_uri call,
      // or 302 with Location for the redirect endpoint. Handle both.
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        resolve(res.headers.location);
        res.resume();
        return;
      }
      if (res.statusCode === 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(j?.result?.[0]?.direct_download_uri ?? j?.direct_download_uri);
          } catch { resolve(undefined); }
        });
        return;
      }
      resolve(undefined);
      res.resume();
    }, () => resolve(undefined));
  });
}

// Friendly install-dir name for a foojay package: `<distro>-<major>`,
// lowercased and slug-safe. Exported so the dialog can compute the same
// path (for the "Will be installed to:" preview) without the server having
// to round-trip per selection. Vendors whose foojay apiName already
// embeds the major (graalvm_ce17 / graalvm_ce21) get the trailing digits
// stripped so we don't end up with `graalvm-ce17-17`.
export function jdkInstallDirName(pkg: { distro: string; majorVersion: number }): string {
  let base = pkg.distro.toLowerCase().replace(/_/g, '-');
  base = base.replace(/[-_]?\d+$/, '');
  if (!base) base = pkg.distro.toLowerCase().replace(/_/g, '-');
  return `${base}-${pkg.majorVersion}`;
}

// Walk the extracted directory to find the JDK home (the dir with bin/java).
// Some archives extract to <targetDir>/jdk-21.0.2/...; some to <targetDir>
// directly; mac archives have a Contents/Home wrapping. Try all three.
async function locateJdkHome(root: string): Promise<string | null> {
  const candidates: string[] = [root];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(root, e.name);
      candidates.push(child, path.join(child, 'Contents', 'Home'));
    }
  } catch { /* not a dir */ }
  for (const c of candidates) {
    const javaBin = path.join(c, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    try {
      const stat = await fs.promises.stat(javaBin);
      if (stat.isFile()) return c;
    } catch { /* try next */ }
  }
  return null;
}

function formatVersionLabel(p: any): string {
  const v = p.distribution_version ?? p.java_version ?? p.jdk_version ?? '?';
  const lts = p.term_of_support === 'lts' ? ' (LTS)' : '';
  return `${v}${lts}`;
}
