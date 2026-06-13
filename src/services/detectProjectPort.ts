import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { detectNpmFramework } from '../adapters/npm/detectNpmFramework';

// Detects the declared HTTP port of a project by reading its own config
// files. Deliberately NOT a guess — returns null when nothing is found so
// the caller (form port field) stays empty rather than misleading the user.
//
// Strategy per type:
//   - spring-boot: application-<profile>.{properties,yml,yaml} → then
//                  application.{properties,yml,yaml} as a fallback, looking
//                  for server.port.
//   - quarkus:     application.{properties,yml} → quarkus.http.port (optionally
//                  inside a %<profile>. prefix when a profile is active).
//   - npm:         detect the framework (angular/vite/next/react/svelte/vue)
//                  and return its convention default, OR parse package.json
//                  scripts for --port.
//   - tomcat:      not needed — httpPort is already on the form.

/**
 * Try to find the HTTP port for a Spring Boot project. Checks the active
 * profile's application file first, then the plain `application.*`.
 */
export async function detectSpringBootPort(
  projectRoot: vscode.Uri,
  profiles: string | undefined,
): Promise<number | null> {
  log.debug(`detectSpringBootPort: root=${projectRoot.fsPath} profiles="${profiles ?? ''}"`);
  // Spring's profile precedence is "last wins" when multiple are active; the
  // user's comma list follows that. We iterate in reverse so a later profile
  // overrides earlier ones, matching runtime behaviour.
  const profileList = (profiles ?? '')
    .split(',').map(p => p.trim()).filter(Boolean).reverse();
  for (const profile of profileList) {
    const port = await scanSpringAppFiles(projectRoot, profile);
    if (port) {
      log.info(`detectSpringBootPort: found server.port=${port} in application-${profile}.*`);
      return port;
    }
  }
  // Fallback: plain application.{properties,yml,yaml}.
  const port = await scanSpringAppFiles(projectRoot, null);
  if (port) log.info(`detectSpringBootPort: found server.port=${port} in plain application.*`);
  else log.debug(`detectSpringBootPort: no server.port found (profiles tried: [${profileList.join(', ')}])`);
  return port;
}

async function scanSpringAppFiles(
  root: vscode.Uri,
  profile: string | null,
): Promise<number | null> {
  const suffix = profile ? `-${profile}` : '';
  const candidates = [
    `src/main/resources/application${suffix}.properties`,
    `src/main/resources/application${suffix}.yml`,
    `src/main/resources/application${suffix}.yaml`,
  ];
  for (const rel of candidates) {
    const text = await readFile(vscode.Uri.joinPath(root, rel));
    if (!text) continue;
    const port = rel.endsWith('.properties')
      ? extractPropertyPort(text, 'server.port')
      : extractYamlPort(text, ['server', 'port']);
    log.debug(
      `detectSpringBootPort: ${rel} exists, server.port=${port ?? '<not set>'}`,
    );
    if (port) return port;
  }
  return null;
}

/**
 * Try to find the HTTP port for a Quarkus project. Reads application.properties
 * / application.yml under src/main/resources. Honors `%<profile>.quarkus.http.port=…`
 * overrides when a profile is set.
 */
export async function detectQuarkusPort(
  projectRoot: vscode.Uri,
  profile: string | undefined,
): Promise<number | null> {
  log.debug(`detectQuarkusPort: root=${projectRoot.fsPath} profile="${profile ?? ''}"`);
  const candidates = [
    'src/main/resources/application.properties',
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
  ];
  let fallback: number | null = null;
  for (const rel of candidates) {
    const text = await readFile(vscode.Uri.joinPath(projectRoot, rel));
    if (!text) continue;
    if (rel.endsWith('.properties')) {
      if (profile) {
        const p = extractPropertyPort(text, `%${profile}.quarkus.http.port`);
        if (p) {
          log.info(`detectQuarkusPort: found %${profile}.quarkus.http.port=${p} in ${rel}`);
          return p;
        }
      }
      const p = extractPropertyPort(text, 'quarkus.http.port');
      if (p && fallback === null) {
        log.debug(`detectQuarkusPort: ${rel} quarkus.http.port=${p} (unprefixed fallback)`);
        fallback = p;
      }
    } else {
      if (profile) {
        const p = extractYamlPortWithProfile(text, profile, ['quarkus', 'http', 'port']);
        if (p) {
          log.info(`detectQuarkusPort: found %${profile} quarkus.http.port=${p} in ${rel}`);
          return p;
        }
      }
      const p = extractYamlPort(text, ['quarkus', 'http', 'port']);
      if (p && fallback === null) {
        log.debug(`detectQuarkusPort: ${rel} quarkus.http.port=${p} (unprefixed fallback)`);
        fallback = p;
      }
    }
  }
  if (fallback) log.info(`detectQuarkusPort: returning fallback port=${fallback}`);
  else log.debug(`detectQuarkusPort: no quarkus.http.port found`);
  return fallback;
}

/**
 * Try to find the HTTP port for an npm-based project:
 *   1. Scan `package.json` scripts for --port N (most reliable).
 *   2. Detect framework (Angular / Vite / Next / Svelte / React-Scripts) and
 *      return its documented default dev-server port.
 * Returns null for plain Node scripts where there's no convention.
 */
export async function detectNpmPort(
  projectRoot: vscode.Uri,
  scriptName: string | undefined,
): Promise<number | null> {
  log.debug(`detectNpmPort: root=${projectRoot.fsPath} scriptName="${scriptName ?? ''}"`);
  const pkgText = await readFile(vscode.Uri.joinPath(projectRoot, 'package.json'));
  if (!pkgText) {
    log.debug(`detectNpmPort: no package.json at ${projectRoot.fsPath}`);
    return null;
  }
  let pkg: any;
  try { pkg = JSON.parse(pkgText); }
  catch (e) {
    log.debug(`detectNpmPort: package.json parse failed — ${(e as Error).message}`);
    return null;
  }

  // Look at the specific script the user picked first — most accurate signal.
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const line = scriptName && scripts[scriptName] ? scripts[scriptName] : '';
  const fromScript = scanForPortInArgs(line);
  if (fromScript) {
    log.info(`detectNpmPort: found --port ${fromScript} in script "${scriptName}"`);
    return fromScript;
  }

  // Fall back to framework convention defaults via the shared detector.
  // This is the same data the form's "Detected: X" badge uses, so
  // changes to the framework table propagate to both paths automatically.
  const scriptKeys = Object.keys(scripts);
  const dependencies = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const fw = await detectNpmFramework(projectRoot, scriptKeys, scripts, dependencies);

  // Angular declares its real dev-server port in angular.json, not in the
  // npm script. Read it before reaching for the generic 4200 default — in
  // multi-project workspaces (e.g. a `web` on 4200 next to an `admin` on
  // 4300) the convention default is wrong and would inject a phantom port
  // into the conflict-check set, producing false "port already in use"
  // errors when a sibling project is already running on the default port.
  if (fw.name === 'angular') {
    const declared = await readAngularServePort(projectRoot);
    if (declared !== null) {
      log.info(`detectNpmPort: angular.json serve.options.port=${declared}`);
      return declared;
    }
  }

  if (fw.defaultPort !== null) {
    log.info(`detectNpmPort: matched ${fw.name} convention → port=${fw.defaultPort}`);
    return fw.defaultPort;
  }
  log.debug(`detectNpmPort: no framework convention matched for script "${scriptName}"`);
  return null;
}

// Reads the configured dev-server port from a project's angular.json.
// Returns null when the file is missing, unparseable, declares no serve
// port, or is ambiguous (multiple projects with no defaultProject) — the
// caller then falls back to the 4200 convention default.
//
// Each Angular project conventionally has its own angular.json in its own
// directory with a single project entry, so "the only project" is the
// common case. When several projects are present we honour `defaultProject`
// (older schema); otherwise we bail rather than guess.
async function readAngularServePort(projectRoot: vscode.Uri): Promise<number | null> {
  const text = await readFile(vscode.Uri.joinPath(projectRoot, 'angular.json'));
  if (!text) return null;
  let json: any;
  try { json = JSON.parse(text); }
  catch (e) {
    log.debug(`readAngularServePort: angular.json parse failed — ${(e as Error).message}`);
    return null;
  }
  const projects = json.projects;
  if (!projects || typeof projects !== 'object') return null;
  const names = Object.keys(projects);
  if (names.length === 0) return null;

  let projectName: string;
  if (names.length === 1) {
    projectName = names[0];
  } else if (typeof json.defaultProject === 'string' && projects[json.defaultProject]) {
    projectName = json.defaultProject;
  } else {
    // Ambiguous — don't guess which project this run config targets.
    return null;
  }

  const project = projects[projectName];
  // Angular CLI moved `architect` → `targets` in newer schema versions;
  // both carry the same `serve.options.port` shape.
  const serve = project?.architect?.serve ?? project?.targets?.serve;
  const port = serve?.options?.port;
  return typeof port === 'number' && port > 0 ? port : null;
}

// --- parsing helpers ----------------------------------------------------

async function readFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

// Extracts a numeric port from a .properties file. Honours commented lines
// (# / !), handles "@variable@" placeholders by falling back to null, and
// accepts env-var-style expansions like ${PORT:8080} by pulling the default.
function extractPropertyPort(text: string, key: string): number | null {
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const lhs = line.slice(0, eq).trim();
    if (lhs !== key) continue;
    const rhs = line.slice(eq + 1).trim();
    const direct = rhs.match(/^(\d+)$/);
    if (direct) return parseInt(direct[1], 10);
    // `${PORT:8080}` pattern — use the default.
    const defaulted = rhs.match(/^\$\{[^:]+:(\d+)\}$/);
    if (defaulted) return parseInt(defaulted[1], 10);
    return null;
  }
  return null;
}

// Very small YAML port-extractor. Not a real parser — we look for a sequence
// of nested keys and accept the first numeric value we find at the right
// indentation depth. Handles the two layouts we actually see:
//   server:
//     port: 8080
// and
//   server.port: 8080
function extractYamlPort(text: string, path: string[]): number | null {
  // Flattened form first — common in Spring Boot configs.
  const flatRe = new RegExp(`^\\s*${path.join('\\.')}\\s*:\\s*(\\d+)\\s*$`, 'm');
  const flat = text.match(flatRe);
  if (flat) return parseInt(flat[1], 10);

  // Nested form — walk line by line, tracking depth by leading-space count.
  const lines = text.split('\n');
  let depth = 0;
  let i = 0;
  while (i < lines.length && depth < path.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const indent = line.search(/\S/);
    const key = path[depth];
    // Match `key:` at the expected indent (we accept any indent >= 0 at the
    // top of the path; deeper keys must be strictly more-indented than the
    // previous one).
    const re = new RegExp(`^\\s{${indent}}${escapeRegex(key)}\\s*:(.*)$`);
    const m = line.match(re);
    if (m) {
      if (depth === path.length - 1) {
        const rhs = m[1].trim();
        const digits = rhs.match(/^(\d+)$/);
        return digits ? parseInt(digits[1], 10) : null;
      }
      depth++;
      i++;
      continue;
    }
    // Not a match at current expected depth — skip this line.
    i++;
  }
  return null;
}

// YAML variant that first scopes to a "%profile": block at the top level.
function extractYamlPortWithProfile(text: string, profile: string, path: string[]): number | null {
  const lines = text.split('\n');
  // Find `"%profile":` (quoted) or `%profile:` line at depth 0.
  const header = new RegExp(`^"?%${escapeRegex(profile)}"?\\s*:\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  // Collect the indented block beneath the profile header.
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { block.push(l); continue; }
    // End of block when we see a non-indented non-empty line.
    if (/^\S/.test(l)) break;
    block.push(l);
  }
  // Dedent so the nested extractor can re-anchor at column 0.
  const minIndent = block
    .filter(l => l.trim())
    .reduce((min, l) => Math.min(min, l.search(/\S/)), Infinity);
  const dedented = block.map(l => l.slice(Number.isFinite(minIndent) ? minIndent : 0)).join('\n');
  return extractYamlPort(dedented, path);
}

function scanForPortInArgs(text: string): number | null {
  if (!text) return null;
  // Matches: --port 4200  /  --port=4200  /  -p 4200
  const m = text.match(/(?:^|\s)(?:--port|-p)[= ](\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Safe-fire wrapper — callers from streaming detect shouldn't crash a probe
// if any of the above hits an unexpected parse issue.
export async function safeDetect<T>(
  label: string,
  fn: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log.debug(`port detect (${label}) failed: ${(e as Error).message}`);
    return null;
  }
}
