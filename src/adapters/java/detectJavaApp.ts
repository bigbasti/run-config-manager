import * as vscode from 'vscode';
import type { JavaBuildTool } from '../../shared/types';
import { findMainClasses } from '../java-shared/findMainClasses';

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

// Detects a plain Java project. Returns null when Spring Boot / Quarkus /
// embedded-Tomcat markers are found — those adapters take priority, and the
// user should use them instead (auto-create respects the same precedence).
export async function detectJavaApp(folder: vscode.Uri): Promise<JavaAppInfo | null> {
  const hasPom = await exists(vscode.Uri.joinPath(folder, 'pom.xml'));
  const hasGradleKts = await exists(vscode.Uri.joinPath(folder, 'build.gradle.kts'));
  const hasGradle = hasGradleKts || (await exists(vscode.Uri.joinPath(folder, 'build.gradle')));
  const hasBuildFile = hasPom || hasGradle;

  let buildText = '';
  if (hasBuildFile) {
    const uri = hasPom
      ? vscode.Uri.joinPath(folder, 'pom.xml')
      : hasGradleKts
      ? vscode.Uri.joinPath(folder, 'build.gradle.kts')
      : vscode.Uri.joinPath(folder, 'build.gradle');
    buildText = (await readText(uri)) ?? '';
  }

  // Skip when a more-specific adapter should own the config. Each of these is
  // a strong signal handled upstream: Spring Boot, Quarkus, or an embedded
  // Tomcat / Spring webapp layout.
  if (/spring-boot-starter|spring-boot-maven-plugin|org\.springframework\.boot/i.test(buildText)) {
    return null;
  }
  if (/io\.quarkus|quarkus-maven-plugin/i.test(buildText)) return null;
  if (/tomcat-embed-core|org\.apache\.tomcat/i.test(buildText)) return null;

  // Main class probe. Capped by findMainClasses's internal limits.
  const mainClasses = await findMainClasses(folder);
  const hasMainClass = mainClasses.length > 0;

  // Need at least one of: a build file OR a main class. Bare directories
  // without either aren't Java-ish enough to surface a config.
  if (!hasBuildFile && !hasMainClass) return null;

  const buildTool: JavaBuildTool | null = hasPom
    ? 'maven'
    : hasGradle
    ? 'gradle'
    : null;

  const hasApplicationPlugin =
    buildTool === 'gradle' &&
    (/(^|[\s(\[,;])application\b/m.test(buildText) ||
      /org\.gradle\.application/.test(buildText));

  return { buildTool, hasApplicationPlugin, hasMainClass };
}
