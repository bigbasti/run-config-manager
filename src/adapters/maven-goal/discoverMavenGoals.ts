import * as vscode from 'vscode';
import * as cp from 'child_process';
import { log } from '../../utils/logger';

export interface MavenGoalEntry {
  // A fully-qualified value the user can run unchanged: either a lifecycle
  // phase ("clean") or a plugin-qualified goal ("liquibase:dropAll").
  value: string;
  description: string;
}

// Standard Maven lifecycle phases in execution order. Covers the happy
// path — users who want less common phases (pre-integration-test,
// post-integration-test, initialize, etc.) type them manually.
const LIFECYCLE_PHASES: MavenGoalEntry[] = [
  { value: 'clean', description: 'Remove build artifacts (target/).' },
  { value: 'validate', description: 'Validate project structure and required info.' },
  { value: 'compile', description: 'Compile source code.' },
  { value: 'test', description: 'Run tests.' },
  { value: 'package', description: 'Package compiled code (JAR/WAR).' },
  { value: 'verify', description: 'Run integration tests + quality checks.' },
  { value: 'install', description: 'Install package in the local repository.' },
  { value: 'site', description: 'Generate project site.' },
  { value: 'deploy', description: 'Deploy package to a remote repository.' },
];

export interface DiscoverMavenOpts {
  folder: vscode.Uri;
  mavenBinary?: string;    // e.g. '/opt/maven/bin/mvn'; defaults to 'mvn'
  javaHome?: string;
  timeoutMs?: number;      // per-plugin timeout; default 45_000
  concurrency?: number;    // parallel `mvn help:describe` runs; default 4
}

// Reads pom.xml, enumerates the <plugin> entries, and runs
// `mvn help:describe` per plugin in parallel to collect the actual goals
// each plugin defines. Output is the union of lifecycle phases + every
// discovered goal, paired with their descriptions.
//
// Plugins whose goal-list probe fails (wrong groupId, offline, unresolved
// version) fall back to a prefix-only entry so the user still sees them.
// Full failure is silent for discovery — caller gets whatever entries we
// could resolve, with warnings in the Output channel.
export async function discoverMavenGoals(opts: DiscoverMavenOpts): Promise<MavenGoalEntry[]> {
  const entries: MavenGoalEntry[] = [...LIFECYCLE_PHASES];

  const pom = await readPom(opts.folder);
  if (!pom) {
    log.debug(`Maven goals: no pom.xml at ${opts.folder.fsPath}`);
    return entries;
  }

  const plugins = extractPlugins(pom);
  log.info(`Maven goals: pom lists ${plugins.length} plugin(s); probing in parallel…`);
  if (plugins.length === 0) return entries;

  const binary = opts.mavenBinary ?? 'mvn';
  const env = opts.javaHome ? { JAVA_HOME: opts.javaHome } : undefined;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const concurrency = opts.concurrency ?? 4;

  const allGoals: MavenGoalEntry[] = [];
  // Track prefixes we've already emitted so we can fall back gracefully for
  // plugins whose describe probe failed — emit just `<prefix>:` so the user
  // still sees the plugin in the dropdown.
  const seenPrefixes = new Set<string>();

  // Simple worker pool — process `plugins` in chunks of `concurrency`.
  for (let i = 0; i < plugins.length; i += concurrency) {
    const batch = plugins.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(p => describePlugin({
      plugin: p,
      binary,
      cwd: opts.folder.fsPath,
      env,
      timeoutMs,
    })));
    for (const r of results) {
      if (r.goals.length === 0) {
        // Fallback: at least surface the prefix as a completion hint.
        const prefix = stripPluginSuffix(r.plugin.artifactId);
        if (!seenPrefixes.has(prefix)) {
          seenPrefixes.add(prefix);
          allGoals.push({
            value: `${prefix}:`,
            description: `Plugin "${r.plugin.groupId}:${r.plugin.artifactId}" — probe failed; type the goal after the colon`,
          });
        }
        continue;
      }
      for (const g of r.goals) {
        allGoals.push(g);
        const prefix = g.value.split(':')[0];
        seenPrefixes.add(prefix);
      }
    }
  }

  log.info(`Maven goals: enumerated ${allGoals.length} plugin goal(s) across ${plugins.length} plugin(s)`);
  // Sort by prefix then by name for a stable dropdown.
  allGoals.sort((a, b) => a.value.localeCompare(b.value));
  return [...entries, ...allGoals];
}

interface PluginRef {
  groupId: string;
  artifactId: string;
}

async function readPom(folder: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'pom.xml'));
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

// Extracts <plugin> declarations. groupId defaults to
// `org.apache.maven.plugins` when absent (Maven's documented convention).
// Deduped by groupId:artifactId.
function extractPlugins(pom: string): PluginRef[] {
  const seen = new Set<string>();
  const out: PluginRef[] = [];
  const re = /<plugin>([\s\S]*?)<\/plugin>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pom)) !== null) {
    const inner = m[1];
    const aid = /<artifactId>([^<]+)<\/artifactId>/.exec(inner)?.[1]?.trim();
    if (!aid) continue;
    const gid = /<groupId>([^<]+)<\/groupId>/.exec(inner)?.[1]?.trim()
      ?? 'org.apache.maven.plugins';
    const key = `${gid}:${aid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ groupId: gid, artifactId: aid });
  }
  return out;
}

function stripPluginSuffix(artifact: string): string {
  // Maven's prefix derivation:
  //   maven-<name>-plugin  → <name>
  //   <name>-maven-plugin  → <name>
  //   <name>-plugin        → <name>
  return artifact
    .replace(/^maven-/, '')
    .replace(/-maven-plugin$/, '')
    .replace(/-plugin$/, '');
}

interface DescribeOpts {
  plugin: PluginRef;
  binary: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

async function describePlugin(opts: DescribeOpts): Promise<{ plugin: PluginRef; goals: MavenGoalEntry[] }> {
  const { plugin, binary, cwd, env, timeoutMs } = opts;
  const coord = `${plugin.groupId}:${plugin.artifactId}`;
  log.debug(`Maven goals: probing ${coord}`);

  // IMPORTANT: do NOT pass -q. Maven's help:describe prints the goal
  // listing at INFO level; -q suppresses INFO and we get an empty
  // stdout. Keep -B for non-interactive (no download-progress noise)
  // but let INFO lines flow so the parser sees the goal block.
  const args = ['-B', 'help:describe', `-Dplugin=${coord}`];
  const output = await runAndCollect(binary, args, { cwd, env, timeoutMs });
  if (output === null) {
    return { plugin, goals: [] };
  }
  const goals = parseDescribeOutput(output);
  log.debug(`Maven goals: ${coord} → ${goals.length} goal(s)`);
  return { plugin, goals };
}

// Parses `mvn help:describe` output. Goals appear as lines starting with
// `<prefix>:<goalName>` at column 0, followed by an indented
// "Description: …" block. Parser is tolerant — skips INFO noise, stops
// collecting a description on the next blank line or goal header.
export function parseDescribeOutput(output: string): MavenGoalEntry[] {
  const lines = output.split(/\r?\n/);
  const goals: MavenGoalEntry[] = [];
  let current: { value: string; desc: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    goals.push({
      value: current.value,
      description: collapseWhitespace(current.desc.join(' ')),
    });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\[(INFO|WARNING|ERROR)\]/.test(line)) continue;

    // Goal header: "<prefix>:<name>" at column 0, no leading whitespace.
    const header = /^([a-z][\w.-]*):([A-Za-z][\w.-]*)\s*$/.exec(line);
    if (header) {
      flush();
      current = { value: `${header[1]}:${header[2]}`, desc: [] };
      continue;
    }

    if (!current) continue;

    // Description start: "  Description: <text>" — strip the prefix and
    // keep the rest. Subsequent indented lines extend it.
    const descStart = /^\s+Description:\s*(.*)$/.exec(line);
    if (descStart) {
      current.desc.push(descStart[1]);
      continue;
    }
    // Indented continuation of the description.
    if (/^\s+\S/.test(line) && current.desc.length > 0) {
      current.desc.push(line.trim());
      continue;
    }
    // Blank line or un-indented non-header → end of this goal's block.
    if (line.trim() === '' && current.desc.length > 0) {
      flush();
    }
  }
  flush();

  // help:describe sometimes repeats a wrapper "plugin:help" line at the
  // top with no description; drop empty entries.
  return goals.filter(g => g.value && g.description !== undefined);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

interface RunOpts { cwd: string; env?: Record<string, string>; timeoutMs: number }

function runAndCollect(
  command: string,
  args: string[],
  opts: RunOpts,
): Promise<string | null> {
  return new Promise(resolve => {
    const child = cp.spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows-compatible PATH resolution (.bat / .cmd).
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', b => { stdout += b.toString(); });
    child.stderr?.on('data', b => { stderr += b.toString(); });

    const killer = setTimeout(() => {
      log.warn(`Maven describe: timed out after ${opts.timeoutMs}ms — killing`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(null);
    }, opts.timeoutMs);

    child.on('error', e => {
      clearTimeout(killer);
      log.warn(`Maven describe: spawn failed: ${e.message}`);
      resolve(null);
    });

    child.on('exit', code => {
      clearTimeout(killer);
      if (code !== 0) {
        log.debug(`Maven describe: exited with ${code}. stderr tail: ${stderr.slice(-300)}`);
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}
