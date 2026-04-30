import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { log } from '../utils/logger';

// Reads the "active" Maven settings.xml or Gradle gradle.properties for a
// project and extracts the proxy host/port so the user can see — right in
// the form — which proxy their build will talk through.
//
// Resolution rules (researched against Maven 3.x and Gradle current):
//
// Maven settings.xml
//   User:    ${user.home}/.m2/settings.xml                   ← preferred when present
//   Global:  ${MAVEN_HOME|M2_HOME}/conf/settings.xml         ← fallback
//   Merged by Maven at runtime, but for "which file should I open" the user's
//   copy is what they'd actually edit. We therefore surface the user file when
//   it exists, the global otherwise.
//
// Gradle gradle.properties
//   User:    ${GRADLE_USER_HOME|~/.gradle}/gradle.properties  ← wins on conflict
//   Project: <projectRoot>/gradle.properties                  ← lower precedence
//   Gradle merges these; on key conflict the user-home value wins. We pick
//   user-home when it exists, otherwise the project-level file. Proxy
//   settings are almost always in the user-home file.
//
// Proxy extraction:
//   Maven:   <proxies><proxy> where <active>true</active> (or <active> omitted
//            — which also defaults to active per Maven's reference). Only the
//            first such proxy is considered active.
//   Gradle:  systemProp.http.proxyHost / systemProp.http.proxyPort (with the
//            https. variant as a fallback, since HTTPS in Gradle does NOT
//            inherit from HTTP).
//
// We stay best-effort: any parse failure returns `null` for the missing part
// rather than crashing, since this panel is informational.

export interface OverriddenFile {
  // Absolute path of a settings file that exists on disk but is shadowed by
  // the active one. Shown in the "overridden files" panel so users
  // understand why switching the Gradle/Maven install dropdown doesn't
  // change the active values — the higher-precedence user-level file is
  // still winning.
  filePath: string;
  proxyHost: string | null;
  proxyPort: number | null;
  nonProxyHosts: string | null;
  // Human-readable precedence tier this file occupies ("Maven global
  // install", "Gradle project root", etc.) — helps users distinguish two
  // overridden files at a glance.
  tier: string;
}

export interface BuildToolSettingsInfo {
  buildTool: 'maven' | 'gradle' | 'npm';
  // Active file the user would edit. Absent when nothing was found on disk,
  // in which case `searchedPaths` lists where we looked. For npm this is
  // always absent — proxy config comes from environment variables, not a
  // file the user is expected to open from the form.
  activeFilePath?: string;
  // Free-form name of the source we read (e.g. "HTTP_PROXY env var"). Used
  // by the UI to label where a value came from. Null for file-based sources
  // since the file path already answers that question.
  sourceLabel?: string;
  // Lower-precedence files that exist on disk but are overridden by the
  // active file. Empty list when no conflicts (or when there is no active
  // file). Populated in precedence order (highest below the active file
  // first) so the UI can list them top-down the same way the merge logic
  // walks them.
  overriddenFiles: OverriddenFile[];
  // Proxy host and port extracted from the active file. Either can be null
  // if the file didn't declare one (e.g. only nonProxyHosts or no proxy at
  // all).
  proxyHost: string | null;
  proxyPort: number | null;
  // Raw nonProxyHosts value from the active file. For Maven this comes from
  // <nonProxyHosts>, for Gradle from systemProp.http.nonProxyHosts. Kept as
  // an opaque string — the syntax differs (Maven uses `|`, Gradle uses `|`
  // with optional `*` globs) and the UI just displays it verbatim.
  nonProxyHosts: string | null;
  // Additional properties we feel like showing. Host-only / port-only cases
  // benefit from an explicit note so the user isn't left wondering.
  note?: string;
  // Paths we checked when resolving the active file. Always populated so the
  // UI can show "Looked at: …" when nothing was found.
  searchedPaths: string[];
}

export interface LoadOptions {
  // Absolute path of the selected Maven installation (from the form's
  // `typeOptions.mavenPath` dropdown). When provided, its `conf/settings.xml`
  // is used as the global-settings fallback — this reflects that switching
  // installations in the UI may actually switch which file is active.
  // Ignored when the user has `~/.m2/settings.xml` (user wins over global).
  mavenPath?: string;
  // Absolute path of the selected Gradle installation. Used as the
  // lowest-precedence fallback when neither the Gradle user home nor the
  // project gradle.properties exists, and surfaced so a different install
  // can shift which file is "active" in the UI.
  gradlePath?: string;
}

export class BuildToolSettingsService {
  // Entry point used by EditorPanel's loadBuildToolSettings handler.
  async load(
    buildTool: 'maven' | 'gradle' | 'npm',
    projectRoot: vscode.Uri,
    options: LoadOptions = {},
  ): Promise<BuildToolSettingsInfo> {
    if (buildTool === 'maven') return this.loadMaven(options.mavenPath);
    if (buildTool === 'npm') return this.loadNpm();
    return this.loadGradle(projectRoot, options.gradlePath);
  }

  // npm projects don't have a universal "settings file" the way Maven and
  // Gradle do (the proxy lives wherever npm config bubbles it up from —
  // usually $HTTP(S)_PROXY). We surface only the env-var view: if
  // HTTP_PROXY / HTTPS_PROXY / NO_PROXY are set in the extension host's
  // environment, we parse them; otherwise we return an empty result so the
  // UI can hide the panel entirely (there's nothing to open and nothing to
  // show).
  private async loadNpm(): Promise<BuildToolSettingsInfo> {
    const httpProxy = firstNonEmpty(process.env.HTTP_PROXY, process.env.http_proxy);
    const httpsProxy = firstNonEmpty(process.env.HTTPS_PROXY, process.env.https_proxy);
    const noProxy = firstNonEmpty(process.env.NO_PROXY, process.env.no_proxy);

    if (!httpProxy && !httpsProxy && !noProxy) {
      log.debug('npm settings: no proxy env vars set');
      return {
        buildTool: 'npm',
        proxyHost: null,
        proxyPort: null,
        nonProxyHosts: null,
        overriddenFiles: [],
        searchedPaths: [],
      };
    }

    // HTTPS takes precedence over HTTP for the display — modern registries
    // are HTTPS and most setups only differ on port. When only HTTP_PROXY
    // is set, use it. When neither is set (only NO_PROXY), we still render
    // the panel because NO_PROXY alone is meaningful — no source label
    // though, because there's no upstream proxy to attribute.
    const raw = httpsProxy ?? httpProxy;
    const parsed = raw
      ? parseProxyUrl(raw)
      : { host: null as string | null, port: null as number | null };
    const sourceLabel = httpsProxy
      ? 'HTTPS_PROXY env var'
      : httpProxy ? 'HTTP_PROXY env var' : undefined;
    log.debug(
      `npm settings: source=${sourceLabel ?? 'NO_PROXY only'} host=${parsed.host ?? 'none'} ` +
      `port=${parsed.port ?? 'none'} noProxy=${noProxy ?? 'none'}`,
    );

    return {
      buildTool: 'npm',
      ...(sourceLabel ? { sourceLabel } : {}),
      proxyHost: parsed.host,
      proxyPort: parsed.port,
      nonProxyHosts: noProxy,
      // npm is env-var-only; there are no shadowed files to display.
      overriddenFiles: [],
      searchedPaths: [],
      ...(('note' in parsed && parsed.note) ? { note: parsed.note } : {}),
    };
  }

  private async loadMaven(selectedMavenPath?: string): Promise<BuildToolSettingsInfo> {
    const userFile = path.join(os.homedir(), '.m2', 'settings.xml');
    // Prefer the installation picked on the form — that's what the user
    // would actually launch with. Fall back to MAVEN_HOME / M2_HOME env
    // vars when nothing is selected yet (matching the original behaviour
    // before the form-driven path was added).
    const globalFile = selectedMavenPath
      ? path.join(selectedMavenPath, 'conf', 'settings.xml')
      : mavenGlobalSettingsPath();
    // Precedence ordering (highest first) — the first one that exists on
    // disk is "active"; every other existing file is overridden.
    const candidates: Array<{ path: string; tier: string }> = [
      { path: userFile, tier: 'Maven user (~/.m2)' },
    ];
    if (globalFile) {
      candidates.push({
        path: globalFile,
        tier: selectedMavenPath ? 'Maven global (selected install)' : 'Maven global (MAVEN_HOME)',
      });
    }

    const resolved = await this.resolveCandidates(candidates, 'maven');
    const searched = candidates.map(c => c.path);

    if (!resolved.active) {
      log.debug(`Maven settings: none found. Looked at: ${searched.join(', ')}`);
      return {
        buildTool: 'maven',
        proxyHost: null,
        proxyPort: null,
        nonProxyHosts: null,
        overriddenFiles: [],
        searchedPaths: searched,
        note: 'No settings.xml found on disk.',
      };
    }

    const a = resolved.active;
    log.debug(
      `Maven settings: active=${a.filePath} proxyHost=${a.proxyHost ?? 'none'} ` +
      `proxyPort=${a.proxyPort ?? 'none'} nonProxyHosts=${a.nonProxyHosts ?? 'none'} ` +
      `overridden=${resolved.overriddenFiles.length}`,
    );
    return {
      buildTool: 'maven',
      activeFilePath: a.filePath,
      proxyHost: a.proxyHost,
      proxyPort: a.proxyPort,
      nonProxyHosts: a.nonProxyHosts,
      overriddenFiles: resolved.overriddenFiles,
      searchedPaths: searched,
      ...(a.note ? { note: a.note } : {}),
    };
  }

  private async loadGradle(
    projectRoot: vscode.Uri,
    selectedGradlePath?: string,
  ): Promise<BuildToolSettingsInfo> {
    const userHome = process.env.GRADLE_USER_HOME?.trim()
      || path.join(os.homedir(), '.gradle');
    const userFile = path.join(userHome, 'gradle.properties');
    const projectFile = path.join(projectRoot.fsPath, 'gradle.properties');
    // An install-level gradle.properties is rare but valid (Gradle reads it
    // for `org.gradle.*` defaults shipped with the distribution). It has
    // the lowest precedence; we only surface it when nothing else exists so
    // the user at least sees which file the panel would open.
    const installFile = selectedGradlePath
      ? path.join(selectedGradlePath, 'gradle.properties')
      : undefined;
    const candidates: Array<{ path: string; tier: string }> = [
      { path: userFile, tier: 'Gradle user home' },
      { path: projectFile, tier: 'Gradle project root' },
    ];
    if (installFile) candidates.push({ path: installFile, tier: 'Gradle install' });
    const searched = candidates.map(c => c.path);

    const resolved = await this.resolveCandidates(candidates, 'gradle');

    if (!resolved.active) {
      log.debug(`Gradle settings: none found. Looked at: ${searched.join(', ')}`);
      return {
        buildTool: 'gradle',
        proxyHost: null,
        proxyPort: null,
        nonProxyHosts: null,
        overriddenFiles: [],
        searchedPaths: searched,
        note: 'No gradle.properties found on disk.',
      };
    }

    const a = resolved.active;
    log.debug(
      `Gradle settings: active=${a.filePath} proxyHost=${a.proxyHost ?? 'none'} ` +
      `proxyPort=${a.proxyPort ?? 'none'} nonProxyHosts=${a.nonProxyHosts ?? 'none'} ` +
      `overridden=${resolved.overriddenFiles.length}`,
    );
    return {
      buildTool: 'gradle',
      activeFilePath: a.filePath,
      proxyHost: a.proxyHost,
      proxyPort: a.proxyPort,
      nonProxyHosts: a.nonProxyHosts,
      overriddenFiles: resolved.overriddenFiles,
      searchedPaths: searched,
      ...(a.note ? { note: a.note } : {}),
    };
  }

  // Walks a precedence-ordered candidate list (highest first), reading each
  // file that exists on disk and parsing its proxy. The first existing one
  // becomes active; every subsequent existing file becomes an overridden
  // entry with its own proxy values so the UI can show "user file wins, but
  // the install file also has these values sitting underneath".
  private async resolveCandidates(
    candidates: Array<{ path: string; tier: string }>,
    buildTool: 'maven' | 'gradle',
  ): Promise<{
    active: (OverriddenFile & { note?: string }) | null;
    overriddenFiles: OverriddenFile[];
  }> {
    let active: (OverriddenFile & { note?: string }) | null = null;
    const overriddenFiles: OverriddenFile[] = [];
    // Dedupe by normalized file path. When two tiers resolve to the same
    // file (e.g. GRADLE_USER_HOME set to the Gradle install root), we only
    // want to surface it once — listing the same file as both "active" and
    // "overridden" is obviously wrong, and in practice that means Gradle is
    // reading one file twice through different doors.
    const seen = new Set<string>();
    for (const c of candidates) {
      const normalized = path.normalize(c.path);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (!(await fileExists(c.path))) continue;
      const text = await readTextFile(c.path);
      const proxy = text
        ? (buildTool === 'maven' ? parseMavenProxy(text) : parseGradleProxy(text))
        : null;
      const entry: OverriddenFile & { note?: string } = {
        filePath: c.path,
        tier: c.tier,
        proxyHost: proxy?.host ?? null,
        proxyPort: proxy?.port ?? null,
        nonProxyHosts: proxy?.nonProxyHosts ?? null,
        ...(proxy?.note ? { note: proxy.note } : {}),
      };
      if (!active) active = entry;
      else overriddenFiles.push(entry);
    }
    return { active, overriddenFiles };
  }
}

// --- parsers ---------------------------------------------------------------

interface ProxyResult {
  host: string | null;
  port: number | null;
  nonProxyHosts: string | null;
  note?: string;
}

// Returns the first active <proxy> entry's host and port. An entry is active
// when <active>true</active> is present OR <active> is absent (Maven's
// default is active=true for proxies that specify a host).
export function parseMavenProxy(xml: string): ProxyResult | null {
  const proxies = extractProxyBlocks(xml);
  if (proxies.length === 0) return null;

  for (const block of proxies) {
    const active = extractTag(block, 'active');
    const isActive = active === null || /^\s*true\s*$/i.test(active);
    if (!isActive) continue;
    const host = nonEmpty(extractTag(block, 'host'));
    const portRaw = extractTag(block, 'port');
    const port = portRaw && /^\s*\d+\s*$/.test(portRaw)
      ? parseInt(portRaw.trim(), 10)
      : null;
    const nonProxyHosts = nonEmpty(extractTag(block, 'nonProxyHosts'));
    const note = host && !port
      ? 'Proxy port not declared in settings.xml.'
      : (!host && port ? 'Proxy host not declared in settings.xml.' : undefined);
    return { host, port, nonProxyHosts, ...(note ? { note } : {}) };
  }
  return { host: null, port: null, nonProxyHosts: null, note: 'No active <proxy> entry in settings.xml.' };
}

// Scans a Maven settings.xml for every <proxy>…</proxy> block under <proxies>.
// Deliberately regex-based — a full XML parser would pull in an extra
// dependency for something this narrow. We strip XML comments first to avoid
// commented-out proxies appearing "active".
function extractProxyBlocks(xml: string): string[] {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  const re = /<proxy\b[^>]*>([\s\S]*?)<\/proxy>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments))) out.push(m[1]);
  return out;
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

// Parses systemProp.http.proxyHost / systemProp.http.proxyPort from a
// .properties file. Handles comments (#, !), continuation lines (\), and
// whitespace around the = separator. HTTPS (systemProp.https.*) is used
// only as a fallback when HTTP isn't set — matches the usual configuration
// style where HTTP is the primary.
export function parseGradleProxy(text: string): ProxyResult | null {
  const props = parsePropertiesFile(text);
  const host = nonEmpty(props['systemProp.http.proxyHost'])
    ?? nonEmpty(props['systemProp.https.proxyHost']);
  const portRaw = props['systemProp.http.proxyPort']
    ?? props['systemProp.https.proxyPort'];
  const port = portRaw && /^\s*\d+\s*$/.test(portRaw)
    ? parseInt(portRaw.trim(), 10)
    : null;
  // Gradle only reads nonProxyHosts from the HTTP namespace — HTTPS reuses
  // the HTTP value at runtime. No need to check both.
  const nonProxyHosts = nonEmpty(props['systemProp.http.nonProxyHosts']);
  if (!host && !port && !nonProxyHosts) return null;
  const note = host && !port
    ? 'systemProp.http.proxyPort not set — build tools will use the JVM default port.'
    : (!host && port ? 'systemProp.http.proxyHost not set.' : undefined);
  return { host, port, nonProxyHosts, ...(note ? { note } : {}) };
}

// Minimal .properties parser. Handles backslash line continuations and
// comment lines — enough for our proxy lookup. Escape sequences inside
// values (\n, \t, \\) are NOT decoded; we pass values through as-is because
// host/port are plain ASCII in practice.
export function parsePropertiesFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rawLines = text.split(/\r?\n/);

  // Fold continuation lines: a line ending in an unescaped backslash joins
  // with the next line. `\\\\` (escaped backslash) is NOT a continuation.
  const folded: string[] = [];
  let buf = '';
  for (const raw of rawLines) {
    const line = buf + raw;
    if (/(^|[^\\])(\\\\)*\\$/.test(line)) {
      buf = line.replace(/\\$/, '');
    } else {
      folded.push(line);
      buf = '';
    }
  }
  if (buf) folded.push(buf);

  for (const line of folded) {
    const stripped = line.replace(/^\s+/, '');
    if (!stripped || stripped.startsWith('#') || stripped.startsWith('!')) continue;
    // First = or : that isn't escaped terminates the key.
    const m = stripped.match(/^([^\s:=]+)\s*[:=]?\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/\s+$/, '');
    out[key] = value;
  }
  return out;
}

// Parses a proxy URL as set in HTTP_PROXY / HTTPS_PROXY. Accepts bare
// host:port forms too (some environments export `proxy.corp:8080`). Returns
// the hostname (credentials stripped — they'd leak into the UI otherwise)
// and port; port is null when the URL doesn't specify one (callers can
// decide what to display; we don't default to 80/443 because that would
// misleadingly show a port the user never configured).
export function parseProxyUrl(raw: string): { host: string | null; port: number | null; note?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { host: null, port: null };

  // Prefix with a scheme so URL parsing works for bare `host:port` inputs.
  const hasScheme = /^\w+:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const u = new URL(candidate);
    // `hostname` omits credentials and port.
    const host = u.hostname || null;
    const port = u.port ? parseInt(u.port, 10) : null;
    return { host, port };
  } catch {
    return {
      host: null,
      port: null,
      note: `Could not parse proxy URL "${trimmed}".`,
    };
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

// --- fs helpers ------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

async function readTextFile(p: string): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t ? t : null;
}

function mavenGlobalSettingsPath(): string | null {
  const mvnHome = process.env.MAVEN_HOME?.trim() || process.env.M2_HOME?.trim();
  if (!mvnHome) return null;
  return path.join(mvnHome, 'conf', 'settings.xml');
}
