import * as vscode from 'vscode';
import * as cp from 'child_process';
import { pathSeparator } from './suggestClasspath';
import { log } from '../../utils/logger';

export interface RecomputeArgs {
  projectRoot: vscode.Uri;
  buildTool: 'maven' | 'gradle';
  gradleCommand: './gradlew' | 'gradle';
  jdkPath: string;  // optional; sets JAVA_HOME for the build tool
}

// Resolves to a classpath string. Times out after 30 seconds.
export async function recomputeClasspath(args: RecomputeArgs): Promise<string> {
  // 1. Try Java extension first.
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
    return await mavenClasspath(args.projectRoot, args.jdkPath);
  }
  return await gradleClasspath(args.projectRoot, args.gradleCommand, args.jdkPath);
}

async function mavenClasspath(projectRoot: vscode.Uri, jdkPath: string): Promise<string> {
  const cpOut = await spawnCollect(
    'mvn',
    ['-q', 'dependency:build-classpath', '-DincludeScope=runtime', '-Dmdep.outputFile=/dev/stdout'],
    projectRoot.fsPath,
    jdkPath,
  );
  const raw = cpOut.trim();
  const classes = 'target/classes';
  return raw ? `${classes}${pathSeparator()}${raw}` : classes;
}

async function gradleClasspath(
  projectRoot: vscode.Uri,
  gradleCommand: './gradlew' | 'gradle',
  jdkPath: string,
): Promise<string> {
  const init = `
    allprojects {
      tasks.register('__printRuntimeClasspath') {
        doLast {
          def cp = configurations.findByName('runtimeClasspath')
          if (cp != null) {
            println cp.asPath
          } else {
            println ''
          }
        }
      }
    }
  `;
  const initFile = vscode.Uri.joinPath(projectRoot, '.vscode', 'rcm-cp-init.gradle');
  await vscode.workspace.fs.writeFile(initFile, new TextEncoder().encode(init));

  try {
    const cpOut = await spawnCollect(
      gradleCommand,
      ['-q', '--init-script', initFile.fsPath, '__printRuntimeClasspath'],
      projectRoot.fsPath,
      jdkPath,
    );
    const raw = cpOut.split('\n').pop()?.trim() ?? '';
    const classes = 'build/classes/java/main';
    return raw ? `${classes}${pathSeparator()}${raw}` : classes;
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
