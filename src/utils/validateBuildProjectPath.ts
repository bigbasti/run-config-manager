import * as vscode from 'vscode';
import * as path from 'path';

export type BuildTool = 'maven' | 'gradle' | 'either';

export interface BuildPathOk {
  ok: true;
}

export interface BuildPathIssue {
  ok: false;
  // Short user-facing reason for the warning line in the editor.
  reason: string;
  // Relative path (from the workspace folder root) that WOULD work, or
  // undefined if no ancestor within the workspace folder qualifies.
  // Webview renders this as a "Use parent" button.
  suggestion?: string;
}

export type BuildPathValidation = BuildPathOk | BuildPathIssue;

// Validates that the given projectPath (relative to the workspace folder)
// contains a Maven / Gradle project that the corresponding build tool
// can drive. Walks up ancestors when invalid to suggest the nearest
// parent that would work — covers the common "selected a submodule
// accidentally" case.
//
// `buildTool` values:
//   - 'maven'  → requires a pom.xml.
//   - 'gradle' → requires build.gradle[.kts] OR a settings.gradle[.kts]
//                in an ancestor that declares the directory as a module.
//   - 'either' → either of the above is acceptable (used by tomcat/java
//                when the user hasn't committed to a build tool yet).
//
// Returns {ok:true} when valid. Otherwise {ok:false, reason, suggestion?}.
// Suggestions are relative to the workspace folder; empty string means
// "the workspace folder root itself".
export async function validateBuildProjectPath(
  folder: vscode.WorkspaceFolder,
  projectPath: string,
  buildTool: BuildTool,
): Promise<BuildPathValidation> {
  const workspaceRoot = folder.uri.fsPath;
  const resolved = projectPath.trim()
    ? path.resolve(workspaceRoot, projectPath)
    : workspaceRoot;

  // Refuse to walk outside the workspace — a projectPath like "../.." is
  // most likely a typo or paste error; we won't try to suggest a fix
  // outside the user's own workspace.
  if (!isInsideOrEqual(resolved, workspaceRoot)) {
    return {
      ok: false,
      reason: `Path resolves outside the workspace folder (${resolved}). Did you paste an absolute path by mistake?`,
    };
  }

  // First check: is this a Gradle/Maven root (wrapper + settings) or a
  // Maven module (pom.xml)? If so → immediately valid.
  if (await hasBuildFile(resolved, buildTool, false)) {
    return { ok: true };
  }

  // Second check (Gradle sub-module pattern): does this directory have a
  // build.gradle[.kts] AND is there an ancestor with the Gradle root
  // (wrapper / settings)? Adapters handle this by walking up via
  // findGradleRoot, computing a :<module>:task prefix, and running from the
  // ancestor's cwd — so the user's choice of a submodule dir is correct
  // and shouldn't warn.
  if (buildTool === 'gradle' || buildTool === 'either') {
    if (await hasBuildFile(resolved, buildTool, true)) {
      // The dir has a build.gradle but no local wrapper — check if an
      // ancestor has the root. If so, the adapters can resolve it.
      const gradleRoot = await findAncestorWithBuildFile(resolved, workspaceRoot, 'gradle');
      if (gradleRoot !== null) {
        return { ok: true };
      }
    }
  }

  // Walk up looking for the nearest ancestor with a build file — stop at
  // the workspace folder root.
  const suggestion = await findAncestorWithBuildFile(resolved, workspaceRoot, buildTool);

  const toolLabel = buildTool === 'maven' ? 'Maven (pom.xml)'
    : buildTool === 'gradle' ? 'Gradle (build.gradle / gradlew)'
    : 'Maven or Gradle';

  if (suggestion !== null) {
    const rel = path.relative(workspaceRoot, suggestion);
    return {
      ok: false,
      reason: `No ${toolLabel} project found here.`,
      suggestion: rel,
    };
  }
  return {
    ok: false,
    reason: `No ${toolLabel} project found at this path (or any parent within the workspace).`,
  };
}

// Second parameter: when true, also accept build.gradle[.kts] without a
// wrapper/settings, because the caller will do a separate ancestor walk
// that validates the whole multi-module setup. Default false for the
// ancestor-walk helper itself (it only cares about roots).
async function hasBuildFile(
  dir: string,
  buildTool: BuildTool,
  acceptGradleSubmodule = false,
): Promise<boolean> {
  const hasFile = async (name: string) => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, name)));
      return true;
    } catch {
      return false;
    }
  };

  if (buildTool === 'maven' || buildTool === 'either') {
    // pom.xml at any level is runnable on its own — Maven resolves parent
    // POMs from <relativePath>, and `mvn` invoked from a submodule still
    // works even when a reactor pom lives higher.
    if (await hasFile('pom.xml')) return true;
  }
  if (buildTool === 'gradle' || buildTool === 'either') {
    // Gradle root markers: wrapper OR settings.
    if (await hasFile('gradlew')) return true;
    if (await hasFile('settings.gradle')) return true;
    if (await hasFile('settings.gradle.kts')) return true;
    // Submodule: build.gradle[.kts] without a local wrapper/settings. The
    // adapters' findGradleRoot + gradleModulePrefix handle this by walking
    // up and running from the root with a :<module>:task prefix. We accept
    // it here when the caller explicitly opts in (top-level validation).
    if (acceptGradleSubmodule) {
      if (await hasFile('build.gradle')) return true;
      if (await hasFile('build.gradle.kts')) return true;
    }
  }
  return false;
}

// Walk up from `start` toward (but not past) `workspaceRoot`, returning
// the nearest directory with a build file or null. Stops at
// workspaceRoot (inclusive) so we don't leak hints about whatever lives
// above the user's workspace.
async function findAncestorWithBuildFile(
  start: string,
  workspaceRoot: string,
  buildTool: BuildTool,
): Promise<string | null> {
  let cur = path.dirname(start);
  for (let i = 0; i < 20; i++) {
    if (!isInsideOrEqual(cur, workspaceRoot)) return null;
    if (await hasBuildFile(cur, buildTool)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // hit filesystem root
    cur = parent;
  }
  return null;
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  // path.relative returns '' for equal paths, '..' (possibly with more)
  // when child is outside parent, and a non-'..' path when child is inside.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
