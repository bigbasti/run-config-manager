import * as vscode from 'vscode';

// Returns a list of Gradle and Maven install directories (each should contain
// `bin/gradle` or `bin/mvn`). Caller is responsible for the path join.
//
// Sources probed:
//   1. $GRADLE_HOME / $MAVEN_HOME if set.
//   2. /opt/{gradle,maven}/*
//   3. /usr/share/{gradle*,maven*}
//   4. /usr/lib/{gradle*,maven*}
//   5. $HOME/.sdkman/candidates/{gradle,maven}/*
//   6. Windows common install paths.
//
// Results are deduped preserving first-seen order.

export interface BuildToolDetection {
  gradleInstalls: string[];
  mavenInstalls: string[];
}

export async function detectBuildTools(): Promise<BuildToolDetection> {
  const gradle: string[] = [];
  const maven: string[] = [];

  pushEnv(gradle, process.env.GRADLE_HOME, 'bin/gradle');
  pushEnv(maven, process.env.MAVEN_HOME, 'bin/mvn');
  pushEnv(maven, process.env.M2_HOME, 'bin/mvn');

  // Linux/macOS conventional locations.
  const gradleRoots = [
    '/opt/gradle',
    '/usr/share',
    '/usr/lib',
    ...(process.env.HOME ? [`${process.env.HOME}/.sdkman/candidates/gradle`] : []),
  ];
  const mavenRoots = [
    '/opt/maven',
    '/usr/share',
    '/usr/lib',
    ...(process.env.HOME ? [`${process.env.HOME}/.sdkman/candidates/maven`] : []),
  ];
  // Windows common install paths.
  const winGradleRoots = ['C:\\Program Files\\Gradle', 'C:\\gradle'];
  const winMavenRoots = ['C:\\Program Files\\Apache\\Maven', 'C:\\Program Files\\Apache', 'C:\\maven'];

  await probe(gradle, gradleRoots, /^(gradle[-_]?|$)/i, 'bin/gradle');
  await probe(maven, mavenRoots, /^(apache-)?maven/i, 'bin/mvn');
  await probe(gradle, winGradleRoots, /.*/, 'bin/gradle.bat');
  await probe(maven, winMavenRoots, /.*/, 'bin/mvn.cmd');

  return { gradleInstalls: dedupe(gradle), mavenInstalls: dedupe(maven) };
}

function pushEnv(out: string[], path: string | undefined, relExec: string) {
  if (!path) return;
  out.push(path); // stat happens later; we don't over-filter here
  void relExec; // reserved for future binary checks
}

async function probe(
  out: string[],
  roots: string[],
  nameFilter: RegExp,
  relExec: string,
): Promise<void> {
  for (const root of roots) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
    } catch {
      continue;
    }
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) continue;
      if (!nameFilter.test(name)) continue;
      const candidate = `${root}/${name}`;
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(`${candidate}/${relExec}`));
        out.push(candidate);
      } catch { /* skip */ }
    }
  }
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
