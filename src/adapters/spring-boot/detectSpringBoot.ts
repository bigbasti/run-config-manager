import * as vscode from 'vscode';
import type { JavaBuildTool } from '../../shared/types';

export interface SpringBootInfo {
  buildTool: JavaBuildTool;
  // True if we found a @SpringBootApplication annotation in any .java file
  // under common main-source roots.
  hasSpringBootApplication: boolean;
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

// Detects Spring Boot project layout in the given folder.
// Returns null when the folder doesn't look like a Java build at all.
export async function readSpringBootInfo(folder: vscode.Uri): Promise<SpringBootInfo | null> {
  const hasPom = await exists(vscode.Uri.joinPath(folder, 'pom.xml'));
  const hasGradle =
    (await exists(vscode.Uri.joinPath(folder, 'build.gradle'))) ||
    (await exists(vscode.Uri.joinPath(folder, 'build.gradle.kts')));

  if (!hasPom && !hasGradle) return null;

  const buildTool: JavaBuildTool = hasPom ? 'maven' : 'gradle';

  // Check the build file for Spring Boot references (cheap signal).
  const buildFileUri = hasPom
    ? vscode.Uri.joinPath(folder, 'pom.xml')
    : (await exists(vscode.Uri.joinPath(folder, 'build.gradle.kts')))
    ? vscode.Uri.joinPath(folder, 'build.gradle.kts')
    : vscode.Uri.joinPath(folder, 'build.gradle');

  const buildText = (await readText(buildFileUri)) ?? '';
  const buildFileMentionsSpringBoot =
    /spring-boot-starter|spring-boot-maven-plugin|org\.springframework\.boot/i.test(buildText);

  // Also probe main source for @SpringBootApplication.
  const hasAnnotation = await findSpringBootAnnotation(folder);

  const hasSpringBootApplication = buildFileMentionsSpringBoot || hasAnnotation;

  return { buildTool, hasSpringBootApplication };
}

async function findSpringBootAnnotation(folder: vscode.Uri): Promise<boolean> {
  // Search only common main-source roots; avoid full-workspace scan.
  const candidates = [
    'src/main/java',
    'src/main/kotlin',
  ];
  for (const rel of candidates) {
    const root = vscode.Uri.joinPath(folder, rel);
    if (!(await exists(root))) continue;
    if (await searchDirForAnnotation(root, 3)) return true;
  }
  return false;
}

async function searchDirForAnnotation(dir: vscode.Uri, depthBudget: number): Promise<boolean> {
  if (depthBudget < 0) return false;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return false;
  }
  for (const [name, kind] of entries) {
    const child = vscode.Uri.joinPath(dir, name);
    if (kind === vscode.FileType.File && (name.endsWith('.java') || name.endsWith('.kt'))) {
      const text = await readText(child);
      if (text && text.includes('@SpringBootApplication')) return true;
    } else if (kind === vscode.FileType.Directory) {
      if (await searchDirForAnnotation(child, depthBudget - 1)) return true;
    }
  }
  return false;
}
