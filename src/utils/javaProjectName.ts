import * as vscode from 'vscode';
import { resolveProjectUri } from './paths';

// Resolves the project name that vscode-java-debug needs for expression
// evaluation and conditional breakpoints. The redhat Java language server
// names a project after its Maven <artifactId> (or its Gradle project name);
// when the workspace holds more than one Java project the debugger refuses to
// evaluate without a `projectName` ("Cannot evaluate, please specify
// projectName in launch.json"). We therefore derive it from the project's own
// build file rather than leaving it empty.
//
// Best-effort: returns the project directory name when no build metadata is
// readable. A wrong name only degrades back to the original "specify
// projectName" failure, never something worse.
export async function resolveJavaProjectName(
  folder: vscode.WorkspaceFolder,
  projectPath: string,
): Promise<string> {
  const projectUri = resolveProjectUri(folder, projectPath);

  // Maven: the JDT project name equals this module's <artifactId>.
  const pom = await readText(vscode.Uri.joinPath(projectUri, 'pom.xml'));
  if (pom) {
    const artifactId = extractMavenArtifactId(pom);
    if (artifactId) return artifactId;
  }

  // Gradle: an explicit rootProject.name wins when this dir is the build root.
  for (const settings of ['settings.gradle', 'settings.gradle.kts']) {
    const text = await readText(vscode.Uri.joinPath(projectUri, settings));
    if (text) {
      const name = extractGradleRootName(text);
      if (name) return name;
    }
  }

  // Fallback: the directory name — Gradle's default subproject name and the
  // redhat default for unmanaged folders.
  return basename(projectUri.fsPath);
}

// Pulls the module's own <artifactId>, not the parent's. The <parent> block is
// stripped first so its artifactId can't win.
function extractMavenArtifactId(pom: string): string | null {
  const withoutParent = pom.replace(/<parent>[\s\S]*?<\/parent>/, '');
  const m = withoutParent.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/);
  return m ? m[1].trim() : null;
}

function extractGradleRootName(text: string): string | null {
  const m = text.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1].trim() : null;
}

function basename(fsPath: string): string {
  return fsPath.split('/').filter(Boolean).pop() ?? '';
}

async function readText(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}
