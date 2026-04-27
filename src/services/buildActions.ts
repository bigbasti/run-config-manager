import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import { resolveProjectUri } from '../utils/paths';
import { gradleModulePrefix } from '../adapters/spring-boot/findBuildRoot';

// Three canonical build-actions we surface as tree children for any config
// whose underlying project is Maven or Gradle. Intentionally narrow — 99% of
// build work is clean / build / test; power users already have the
// maven-goal / gradle-task types for anything else.
export type BuildAction = 'clean' | 'build' | 'test';

export const BUILD_ACTIONS: BuildAction[] = ['clean', 'build', 'test'];

export function buildActionLabel(action: BuildAction): string {
  switch (action) {
    case 'clean': return 'Clean';
    case 'build': return 'Build';
    case 'test':  return 'Test';
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
