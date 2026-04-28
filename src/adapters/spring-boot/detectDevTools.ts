import * as vscode from 'vscode';

// Probes whether the project has `spring-boot-devtools` declared as a
// dependency. Used by the form to warn the user when they enable Rebuild on
// save without DevTools on the classpath — the watcher will then keep
// rebuilding but the running app will never hot-reload.
//
// Returns false when the build file can't be read (missing / parse error),
// so absence is treated as "unknown but probably missing" and surfaces the
// hint. That's the right bias — a spurious warning when DevTools actually
// IS present is far cheaper than silently letting hot-reload fail.
export async function hasSpringBootDevTools(folder: vscode.Uri): Promise<boolean> {
  // Gradle first (most common for Spring Boot projects we detect).
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const text = await readFile(vscode.Uri.joinPath(folder, name));
    if (text && gradleDeclaresDevTools(text)) return true;
  }
  // Maven: the devtools artifact appears as a dependency (optional or
  // scoped as `runtime`). String-match the artifactId — we don't need a
  // real XML parser for this signal.
  const pom = await readFile(vscode.Uri.joinPath(folder, 'pom.xml'));
  if (pom && pomDeclaresDevTools(pom)) return true;
  return false;
}

function gradleDeclaresDevTools(text: string): boolean {
  // Matches the typical patterns:
  //   developmentOnly 'org.springframework.boot:spring-boot-devtools'
  //   developmentOnly("org.springframework.boot:spring-boot-devtools")
  //   runtimeOnly 'org.springframework.boot:spring-boot-devtools'
  //   implementation 'org.springframework.boot:spring-boot-devtools'
  // (we don't care which scope — if it's there, DevTools reaches the classpath)
  return /spring-boot-devtools/.test(text);
}

function pomDeclaresDevTools(text: string): boolean {
  // Plain substring check is robust enough — the artifactId only appears
  // in a <dependency> block. Users who list it in a comment will trigger
  // a false positive, but that's a non-issue (their comment presumably
  // means they're aware of the dependency).
  return /<artifactId>\s*spring-boot-devtools\s*<\/artifactId>/i.test(text);
}

async function readFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}
