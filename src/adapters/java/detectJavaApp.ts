import * as vscode from 'vscode';
import type { JavaBuildTool } from '../../shared/types';

export interface JavaAppInfo {
  // Maven/Gradle when a build file is present; null when the project is a
  // bare source tree with a main method but no build tool. In that case the
  // adapter defaults to java-main launch mode.
  buildTool: JavaBuildTool | null;
  // True when build.gradle[.kts] applies the `application` plugin or contains
  // an `application { }` block — prerequisite for the `run` task.
  hasApplicationPlugin: boolean;
  hasMainClass: boolean;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

// Fast gate: filesystem stats + reading the build file. Never walks source
// directories — keep this <100ms on realistic projects. Intended for the
// streaming-detection path where we must return the build-tool verdict
// immediately and let slower probes (main classes, classpath) fill in later.
//
// Returns null when either no build file + no source dir, or when a more
// specific adapter should own the config. Does NOT verify that a main class
// exists; callers that need that run findMainClasses themselves.
export async function detectJavaApp(folder: vscode.Uri): Promise<JavaAppInfo | null> {
  const hasPom = await exists(vscode.Uri.joinPath(folder, 'pom.xml'));
  const hasGradleKts = await exists(vscode.Uri.joinPath(folder, 'build.gradle.kts'));
  const hasGradle = hasGradleKts || (await exists(vscode.Uri.joinPath(folder, 'build.gradle')));
  const hasBuildFile = hasPom || hasGradle;
  const hasSrcMainJava = await exists(vscode.Uri.joinPath(folder, 'src/main/java'));
  const hasSrcMainKotlin = await exists(vscode.Uri.joinPath(folder, 'src/main/kotlin'));

  // Need at least a build file OR a Java/Kotlin source tree. Bare directories
  // aren't Java-ish enough to surface a config.
  if (!hasBuildFile && !hasSrcMainJava && !hasSrcMainKotlin) return null;

  let buildText = '';
  if (hasBuildFile) {
    const uri = hasPom
      ? vscode.Uri.joinPath(folder, 'pom.xml')
      : hasGradleKts
      ? vscode.Uri.joinPath(folder, 'build.gradle.kts')
      : vscode.Uri.joinPath(folder, 'build.gradle');
    buildText = (await readText(uri)) ?? '';
  }

  // Skip when a more-specific adapter should own the config.
  if (/spring-boot-starter|spring-boot-maven-plugin|org\.springframework\.boot/i.test(buildText)) {
    return null;
  }
  if (/io\.quarkus|quarkus-maven-plugin/i.test(buildText)) return null;
  if (/tomcat-embed-core|org\.apache\.tomcat/i.test(buildText)) return null;

  const buildTool: JavaBuildTool | null = hasPom
    ? 'maven'
    : hasGradle
    ? 'gradle'
    : null;

  const hasApplicationPlugin =
    buildTool === 'gradle' &&
    (/(^|[\s(\[,;])application\b/m.test(buildText) ||
      /org\.gradle\.application/.test(buildText));

  // hasMainClass is reported as "probably" — true if a source tree exists;
  // the accurate answer only comes from findMainClasses, which the caller
  // runs separately on the streaming path.
  return { buildTool, hasApplicationPlugin, hasMainClass: hasSrcMainJava || hasSrcMainKotlin };
}
