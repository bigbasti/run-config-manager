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

// Resolves to a classpath string. Times out after 30 seconds.
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

  // 2. Build-tool probe.
  if (args.buildTool === 'maven') {
    return await mavenClasspath(args);
  }
  return await gradleClasspath(args);
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
  const init = `
    allprojects {
      tasks.register('__printRuntimeClasspath') {
        doLast {
          println 'RCM_CP_BEGIN'
          def ss = project.extensions.findByName('sourceSets')
          if (ss != null && ss.findByName('main') != null) {
            println ss.main.runtimeClasspath.asPath
          } else {
            def cfg = project.configurations.findByName('runtimeClasspath')
            println cfg != null ? cfg.asPath : ''
          }
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
      reject(new Error(`${command} timed out after 30s`));
    }, 30_000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}
