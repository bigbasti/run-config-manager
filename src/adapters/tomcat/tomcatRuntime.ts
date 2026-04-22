import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { RunConfig } from '../../shared/types';
import type { PrepareContext, PrepareResult } from '../RuntimeAdapter';
import { resolveProjectUri } from '../../utils/paths';
import { gradleModulePrefix, findGradleRoot } from '../spring-boot/findBuildRoot';
import { findTomcatArtifacts } from './detectTomcat';
import { log } from '../../utils/logger';

// CATALINA_BASE scaffold location: <workspace>/.vscode/rcm-tomcat/<configId>/.
// We create a minimal tree that Tomcat recognises — conf/, logs/, temp/,
// work/, webapps/ — and override server.xml with the user's ports.
//
// We never touch CATALINA_HOME itself. The Tomcat process uses CATALINA_HOME
// for binaries (bin/*.sh, lib/*.jar) and CATALINA_BASE for everything else.

type TomcatCfg = Extract<RunConfig, { type: 'tomcat' }>;

export async function prepareTomcatLaunch(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
  ctx: PrepareContext,
): Promise<PrepareResult> {
  if (cfg.type !== 'tomcat') throw new Error('not a tomcat config');
  let to = cfg.typeOptions;

  // 1. Run the build step if the user asked for one.
  await runBuildIfNeeded(cfg, folder);

  // 1b. Verify the artifact still exists after the build. If it doesn't (the
  // version bumped and a new file replaced it, or the user renamed it), rescan
  // and pick the freshest. We don't mutate the on-disk config — the user can
  // update it themselves. We just log and toast.
  to = await maybeReselectArtifact(cfg, folder, to);

  // 2. Set up CATALINA_BASE under .vscode/rcm-tomcat/<configId>/.
  const base = vscode.Uri.joinPath(folder.uri, '.vscode', 'rcm-tomcat', cfg.id);
  await ensureCatalinaBase(base, { ...cfg, typeOptions: to });

  // 3. Deploy the artifact into CATALINA_BASE/webapps/<context>.war or /<ctx>/.
  await deployArtifact(base, { ...cfg, typeOptions: to });

  // 4. Compose env vars flow:
  //    - CATALINA_BASE: our scaffold
  //    - CATALINA_HOME: user's install
  //    - CATALINA_OPTS: user VM options + JMX + (debug JDWP if ctx.debug)
  //    - JAVA_HOME: user's JDK (if set)
  //    - JPDA_ADDRESS / JPDA_TRANSPORT (when debug mode and `jpda start` variant)
  const env: Record<string, string> = {
    CATALINA_BASE: base.fsPath,
    CATALINA_HOME: to.tomcatHome,
  };
  if (to.jdkPath) env.JAVA_HOME = to.jdkPath;

  const catalinaOpts: string[] = [];
  if (to.vmOptions.trim()) catalinaOpts.push(to.vmOptions.trim());
  if (typeof to.jmxPort === 'number' && to.jmxPort > 0) {
    catalinaOpts.push(
      `-Dcom.sun.management.jmxremote`,
      `-Dcom.sun.management.jmxremote.port=${to.jmxPort}`,
      `-Dcom.sun.management.jmxremote.ssl=false`,
      `-Dcom.sun.management.jmxremote.authenticate=false`,
    );
  }
  if (ctx.debug) {
    const port = ctx.debugPort ?? to.debugPort ?? 8000;
    // Listen on all interfaces so localhost attach definitely resolves.
    // `address=*:<port>` needs JDK 9+; `0.0.0.0:<port>` works on older JDKs too.
    catalinaOpts.push(
      `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=0.0.0.0:${port}`,
    );
    log.info(`Tomcat debug: JDWP listening on 0.0.0.0:${port}`);
  }
  if (to.colorOutput) {
    // Covers Spring Boot apps running inside Tomcat; generic ANSI tooling
    // reads FORCE_COLOR / CLICOLOR_FORCE to skip TTY detection.
    catalinaOpts.push('-Dspring.output.ansi.enabled=ALWAYS');
    env.FORCE_COLOR = '1';
    env.CLICOLOR_FORCE = '1';
    env.SPRING_OUTPUT_ANSI_ENABLED = 'ALWAYS';
    // JAVA_TOOL_OPTIONS overrides the user's logging.pattern.console (which is
    // commonly set without %clr() tokens → plain output even with ansi=always).
    // JVM tokenises JAVA_TOOL_OPTIONS on ASCII whitespace, so we use the NBSP
    // trick for the pattern's separators.
    const pattern = "%clr(%d{yyyy-MM-dd\\'T\\'HH:mm:ss.SSS}){faint} %clr(%5p) %clr([%t]){faint} %clr(%-40.40logger{39}){cyan} %clr(:){faint} %clr(%replace(%m){'(/[a-zA-Z0-9/._-]+)','\u001b[94m$1\u001b[0m'}) %n%wEx";
    env.JAVA_TOOL_OPTIONS =
      `-Dspring.output.ansi.enabled=ALWAYS -Dlogging.pattern.console=${pattern}`;
  }
  if (catalinaOpts.length > 0) env.CATALINA_OPTS = catalinaOpts.join(' ');

  return { env, cwd: base.fsPath };
}

// If the stored artifactPath no longer exists on disk, look for the newest
// .war / exploded webapp under the build project and swap it in. Returns
// typeOptions with the new artifactPath. User gets a toast so they know we
// auto-corrected. The stored config is left alone — re-running the config
// still looks at its original path first, which is usually what you want.
async function maybeReselectArtifact(
  cfg: TomcatCfg,
  folder: vscode.WorkspaceFolder,
  to: TomcatCfg['typeOptions'],
): Promise<TomcatCfg['typeOptions']> {
  if (!to.artifactPath) return to;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(to.artifactPath));
    return to; // still there
  } catch { /* gone — rescan */ }

  const projectUri = resolveProjectUri(folder, to.buildProjectPath || cfg.projectPath);
  const candidates = await findTomcatArtifacts(projectUri);
  // Prefer candidates matching the original artifactKind, fall back to any.
  const chosen = candidates.find(c => c.kind === to.artifactKind) ?? candidates[0];
  if (!chosen) {
    // Nothing to swap in — let the later deploy step fail with a cleaner error.
    log.warn(`Configured artifact ${to.artifactPath} does not exist and no alternatives were found.`);
    return to;
  }
  const oldName = basename(to.artifactPath);
  const newName = basename(chosen.path);
  log.info(`Configured artifact ${to.artifactPath} missing; using newest found: ${chosen.path}`);
  vscode.window.showInformationMessage(
    `Configured artifact "${oldName}" no longer exists. Deploying newest build: "${newName}".`,
  );
  return { ...to, artifactPath: chosen.path, artifactKind: chosen.kind };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

async function runBuildIfNeeded(cfg: TomcatCfg, folder: vscode.WorkspaceFolder): Promise<void> {
  const to = cfg.typeOptions;
  if (to.buildTool === 'none') return;
  // We don't run the build tool via VS Code's task API here because we want
  // to block the launch until build finishes. child_process.spawn is simpler.

  const projectUri = resolveProjectUri(folder, to.buildProjectPath || cfg.projectPath);

  if (to.buildTool === 'gradle') {
    // When buildRoot isn't explicitly set, walk up from the project to find
    // the Gradle root (settings.gradle / gradlew). Using the submodule as the
    // cwd would miss the wrapper and hand us an "exited 127" from the shell.
    const buildRoot =
      to.buildRoot ||
      (to.gradleCommand === './gradlew'
        ? (await findGradleRoot(projectUri)).fsPath
        : projectUri.fsPath);

    const prefix = buildRoot !== projectUri.fsPath
      ? gradleModulePrefix(buildRoot, projectUri.fsPath)
      : '';
    const task = prefix ? `${prefix}:war` : 'war';
    const gradleBinary =
      to.gradleCommand === './gradlew'
        ? './gradlew'
        : to.gradlePath
        ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle`
        : 'gradle';
    await runSync(gradleBinary, ['--console=plain', task], buildRoot, to.jdkPath);
  } else {
    // Maven — same walking-up logic would apply, but Maven submodules
    // correctly find the reactor parent on their own via <parent>. Stay cwd
    // at the submodule.
    const mvn = to.mavenPath ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn` : 'mvn';
    await runSync(mvn, ['-pl', '.', 'package', '-DskipTests'], projectUri.fsPath, to.jdkPath);
  }
}

function runSync(command: string, args: string[], cwd: string, jdkPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (jdkPath) env.JAVA_HOME = jdkPath;
    log.info(`Building: ${command} ${args.join(' ')} (cwd ${cwd})`);
    const child = cp.spawn(command, args, { cwd, env, shell: true, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after 10 minutes`));
    }, 10 * 60_000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function ensureCatalinaBase(base: vscode.Uri, cfg: TomcatCfg): Promise<void> {
  // Create directory structure.
  for (const sub of ['conf', 'logs', 'temp', 'work', 'webapps']) {
    const dir = vscode.Uri.joinPath(base, sub);
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch { /* already exists or lower-level problem — stat will flag later */ }
  }

  // Write a minimal server.xml. We copy web.xml from CATALINA_HOME so Tomcat
  // has the default servlet mappings. server.xml is generated from the user's
  // ports.
  const serverXml = generateServerXml(cfg);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(base, 'conf', 'server.xml'),
    new TextEncoder().encode(serverXml),
  );

  // web.xml, context.xml, tomcat-users.xml, catalina.properties: copy from
  // CATALINA_HOME if we don't already have them.
  const home = cfg.typeOptions.tomcatHome;
  for (const fname of ['web.xml', 'context.xml', 'tomcat-users.xml', 'catalina.properties']) {
    const target = vscode.Uri.joinPath(base, 'conf', fname);
    try {
      await vscode.workspace.fs.stat(target);
      continue;                           // user already customised it
    } catch { /* not there yet */ }
    try {
      const src = vscode.Uri.file(`${home}/conf/${fname}`);
      const data = await vscode.workspace.fs.readFile(src);
      await vscode.workspace.fs.writeFile(target, data);
    } catch (e) {
      log.warn(`Could not copy ${fname} from ${home}/conf/: ${(e as Error).message}`);
    }
  }
}

function generateServerXml(cfg: TomcatCfg): string {
  const to = cfg.typeOptions;
  const httpsConnector = to.httpsPort
    ? `  <Connector protocol="org.apache.coyote.http11.Http11NioProtocol" port="${to.httpsPort}" SSLEnabled="true" scheme="https" secure="true" />\n`
    : '';
  const ajpConnector = to.ajpPort
    ? `  <Connector protocol="AJP/1.3" port="${to.ajpPort}" redirectPort="${to.httpsPort ?? 8443}" />\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by run-config-manager. Edits to this file are overwritten on every launch. -->
<Server port="-1" shutdown="SHUTDOWN">
  <Listener className="org.apache.catalina.startup.VersionLoggerListener" />
  <Listener className="org.apache.catalina.core.AprLifecycleListener" SSLEngine="on" />
  <Listener className="org.apache.catalina.core.JreMemoryLeakPreventionListener" />
  <Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener" />
  <Listener className="org.apache.catalina.core.ThreadLocalLeakPreventionListener" />
  <Service name="Catalina">
    <Connector port="${to.httpPort}" protocol="HTTP/1.1" connectionTimeout="20000" redirectPort="${to.httpsPort ?? 8443}" />
${httpsConnector}${ajpConnector}    <Engine name="Catalina" defaultHost="localhost">
      <Host name="localhost" appBase="webapps" unpackWARs="true" autoDeploy="true">
      </Host>
    </Engine>
  </Service>
</Server>
`;
}

async function deployArtifact(base: vscode.Uri, cfg: TomcatCfg): Promise<void> {
  const to = cfg.typeOptions;
  const ctxPath = normaliseContext(to.applicationContext);

  // Target name: root context => ROOT, otherwise the slash-stripped name.
  const deployName = ctxPath === '' ? 'ROOT' : ctxPath.replace(/^\//, '').replace(/\//g, '#');

  const webapps = vscode.Uri.joinPath(base, 'webapps');
  const target = vscode.Uri.joinPath(webapps, to.artifactKind === 'war' ? `${deployName}.war` : deployName);

  // Clean up any previous deployment of this context.
  for (const name of [`${deployName}.war`, deployName]) {
    const existing = vscode.Uri.joinPath(webapps, name);
    try {
      await vscode.workspace.fs.delete(existing, { recursive: true, useTrash: false });
    } catch { /* wasn't there */ }
  }

  if (to.artifactKind === 'war') {
    // Read source WAR and write into webapps. The VS Code FS API doesn't do
    // O(1) copy, but WARs are bounded in size and this is a foreground
    // operation so the cost is acceptable.
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(to.artifactPath));
    await vscode.workspace.fs.writeFile(target, data);
  } else {
    // Exploded: create a symlink from webapps/<name>/ → <artifactPath>.
    // Using a symlink avoids copying the directory tree and lets Tomcat's
    // reloadable=true see changes live.
    await makeSymlinkBestEffort(to.artifactPath, target);
  }

  // Reloadable context: write META-INF/context.xml into the exploded dir
  // OR a webapps/<name>.xml context descriptor for WAR deploys.
  if (to.reloadable) {
    const contextXml = `<?xml version="1.0"?><Context reloadable="true" />`;
    if (to.artifactKind === 'exploded') {
      const metaInf = vscode.Uri.joinPath(target, 'META-INF');
      try { await vscode.workspace.fs.createDirectory(metaInf); } catch {}
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(metaInf, 'context.xml'),
        new TextEncoder().encode(contextXml),
      );
    } else {
      // For WAR deploys, context.xml goes into CATALINA_BASE/conf/Catalina/localhost/<name>.xml
      const ctxDescriptor = vscode.Uri.joinPath(base, 'conf', 'Catalina', 'localhost', `${deployName}.xml`);
      try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, 'conf', 'Catalina', 'localhost')); } catch {}
      await vscode.workspace.fs.writeFile(ctxDescriptor, new TextEncoder().encode(contextXml));
    }
  }
}

function normaliseContext(c: string): string {
  const s = (c || '/').trim();
  if (s === '' || s === '/') return '';
  return s.startsWith('/') ? s : `/${s}`;
}

async function makeSymlinkBestEffort(src: string, target: vscode.Uri): Promise<void> {
  // vscode.workspace.fs doesn't expose symlink creation. Fall back to Node fs.
  // On Windows this requires admin or SeCreateSymbolicLink — we detect failure
  // and degrade to a full copy.
  const { promises: fsp } = await import('fs');
  try {
    await fsp.symlink(src, target.fsPath, 'dir');
    log.info(`Symlinked ${target.fsPath} → ${src}`);
    return;
  } catch (e) {
    log.warn(`Symlink failed (${(e as Error).message}), falling back to copy`);
  }
  await copyDirRecursive(src, target.fsPath);
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  const { promises: fsp } = await import('fs');
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

// Placeholder — kept for symmetry with the ExecutionService call sites. The
// actual command to run is `<tomcatHome>/bin/catalina.sh run` (or .bat on
// Windows). ExecutionService uses the return value of buildCommand plus the
// env from prepareLaunch.
export function catalinaExecutable(cfg: TomcatCfg): string {
  const bin = cfg.typeOptions.tomcatHome.replace(/[/\\]$/, '') + '/bin';
  return os.platform() === 'win32' ? `${bin}/catalina.bat` : `${bin}/catalina.sh`;
}
