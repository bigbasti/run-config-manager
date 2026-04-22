import * as vscode from 'vscode';
import type { JavaBuildTool } from '../../shared/types';

export interface QuarkusInfo {
  buildTool: JavaBuildTool;
  // True if we found a strong signal (io.quarkus dependency in the build file
  // or the quarkus-maven-plugin); false if only a weak signal (a quarkus.* key
  // in application.properties) triggered the match.
  strongSignal: boolean;
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

// Returns null when the folder is neither a Maven nor a Gradle project. When it
// is, returns a buildTool verdict and a flag that tells us whether we found a
// Quarkus signal at all. The adapter calls this from both detect and
// detectStreaming — callers treat null as "not Quarkus, skip".
export async function readQuarkusInfo(folder: vscode.Uri): Promise<QuarkusInfo | null> {
  const hasPom = await exists(vscode.Uri.joinPath(folder, 'pom.xml'));
  const hasGradleKts = await exists(vscode.Uri.joinPath(folder, 'build.gradle.kts'));
  const hasGradle = hasGradleKts || (await exists(vscode.Uri.joinPath(folder, 'build.gradle')));
  if (!hasPom && !hasGradle) return null;

  const buildTool: JavaBuildTool = hasPom ? 'maven' : 'gradle';

  const buildFileUri = hasPom
    ? vscode.Uri.joinPath(folder, 'pom.xml')
    : hasGradleKts
    ? vscode.Uri.joinPath(folder, 'build.gradle.kts')
    : vscode.Uri.joinPath(folder, 'build.gradle');

  const buildText = (await readText(buildFileUri)) ?? '';
  // Strong: Quarkus plugin/BOM/dependency on io.quarkus.
  const strongSignal =
    /quarkus-maven-plugin/i.test(buildText) ||
    /io\.quarkus/i.test(buildText);
  if (strongSignal) return { buildTool, strongSignal: true };

  // Weak fallback: application.properties under src/main/resources containing
  // a `quarkus.` key. Kept conservative so non-Quarkus Spring/Micronaut apps
  // with an application.properties don't get falsely matched.
  const weakSignal = await hasQuarkusPropertyKey(folder);
  if (weakSignal) return { buildTool, strongSignal: false };
  return null;
}

async function hasQuarkusPropertyKey(folder: vscode.Uri): Promise<boolean> {
  const candidates = [
    'src/main/resources/application.properties',
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
  ];
  for (const rel of candidates) {
    const text = await readText(vscode.Uri.joinPath(folder, rel));
    if (!text) continue;
    if (/^\s*quarkus\./m.test(text)) return true;
    // YAML top-level `quarkus:` block.
    if (/^\s*quarkus\s*:\s*$/m.test(text)) return true;
  }
  return false;
}
