import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import { resolveProjectUri } from '../utils/paths';
import { gradleModulePrefix } from '../adapters/spring-boot/findBuildRoot';

// Three canonical build-actions we surface as tree children for any config
// whose underlying project is Maven or Gradle. Intentionally narrow — 99% of
// build work is clean / build / test; power users already have the
// maven-goal / gradle-task types for anything else.
export type BuildAction = 'clean' | 'build' | 'test';
export type NpmAction = 'install' | 'update' | 'prune';
// Python project actions surfaced in the right-click menu. Mirrors the
// npm shape — common dependency-management verbs the user shouldn't
// have to remember the syntax for.
//   installEditable    — `pip install -e .` for pyproject projects
//   installRequirements — `pip install -r requirements.txt`
//   upgrade            — `pip install --upgrade -e .` / `... -r requirements.txt`
//   freeze             — `pip freeze` (write current env's lockfile)
//   list               — `pip list` (read-only summary)
export type PythonAction = 'installEditable' | 'installRequirements' | 'upgrade' | 'freeze' | 'list';

export const BUILD_ACTIONS: BuildAction[] = ['clean', 'build', 'test'];
export const NPM_ACTIONS: NpmAction[] = ['install', 'update', 'prune'];
export const PYTHON_ACTIONS: PythonAction[] = [
  'installEditable', 'installRequirements', 'upgrade', 'freeze', 'list',
];

export function buildActionLabel(action: BuildAction): string {
  switch (action) {
    case 'clean': return 'Clean';
    case 'build': return 'Build';
    case 'test':  return 'Test';
  }
}

export function npmActionLabel(action: NpmAction): string {
  switch (action) {
    case 'install': return 'Install';
    case 'update':  return 'Update';
    case 'prune':   return 'Prune';
  }
}

export function pythonActionLabel(action: PythonAction): string {
  switch (action) {
    case 'installEditable':     return 'Install (editable)';
    case 'installRequirements': return 'Install requirements';
    case 'upgrade':             return 'Upgrade dependencies';
    case 'freeze':              return 'Freeze (pip freeze)';
    case 'list':                return 'List installed packages';
  }
}

// The resolved context a build-action needs to run. Null when the config
// type has no native build tool, or when it explicitly opted out (tomcat
// with buildTool === 'none', or configs missing the paths we need).
export interface BuildContext {
  tool: 'maven' | 'gradle';
  // Absolute working directory — build root for multi-module, project root
  // otherwise.
  cwd: string;
  // Gradle only: `:module` prefix when the project sits inside a multi-module
  // reactor (buildRoot !== projectPath). Empty string otherwise.
  modulePrefix: string;
  // The binary to invoke: './gradlew', 'gradle', or 'mvn', optionally with
  // a full path when gradlePath / mavenPath is set.
  binary: string;
  // Extra env vars (JAVA_HOME when jdkPath is set) so the build tool uses
  // the JDK the user picked on the config.
  env: Record<string, string>;
}

// Figure out how to drive the given config's build tool. Returns null when
// the config isn't driveable (npm / docker / custom-command / tomcat-none).
export function resolveBuildContext(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): BuildContext | null {
  // All JVM types carry the same subset of fields — project path, buildRoot,
  // gradle/maven binary selections — so we read them uniformly via `to`.
  // Types without a build tool return null at the top of each branch.
  if (cfg.type === 'npm' || cfg.type === 'custom-command' || cfg.type === 'docker') {
    return null;
  }

  const to = cfg.typeOptions as {
    buildTool?: string;
    gradleCommand?: string;
    gradlePath?: string;
    mavenPath?: string;
    buildRoot?: string;
    buildProjectPath?: string;   // tomcat only
    jdkPath?: string;
  };

  if (cfg.type === 'tomcat' && to.buildTool === 'none') return null;
  if (cfg.type === 'java') {
    // Java "-custom" modes drive the tool directly from user-typed args;
    // Clean/Build/Test shortcuts still apply to the underlying project.
    // java-main has no build tool inference; we fall back to whatever
    // buildTool the user picked (maven / gradle via the form), but skip if
    // they left it unset.
    if (!to.buildTool) return null;
  }

  const tool = toBuildTool(to.buildTool);
  if (!tool) return null;

  // Resolve project path under the workspace folder. Tomcat uses
  // `buildProjectPath` (the thing being built) rather than `projectPath`
  // (the app being deployed).
  const projectPath = cfg.type === 'tomcat'
    ? (to.buildProjectPath || cfg.projectPath)
    : cfg.projectPath;
  const projectAbs = resolveProjectUri(folder, projectPath).fsPath;

  // cwd: buildRoot when set (multi-module); otherwise the project itself.
  // Matches ExecutionService.buildCwd precedence for the runtime path.
  const cwd = to.buildRoot && to.buildRoot.trim() ? to.buildRoot : projectAbs;

  const modulePrefix = tool === 'gradle' && to.buildRoot
    ? gradleModulePrefix(to.buildRoot, projectAbs)
    : '';

  const binary = resolveBinary(tool, to);
  const env: Record<string, string> = {};
  if (to.jdkPath) env.JAVA_HOME = to.jdkPath;

  return { tool, cwd, modulePrefix, binary, env };
}

// Given a context and an action, produce the argv the shell task will run.
// Separate from resolveBuildContext so callers that want to show the user
// the command (tooltip, logs, tests) can format it without having to spawn.
export function buildCommandFor(ctx: BuildContext, action: BuildAction): string[] {
  if (ctx.tool === 'maven') {
    switch (action) {
      case 'clean': return ['clean'];
      // `package` without tests is the fastest way to produce an artifact;
      // users who WANT tests use the test action.
      case 'build': return ['package', '-DskipTests'];
      case 'test':  return ['test'];
    }
  }
  // Gradle — prefix every task with the module when we have one.
  const prefix = ctx.modulePrefix ? `${ctx.modulePrefix}:` : '';
  switch (action) {
    case 'clean': return ['--console=plain', `${prefix}clean`];
    // `assemble` builds everything without running tests. `build` would
    // run tests too and clash with the separate "Test" action.
    case 'build': return ['--console=plain', `${prefix}assemble`];
    case 'test':  return ['--console=plain', `${prefix}test`];
  }
}

// npm project context — resolved the same way as BuildContext but simpler:
// just the package manager binary and the project directory.
export interface NpmContext {
  packageManager: 'npm' | 'yarn' | 'pnpm';
  cwd: string;
}

export function resolveNpmContext(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): NpmContext | null {
  if (cfg.type !== 'npm') return null;
  const pm = cfg.typeOptions.packageManager ?? 'npm';
  if (pm !== 'npm' && pm !== 'yarn' && pm !== 'pnpm') return null;
  const cwd = resolveProjectUri(folder, cfg.projectPath).fsPath;
  return { packageManager: pm, cwd };
}

export function npmCommandFor(ctx: NpmContext, action: NpmAction): string[] {
  // All three package managers share the same verb for these operations.
  return [action];
}

// Resolved context a python action needs to run. Mirrors NpmContext —
// the cwd is the resolved project root, the pythonPath is the install
// directory the user picked (empty string = use python3 on PATH).
// `manifestKind` tells the caller which install command applies.
export interface PythonContext {
  pythonPath: string;
  cwd: string;
  // Which manifest the project uses. 'pyproject' / 'requirements' /
  // 'pyproject+requirements' / 'none' — picked by checking which files
  // exist in cwd. Used to gate which actions the menu offers.
  manifestKind: 'pyproject' | 'requirements' | 'pyproject+requirements' | 'none';
}

export function resolvePythonContext(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): PythonContext | null {
  if (cfg.type !== 'python') return null;
  const cwd = resolveProjectUri(folder, cfg.projectPath).fsPath;
  // Detect manifest synchronously — these are tiny stat calls and the
  // tree provider needs the result on every render.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const hasPyproject = fileExists(fs, path.join(cwd, 'pyproject.toml'));
  const hasRequirements = fileExists(fs, path.join(cwd, 'requirements.txt'));
  let manifestKind: PythonContext['manifestKind'] = 'none';
  if (hasPyproject && hasRequirements) manifestKind = 'pyproject+requirements';
  else if (hasPyproject) manifestKind = 'pyproject';
  else if (hasRequirements) manifestKind = 'requirements';
  return {
    pythonPath: cfg.typeOptions.pythonPath ?? '',
    cwd,
    manifestKind,
  };
}

// Returns the args to pass to `<py> ...args`. The caller spawns the
// python binary directly — the command line is `<py> -m pip ...`.
export function pythonCommandFor(ctx: PythonContext, action: PythonAction): string[] {
  switch (action) {
    case 'installEditable':
      // `pip install -e .` — pyproject editable install. Use this when
      // the project has a `[project]` table.
      return ['-m', 'pip', 'install', '-e', '.'];
    case 'installRequirements':
      return ['-m', 'pip', 'install', '-r', 'requirements.txt'];
    case 'upgrade':
      // Upgrade in-place. For pyproject layouts, `--upgrade -e .`
      // pulls fresh versions of declared deps. For requirements layouts,
      // `--upgrade -r requirements.txt`.
      return ctx.manifestKind === 'requirements'
        ? ['-m', 'pip', 'install', '--upgrade', '-r', 'requirements.txt']
        : ['-m', 'pip', 'install', '--upgrade', '-e', '.'];
    case 'freeze':
      return ['-m', 'pip', 'freeze'];
    case 'list':
      return ['-m', 'pip', 'list'];
  }
}

// ---------------------------------------------------------------------------
// Go actions — surfaced as right-click menu entries on Go configs.
// ---------------------------------------------------------------------------

export type GoAction = 'modTidy' | 'modDownload' | 'build' | 'test';
export const GO_ACTIONS: GoAction[] = ['modTidy', 'modDownload', 'build', 'test'];

export function goActionLabel(action: GoAction): string {
  switch (action) {
    case 'modTidy':     return 'go mod tidy';
    case 'modDownload': return 'go mod download';
    case 'build':       return 'go build ./...';
    case 'test':        return 'go test ./...';
  }
}

// Resolved context a Go action needs. The goPath is the installation root;
// binary is the resolved `go` executable path.
export interface GoContext {
  cwd: string;
  binary: string; // 'go' or '<goPath>/bin/go'
}

export function resolveGoContext(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): GoContext | null {
  if (cfg.type !== 'go') return null;
  const cwd = resolveProjectUri(folder, cfg.projectPath).fsPath;
  const goPath = cfg.typeOptions.goPath?.trim();
  const binary = goPath
    ? require('path').join(goPath.replace(/[/\\]$/, ''), 'bin', process.platform === 'win32' ? 'go.exe' : 'go') as string
    : 'go';
  return { cwd, binary };
}

// Returns the args to pass to `<go> ...args`. The caller spawns the go binary.
export function goCommandFor(ctx: GoContext, action: GoAction): string[] {
  switch (action) {
    case 'modTidy':     return ['mod', 'tidy'];
    case 'modDownload': return ['mod', 'download'];
    case 'build':       return ['build', './...'];
    case 'test':        return ['test', './...'];
  }
}

function fileExists(fs: typeof import('fs'), p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function toBuildTool(v: string | undefined): 'maven' | 'gradle' | null {
  if (v === 'maven' || v === 'gradle') return v;
  return null;
}

function resolveBinary(
  tool: 'maven' | 'gradle',
  to: { gradleCommand?: string; gradlePath?: string; mavenPath?: string },
): string {
  if (tool === 'maven') {
    return to.mavenPath
      ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn`
      : 'mvn';
  }
  // Gradle: prefer the wrapper when the user picked it, otherwise system
  // gradle via gradlePath or PATH.
  if (to.gradleCommand === './gradlew') return './gradlew';
  if (to.gradlePath) return `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle`;
  return 'gradle';
}
