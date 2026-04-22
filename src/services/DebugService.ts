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
  private async startAttachFlow(
    cfg: Extract<RunConfig, { type: 'spring-boot' }>,
    folder: vscode.WorkspaceFolder,
    attachConf: vscode.DebugConfiguration,
  ): Promise<boolean> {
    if (!this.exec) {
      vscode.window.showErrorMessage('Internal error: ExecutionService not wired into DebugService.');
      return false;
    }
    const port = (attachConf.port as number | undefined) ?? 5005;

    // Compose a copy of the config with the JDWP flag appended to vmArgs so the
    // build tool passes it through to the forked JVM.
    const jdwpFlag = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${port}`;
    const mode = cfg.typeOptions.launchMode;
    let vmArgs = (cfg.vmArgs ?? '').trim();
    vmArgs = vmArgs ? `${vmArgs} ${jdwpFlag}` : jdwpFlag;

    let debugCfg: RunConfig;
    if (mode === 'gradle') {
      // Gradle bootRun doesn't read -Dspring-boot.run.jvmArguments. It reads
      // ORG_GRADLE_PROJECT_jvmArgs or you set systemProperties in the task.
      // The user-facing convention is JAVA_TOOL_OPTIONS — Spring Boot's
      // forked JVM inherits it, and it's non-invasive.
      debugCfg = {
        ...cfg,
        env: { ...(cfg.env ?? {}), JAVA_TOOL_OPTIONS: jdwpFlag },
      };
    } else {
      // Maven: wired through -Dspring-boot.run.jvmArguments (our buildCommand
      // already quotes this).
      debugCfg = { ...cfg, vmArgs };
    }

    const execution = await this.exec.run(debugCfg, folder);
    if (!execution) return false;

    // Wait for the JVM to open the JDWP port before attaching. attachConf's
    // timeout is 60s; we start attaching after 1s and let VS Code retry.
    await new Promise(r => setTimeout(r, 1000));

    try {
      const started = await vscode.debug.startDebugging(folder, attachConf);
      if (started) {
        this.running.set(cfg.id, cfg.name);
        this.emitter.fire(cfg.id);
        log.info(`Debug attached: ${cfg.name} (port ${port})`);
      } else {
        // Attach failed — tear down the task so the user isn't left with an
        // orphan JVM.
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
  return resolveProjectUri(folder, cfg.projectPath).fsPath;
}

// Probe the given TCP port until it accepts a connection OR the budget
// expires. Resolves true on first successful connect, false on timeout.
// Short poll interval (500ms) keeps the attach feel responsive once the JVM
// gets going.
async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise<boolean>(resolve => {
      const sock = net.createConnection({ host, port });
      const onDone = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.once('connect', () => onDone(true));
      sock.once('error', () => onDone(false));
      sock.setTimeout(400, () => onDone(false));
    });
    if (alive) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
