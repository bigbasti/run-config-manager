import * as vscode from 'vscode';
import * as net from 'net';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { RunConfig } from '../shared/types';
import type { ExecutionService } from './ExecutionService';
import { log } from '../utils/logger';
import { makeRunContext, resolveConfig } from '../utils/resolveVars';
import { resolveProjectUri } from '../utils/paths';

// Required for `type: 'java'` debug configurations. The Spring Boot adapter
// needs this extension; npm uses the built-in `pwa-node` and doesn't.
const JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug';

export class DebugService {
  private running = new Map<string, string>(); // configId → sessionName
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private subs: vscode.Disposable[];

  constructor(
    private readonly registry: AdapterRegistry,
    // Optional so existing tests that don't care about Spring Boot debug can
    // still construct a DebugService without ExecutionService.
    private readonly exec?: ExecutionService,
  ) {
    this.subs = [
      vscode.debug.onDidTerminateDebugSession(s => this.handleEnd(s.name)),
    ];
  }

  isRunning(configId: string): boolean {
    return this.running.has(configId);
  }

  async debug(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (this.running.has(cfg.id)) return false;

    const adapter = this.registry.get(cfg.type);
    if (!adapter) {
      vscode.window.showErrorMessage(`No adapter for type: ${cfg.type}`);
      return false;
    }
    if (!adapter.supportsDebug || !adapter.getDebugConfig) {
      vscode.window.showErrorMessage(`Debug is not supported for type: ${cfg.type}`);
      return false;
    }

    // Resolve variables the same way ExecutionService does. ExecutionService
    // resolves again for attach-mode's run; the duplicate work is cheap and
    // keeps each service independently correct.
    const cwd = debugCwd(cfg, folder);
    const ctx = makeRunContext({ workspaceFolder: folder.uri.fsPath, cwd });
    const { value: resolvedCfg, unresolved } = resolveConfig(cfg, ctx);
    if (unresolved.length) {
      log.warn(`Unresolved variable(s) in debug of "${cfg.name}": ${unresolved.join(', ')} (expanded to empty string)`);
    }

    const conf = adapter.getDebugConfig(resolvedCfg, folder);
    log.debug(`getDebugConfig: type=${conf.type}, request=${conf.request}${conf.port ? `, port=${conf.port}` : ''}`);

    // Java-type debug requires the Java Debugger extension.
    if (conf.type === 'java' && !vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID)) {
      vscode.window.showErrorMessage(
        `Java debugging requires the "Debugger for Java" extension (${JAVA_DEBUG_EXTENSION_ID}). ` +
        `Install the "Extension Pack for Java" to enable Spring Boot debugging.`,
      );
      return false;
    }

    // For attach-mode Java debug, we need to first start the build tool under
    // JDWP. The adapter told us which port it expects; we wrap buildCommand's
    // output with the right -agentlib:jdwp arg and run it through ExecutionService,
    // then hand over to startDebugging after a short delay so the JVM has time
    // to open the port.
    if (conf.type === 'java' && conf.request === 'attach' && resolvedCfg.type === 'spring-boot') {
      return await this.startAttachFlow(resolvedCfg, folder, conf);
    }
    if (conf.type === 'java' && conf.request === 'attach' && resolvedCfg.type === 'tomcat') {
      return await this.startTomcatAttachFlow(resolvedCfg, folder, conf);
    }
    if (conf.type === 'java' && conf.request === 'attach' && resolvedCfg.type === 'quarkus') {
      return await this.startQuarkusAttachFlow(resolvedCfg, folder, conf);
    }
    if (conf.type === 'java' && conf.request === 'attach' && resolvedCfg.type === 'java') {
      return await this.startJavaAttachFlow(resolvedCfg, folder, conf);
    }

    // Launch-mode Java (java-main) or non-Java: startDebugging handles the JVM.
    try {
      const started = await vscode.debug.startDebugging(folder, conf);
      if (started) {
        this.running.set(cfg.id, cfg.name);
        this.emitter.fire(cfg.id);
        log.info(`Debug started: ${cfg.name}`);
      }
      return started;
    } catch (e) {
      log.error(`Debug failed for ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Debug failed: ${(e as Error).message}`);
      return false;
    }
  }

  // For Spring Boot Maven/Gradle: launch the build tool with JDWP suspend=n,
  // then attach. The build-tool task is tracked by ExecutionService so the
  // Stop button terminates it correctly; the debug session is tracked here.
  //
  // Implementation note: JDWP is now composed by SpringBootAdapter.prepareLaunch
  // (gradle uses JAVA_TOOL_OPTIONS; maven uses -Dspring-boot.run.jvmArguments,
  // mutated below before calling exec.run). Earlier this method tried to
  // inject JDWP via cfg.env.JAVA_TOOL_OPTIONS but prepareLaunch's own
  // composition won the merge race in ExecutionService and overwrote the
  // flag — the JVM never opened a debug socket and attach timed out at 60s.
  private async startAttachFlow(
    cfg: Extract<RunConfig, { type: 'spring-boot' }>,
    folder: vscode.WorkspaceFolder,
    attachConf: vscode.DebugConfiguration,
  ): Promise<boolean> {
    if (!this.exec) {
      vscode.window.showErrorMessage('Internal error: ExecutionService not wired into DebugService.');
      return false;
    }
    const port = (attachConf.port as number | undefined) ?? cfg.typeOptions.debugPort ?? 5005;
    const mode = cfg.typeOptions.launchMode;

    let runCfg: RunConfig = cfg;
    if (mode === 'maven') {
      // Maven flows JDWP through -Dspring-boot.run.jvmArguments which the
      // buildCommand quotes from cfg.vmArgs. We append the flag onto a
      // copied config so it lands in the forked JVM. (Gradle uses
      // JAVA_TOOL_OPTIONS via prepareLaunch — see SpringBootAdapter.)
      const jdwpFlag = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${port}`;
      const vmArgs = (cfg.vmArgs ?? '').trim();
      runCfg = { ...cfg, vmArgs: vmArgs ? `${vmArgs} ${jdwpFlag}` : jdwpFlag };
    }

    // Pass debug=true so prepareLaunch composes the JDWP flag for gradle.
    // Maven ignores this flag inside prepareLaunch (its JDWP flows via
    // vmArgs above); harmless to pass uniformly.
    const execution = await this.exec.run(runCfg, folder, { debug: true, debugPort: port });
    if (!execution) return false;

    // Same wait-then-attach pattern as Tomcat/Java/Quarkus. Apache's
    // vscjava.vscode-java-debug attach throws hard on ECONNREFUSED, so we
    // wait for the JVM to actually open the port (cold compile + bootRun
    // can take a minute on a big project; 5-minute cap covers cold cache).
    log.info(`Spring Boot debug: waiting for JDWP on localhost:${port}…`);
    const ready = await waitForPort('localhost', port, 5 * 60_000);
    if (!ready) {
      vscode.window.showErrorMessage(
        `Debug attach failed: JDWP port ${port} did not open within 5 minutes.`,
      );
      await this.exec.stop(cfg.id);
      return false;
    }
    log.info(`Spring Boot debug: JDWP socket open, attaching…`);

    try {
      const started = await vscode.debug.startDebugging(folder, attachConf);
      if (started) {
        this.running.set(cfg.id, cfg.name);
        this.emitter.fire(cfg.id);
        log.info(`Debug attached: ${cfg.name} (port ${port})`);
      } else {
        await this.exec.stop(cfg.id);
      }
      return started;
    } catch (e) {
      log.error(`Debug attach failed for ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Debug attach failed: ${(e as Error).message}`);
      await this.exec.stop(cfg.id);
      return false;
    }
  }

  // Tomcat: the adapter's prepareLaunch({debug:true}) does the JDWP wiring
  // (via CATALINA_OPTS). We delegate JVM launch to exec.run and attach after
  // a short delay.
  private async startTomcatAttachFlow(
    cfg: Extract<RunConfig, { type: 'tomcat' }>,
    folder: vscode.WorkspaceFolder,
    attachConf: vscode.DebugConfiguration,
  ): Promise<boolean> {
    if (!this.exec) {
      vscode.window.showErrorMessage('Internal error: ExecutionService not wired into DebugService.');
      return false;
    }
    const port = (attachConf.port as number | undefined) ?? cfg.typeOptions.debugPort ?? 8000;

    const execution = await this.exec.run(cfg, folder, { debug: true, debugPort: port });
    if (!execution) return false;

    // Poll for the JDWP socket to actually accept connections before handing
    // off to the Java debugger. vscode-java-debug's own attach logic tries
    // once and fails hard on ECONNREFUSED — unlike the Node debugger it does
    // NOT retry. So we probe ourselves, then call startDebugging when the
    // socket is alive. 5-minute cap covers Tomcat cold-start on slow machines.
    log.info(`Tomcat debug: waiting for JDWP on localhost:${port}…`);
    const ready = await waitForPort('localhost', port, 5 * 60_000);
    if (!ready) {
      vscode.window.showErrorMessage(
        `Debug attach failed: JDWP port ${port} did not open within 5 minutes.`,
      );
      await this.exec.stop(cfg.id);
      return false;
    }
    log.info(`Tomcat debug: JDWP socket open, attaching…`);

    try {
      const started = await vscode.debug.startDebugging(folder, attachConf);
      if (started) {
        this.running.set(cfg.id, cfg.name);
        this.emitter.fire(cfg.id);
        log.info(`Debug attached to Tomcat: ${cfg.name} (port ${port})`);
      } else {
        await this.exec.stop(cfg.id);
      }
      return started;
    } catch (e) {
      log.error(`Tomcat debug attach failed for ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Debug attach failed: ${(e as Error).message}`);
      await this.exec.stop(cfg.id);
      return false;
    }
  }

  // Plain Java: JDWP is injected by the adapter's prepareLaunch (MAVEN_OPTS
  // for Maven, JAVA_TOOL_OPTIONS for Gradle). Same wait-then-attach shape as
  // Tomcat and Quarkus — no config mutation here.
  private async startJavaAttachFlow(
    cfg: Extract<RunConfig, { type: 'java' }>,
    folder: vscode.WorkspaceFolder,
    attachConf: vscode.DebugConfiguration,
  ): Promise<boolean> {
    if (!this.exec) {
      vscode.window.showErrorMessage('Internal error: ExecutionService not wired into DebugService.');
      return false;
    }
    const port = (attachConf.port as number | undefined) ?? cfg.typeOptions.debugPort ?? 5005;

    const execution = await this.exec.run(cfg, folder, { debug: true, debugPort: port });
    if (!execution) return false;

    log.info(`Java debug: waiting for JDWP on localhost:${port}…`);
    const ready = await waitForPort('localhost', port, 5 * 60_000);
    if (!ready) {
      vscode.window.showErrorMessage(
        `Debug attach failed: JDWP port ${port} did not open within 5 minutes.`,
      );
      await this.exec.stop(cfg.id);
      return false;
    }
    log.info(`Java debug: JDWP socket open, attaching…`);

    try {
      const started = await vscode.debug.startDebugging(folder, attachConf);
      if (started) {
        this.running.set(cfg.id, cfg.name);
        this.emitter.fire(cfg.id);
        log.info(`Debug attached to Java app: ${cfg.name} (port ${port})`);
      } else {
        await this.exec.stop(cfg.id);
      }
      return started;
    } catch (e) {
      log.error(`Java debug attach failed for ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Debug attach failed: ${(e as Error).message}`);
      await this.exec.stop(cfg.id);
      return false;
    }
  }

  // Quarkus: `-Ddebug=<port>` is already baked into buildCommand, so we don't
  // need to mutate the config here. Just run and wait for the JDWP socket, same
  // as Tomcat.
  private async startQuarkusAttachFlow(
    cfg: Extract<RunConfig, { type: 'quarkus' }>,
    folder: vscode.WorkspaceFolder,
    attachConf: vscode.DebugConfiguration,
  ): Promise<boolean> {
    if (!this.exec) {
      vscode.window.showErrorMessage('Internal error: ExecutionService not wired into DebugService.');
      return false;
    }
    const port = (attachConf.port as number | undefined) ?? cfg.typeOptions.debugPort ?? 5005;

    const execution = await this.exec.run(cfg, folder, { debug: true, debugPort: port });
    if (!execution) return false;

    log.info(`Quarkus debug: waiting for JDWP on localhost:${port}…`);
    const ready = await waitForPort('localhost', port, 5 * 60_000);
    if (!ready) {
      vscode.window.showErrorMessage(
        `Debug attach failed: JDWP port ${port} did not open within 5 minutes.`,
      );
      await this.exec.stop(cfg.id);
      return false;
    }
    log.info(`Quarkus debug: JDWP socket open, attaching…`);

    try {
      const started = await vscode.debug.startDebugging(folder, attachConf);
      if (started) {
        this.running.set(cfg.id, cfg.name);
        this.emitter.fire(cfg.id);
        log.info(`Debug attached to Quarkus: ${cfg.name} (port ${port})`);
      } else {
        await this.exec.stop(cfg.id);
      }
      return started;
    } catch (e) {
      log.error(`Quarkus debug attach failed for ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Debug attach failed: ${(e as Error).message}`);
      await this.exec.stop(cfg.id);
      return false;
    }
  }

  async stop(configId: string): Promise<void> {
    const sessionName = this.running.get(configId);
    if (!sessionName) return;
    const session = vscode.debug.activeDebugSession?.name === sessionName
      ? vscode.debug.activeDebugSession
      : undefined;
    try {
      await vscode.debug.stopDebugging(session);
    } catch (e) {
      log.error(`Debug stop failed for ${sessionName}`, e);
    }
    // Also stop the build-tool task if ExecutionService is still running it
    // (attach-mode: debug session + task are two things to tear down).
    if (this.exec?.isRunning(configId)) {
      await this.exec.stop(configId);
    }
    this.running.delete(configId);
    this.emitter.fire(configId);
  }

  private handleEnd(sessionName: string): void {
    for (const [id, name] of this.running.entries()) {
      if (name === sessionName) {
        this.running.delete(id);
        this.emitter.fire(id);
        // If the debug session ended but the build-tool task is still running
        // (attach-mode, user hit detach not stop), leave the task alone —
        // they might want to reattach. Nothing to do.
        return;
      }
    }
  }

  dispose(): void {
    this.subs.forEach(d => d.dispose());
    this.running.clear();
    this.emitter.dispose();
  }
}

// Mirrors ExecutionService.buildCwd — for Spring Boot maven/gradle we prefer
// the build-tool root; otherwise the resolved projectPath. Exposed here so
// variable resolution can use ${cwd} / ${projectPath} consistently with run.
function debugCwd(cfg: RunConfig, folder: vscode.WorkspaceFolder): string {
  if (cfg.type === 'spring-boot') {
    const to = cfg.typeOptions;
    if ((to.launchMode === 'maven' || to.launchMode === 'gradle') && to.buildRoot) {
      return to.buildRoot;
    }
  }
  if (cfg.type === 'quarkus' && cfg.typeOptions.buildRoot) {
    return cfg.typeOptions.buildRoot;
  }
  if (cfg.type === 'java') {
    const to = cfg.typeOptions;
    if ((to.launchMode === 'maven' || to.launchMode === 'gradle') && to.buildRoot) {
      return to.buildRoot;
    }
  }
  return resolveProjectUri(folder, cfg.projectPath).fsPath;
}

// Probe the given JDWP port until the JVM completes a clean
// JDWP-Handshake exchange. Resolves true on first successful handshake,
// false on timeout. Short poll interval (500ms) keeps the attach feel
// responsive once the JVM gets going.
//
// We deliberately speak the JDWP protocol here rather than just opening
// and tearing down a TCP socket. A bare connect-then-destroy looks
// identical to a half-finished attach to the JDWP agent, which then
// logs `handshake failed - connection prematurally closed` (sic).
// That's harmless but very noisy: every probe before the actual attach
// would show up in the user's terminal. Proper handshake then graceful
// close = silent agent.
async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // The JDWP handshake string is exactly these 14 ASCII bytes — both
  // directions. See https://docs.oracle.com/en/java/javase/21/docs/specs/jdwp/jdwp-spec.html
  const HANDSHAKE = Buffer.from('JDWP-Handshake', 'ascii');
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock = net.createConnection({ host, port });
      let received = Buffer.alloc(0);
      let resolved = false;
      const finish = (val: boolean) => {
        if (resolved) return;
        resolved = true;
        // `end()` flushes pending writes and sends FIN — the JVM treats
        // this as a clean disconnect after a successful handshake, no
        // log spam.
        try { sock.end(); } catch { /* ignore */ }
        resolve(val);
      };
      sock.once('connect', () => {
        // Server speaks first in the JDWP handshake; we're allowed to
        // write our half right away, the JVM responds when it's ready.
        try { sock.write(HANDSHAKE); } catch { /* ignore */ }
      });
      sock.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= HANDSHAKE.length) {
          const matches = received.slice(0, HANDSHAKE.length).equals(HANDSHAKE);
          finish(matches);
        }
      });
      sock.once('error', () => finish(false));
      sock.setTimeout(800, () => finish(false));
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
