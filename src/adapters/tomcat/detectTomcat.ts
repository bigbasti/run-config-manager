import * as vscode from 'vscode';

// Locate Tomcat installations by probing well-known paths and CATALINA_HOME.
// Returns a deduped list of install roots (each should contain bin/catalina.sh
// and conf/server.xml). Caller joins with bin/ scripts as needed.
export async function detectTomcatInstalls(): Promise<string[]> {
  const found: string[] = [];

  if (process.env.CATALINA_HOME) found.push(process.env.CATALINA_HOME);
  if (process.env.TOMCAT_HOME) found.push(process.env.TOMCAT_HOME);

  const roots = [
    '/opt',
    '/usr/share',
    '/usr/lib',
    '/var/lib',
    ...(process.env.HOME ? [`${process.env.HOME}/.sdkman/candidates/tomcat`] : []),
    ...(process.env.HOME ? [`${process.env.HOME}/apache-tomcat`] : []),
    // Windows common paths.
    'C:\\Program Files\\Apache Software Foundation',
    'C:\\apache-tomcat',
  ];

  for (const root of roots) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
      for (const [name, kind] of entries) {
        if (kind !== vscode.FileType.Directory) continue;
        if (!/tomcat/i.test(name)) continue;
        const candidate = `${root}/${name}`;
        if (await looksLikeTomcat(candidate)) found.push(candidate);
      }
    } catch { /* skip */ }
  }

  // Also honour root path being CATALINA_HOME-shaped itself (e.g. user points
  // env to /opt/apache-tomcat-10.1.18 directly).
  for (const root of [process.env.CATALINA_HOME, process.env.TOMCAT_HOME]) {
    if (root && (await looksLikeTomcat(root))) found.push(root);
  }

  return dedupe(found);
}

async function looksLikeTomcat(dir: string): Promise<boolean> {
  // Check for bin/catalina.{sh,bat} and conf/server.xml — the minimal signal.
  const bin = vscode.Uri.file(`${dir}/bin/catalina.sh`);
  const binWin = vscode.Uri.file(`${dir}/bin/catalina.bat`);
  const serverXml = vscode.Uri.file(`${dir}/conf/server.xml`);
  try {
    await vscode.workspace.fs.stat(serverXml);
  } catch {
    return false;
  }
  for (const b of [bin, binWin]) {
    try {
      await vscode.workspace.fs.stat(b);
      return true;
    } catch { /* try next */ }
  }
  return false;
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

// ----------------------------------------------------------------------------
// Artifact discovery.
// ----------------------------------------------------------------------------

export interface ArtifactCandidate {
  path: string;                            // absolute path
  kind: 'war' | 'exploded';
  label: string;                           // short, for the dropdown
}

// Scan the project for built WARs and exploded web apps. Looks under:
//   <project>/build/libs/*.war                 (Gradle packaged)
//   <project>/build/libs/*(dir ending in .war) (Gradle exploded, rare)
//   <project>/target/*.war                     (Maven packaged)
//   <project>/target/*-SNAPSHOT / *-<version>/ (Maven exploded via war plugin)
// Exploded dirs for Gradle end up at build/libs/exploded/<name>.war/ when the
// user configures it; also common is `build/exploded/<name>/` — we probe both.
export async function findTomcatArtifacts(projectRoot: vscode.Uri): Promise<ArtifactCandidate[]> {
  const out: ArtifactCandidate[] = [];

  const buildLibs = vscode.Uri.joinPath(projectRoot, 'build', 'libs');
  const buildExplodedWeb = vscode.Uri.joinPath(projectRoot, 'build', 'exploded');
  const mavenTarget = vscode.Uri.joinPath(projectRoot, 'target');

  await scanDir(buildLibs, out);
  await scanDir(buildExplodedWeb, out);
  await scanDir(mavenTarget, out);

  // Dedupe by path; prefer exploded over war when both exist (IntelliJ default).
  const seen = new Map<string, ArtifactCandidate>();
  for (const c of out) {
    const existing = seen.get(c.path);
    if (!existing || existing.kind === 'war' && c.kind === 'exploded') {
      seen.set(c.path, c);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

async function scanDir(dir: vscode.Uri, out: ArtifactCandidate[]): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    const full = `${dir.fsPath}/${name}`;
    if (kind === vscode.FileType.File && name.endsWith('.war')) {
      out.push({ path: full, kind: 'war', label: `${name} (war)` });
    } else if (kind === vscode.FileType.Directory) {
      // Exploded web app: directory containing WEB-INF/.
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(`${full}/WEB-INF`));
        out.push({ path: full, kind: 'exploded', label: `${name} (exploded)` });
      } catch { /* not a webapp dir */ }
    }
  }
}
