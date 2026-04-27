import * as vscode from 'vscode';
import * as cp from 'child_process';
import { pathSeparator } from './suggestClasspath';
import { gradleModulePrefix } from './findBuildRoot';
import { log } from '../../utils/logger';

export interface RecomputeArgs {
  projectRoot: vscode.Uri;       // submodule we care about (for classpath output)
  buildRoot: vscode.Uri;         // where to invoke the build tool (may equal projectRoot)
  buildTool: 'maven' | 'gradle';
  gradleCommand: './gradlew' | 'gradle';
  gradlePath: string;            // install dir; used when gradleCommand === 'gradle'
  mavenPath: string;             // install dir; used for 'mvn' binary
  jdkPath: string;               // sets JAVA_HOME for the build tool
}

// Error subclass so the UI can give a tailored "retry this — Gradle is slow
// to warm up" hint instead of the generic classpath-failed message. Carries
// the partial stderr we collected so users still see Gradle's actual output
// when they open the Output channel.
export class RecomputeTimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
    public readonly partialStderr: string,
  ) {
    super(
      `${command} did not finish within ${Math.round(timeoutMs / 1000)}s. ` +
      `The Gradle/Maven daemon is probably starting up for the first time — ` +
      `this can take 60-120 s on a cold build. Click "Recompute classpath" ` +
      `again; the daemon will be warm from this attempt and the retry usually ` +
      `finishes in a few seconds. ` +
      (partialStderr.trim() ? `\n\nLast output:\n${partialStderr.slice(-800)}` : ''),
    );
    this.name = 'RecomputeTimeoutError';
  }
}

// Resolves to a classpath string. Times out after 90 seconds — generous
// enough for a cold daemon + full dependency resolution on a typical multi-
// module project. A hard failure wraps the partial stderr in a
// RecomputeTimeoutError so the UI can offer a retry-specific hint.
export async function recomputeClasspath(args: RecomputeArgs): Promise<string> {
  // 1. Try Java extension first — it knows the whole project graph.
  try {
    const ext = vscode.extensions.getExtension('redhat.java');
    if (ext) {
      const api = await ext.activate();
      if (api && typeof (api as any).getClasspath === 'function') {
        const out = await (api as any).getClasspath(args.projectRoot.fsPath);
        if (Array.isArray(out) && out.length) return out.join(pathSeparator());
      }
    }
  } catch (e) {
    log.warn(`Java extension classpath API failed: ${(e as Error).message}`);
  }

  // 2. Build-tool probe. Before trusting typeOptions.buildTool (which may be
  // a stale 'maven' from an earlier detection path), verify against the actual
  // files at buildRoot. If the claimed build tool doesn't match reality,
  // swap to the one that does — this rescues configs created before the
  // streaming-detect fix.
  const effective = await detectEffectiveBuildTool(args.buildRoot, args.buildTool);
  if (effective !== args.buildTool) {
    log.warn(`buildTool was ${args.buildTool} but ${args.buildRoot.fsPath} looks like ${effective}; using ${effective}.`);
  }
  if (effective === 'maven') {
    return await mavenClasspath(args);
  }
  return await gradleClasspath({ ...args, buildTool: 'gradle' });
}

async function detectEffectiveBuildTool(
  root: vscode.Uri,
  claimed: 'maven' | 'gradle',
): Promise<'maven' | 'gradle'> {
  const hasPom = await fileExists(vscode.Uri.joinPath(root, 'pom.xml'));
  const hasGradle =
    (await fileExists(vscode.Uri.joinPath(root, 'build.gradle'))) ||
    (await fileExists(vscode.Uri.joinPath(root, 'build.gradle.kts')));
  // Prefer the claimed tool when both markers exist (users who ran polyglot
  // builds know what they want). Otherwise use whatever's actually there.
  if (hasPom && hasGradle) return claimed;
  if (hasPom) return 'maven';
  if (hasGradle) return 'gradle';
  // Neither marker — fall back to the claim and let the command fail with a
  // clear error.
  return claimed;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function mavenClasspath(args: RecomputeArgs): Promise<string> {
  const mvn = args.mavenPath ? `${args.mavenPath.replace(/[/\\]$/, '')}/bin/mvn` : 'mvn';
  // Run from the submodule dir — maven resolves the reactor parent on its own.
  // dependency:build-classpath only prints external deps, so we also add the
  // absolute path to target/classes (which contains compiled classes AND
  // resources — resources end up flattened into the same dir after `mvn
  // process-resources`).
  const cpOut = await spawnCollect(
    mvn,
    ['-q', 'dependency:build-classpath', '-DincludeScope=runtime', '-Dmdep.outputFile=/dev/stdout'],
    args.projectRoot.fsPath,
    args.jdkPath,
  );
  const deps = cpOut.trim();
  const classes = `${args.projectRoot.fsPath}/target/classes`;
  return deps ? `${classes}${pathSeparator()}${deps}` : classes;
}

async function gradleClasspath(args: RecomputeArgs): Promise<string> {
  // Register a task that prints the FULL runtime classpath for the CURRENT
  // project, matching what `java -cp` would need to actually launch. We use
  // sourceSets.main.runtimeClasspath (not configurations.runtimeClasspath)
  // because that includes:
  //   - build/classes/java/main        (compiled classes)
  //   - build/resources/main           (application-*.properties etc)
  //   - sibling-module outputs         (project dependencies resolved)
  //   - external JAR dependencies
  // The configurations-only variant misses resources dirs and sibling modules
  // in multi-module projects — Spring Boot then can't find the profile
  // properties even when the profile is marked active.
  // IMPORTANT: Configuration-cache-safe. The init script used to read
  // `project.extensions` / `project.configurations` inside `doLast {}`, which
  // Gradle 8+ rejects when configuration caching is on:
  //   "Invocation of 'Task.project' by task '…' at execution time is
  //    unsupported with the configuration cache."
  //
  // Fix: resolve the classpath at CONFIGURATION time and stash it on a
  // FileCollection / Provider the task reads at execution time. That keeps
  // the project-object access out of the execution path entirely.
  const init = `
    allprojects {
      def __runtimeCp = project.files({
        def ss = project.extensions.findByName('sourceSets')
        if (ss != null && ss.findByName('main') != null) {
          return ss.main.runtimeClasspath
        }
        def cfg = project.configurations.findByName('runtimeClasspath')
        return cfg != null ? cfg : project.files()
      })
      tasks.register('__printRuntimeClasspath') {
        inputs.files(__runtimeCp)
        def cpPathProvider = project.provider { __runtimeCp.asPath }
        doLast {
          println 'RCM_CP_BEGIN'
          println cpPathProvider.get()
          println 'RCM_CP_END'
        }
      }
    }
  `;
  // Write the init script somewhere user-writable. We use the project's .vscode
  // dir since that's guaranteed to be writable if run.json lives there.
  const initFile = vscode.Uri.joinPath(args.projectRoot, '.vscode', 'rcm-cp-init.gradle');
  await vscode.workspace.fs.writeFile(initFile, new TextEncoder().encode(init));

  // Compute the Gradle task path. For multi-module projects where buildRoot !=
  // projectRoot, we want `:api:__printRuntimeClasspath`. For a single-module
  // project we want the unqualified task name.
  const prefix = gradleModulePrefix(args.buildRoot.fsPath, args.projectRoot.fsPath);
  const taskName = prefix
    ? `${prefix}:__printRuntimeClasspath`
    : '__printRuntimeClasspath';

  // Pick binary: prefer wrapper when user chose it; otherwise gradlePath/bin.
  const gradleBinary =
    args.gradleCommand === './gradlew'
      ? './gradlew'
      : args.gradlePath
      ? `${args.gradlePath.replace(/[/\\]$/, '')}/bin/gradle`
      : 'gradle';

  try {
    const cpOut = await spawnCollect(
      gradleBinary,
      ['-q', '--console=plain', '--init-script', initFile.fsPath, taskName],
      args.buildRoot.fsPath,
      args.jdkPath,
    );
    // Extract between sentinels so we don't pick up stray log output.
    const m = cpOut.match(/RCM_CP_BEGIN\s*\n([\s\S]*?)\n?RCM_CP_END/);
    const raw = (m?.[1] ?? '').trim();
    // sourceSets.main.runtimeClasspath already contains build/classes/java/main
    // and build/resources/main as absolute paths — no prepending needed.
    return raw || 'build/classes/java/main';
  } finally {
    try {
      await vscode.workspace.fs.delete(initFile);
    } catch { /* ignore */ }
  }
}

const RECOMPUTE_TIMEOUT_MS = 90_000;

function spawnCollect(
  command: string,
  args: string[],
  cwd: string,
  jdkPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (jdkPath) env.JAVA_HOME = jdkPath;
    const child = cp.spawn(command, args, { cwd, env, shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new RecomputeTimeoutError(command, RECOMPUTE_TIMEOUT_MS, stderr));
    }, RECOMPUTE_TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}
