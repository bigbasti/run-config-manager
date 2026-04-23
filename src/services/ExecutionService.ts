import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';
import { resolveProjectUri } from '../utils/paths';
import { gradleModulePrefix } from '../adapters/spring-boot/findBuildRoot';
import { makeRunContext, resolveConfig } from '../utils/resolveVars';
import { RunTerminal } from './RunTerminal';
import {
  readyPatternsFor,
  chunkSignalsReady,
  failurePatternsFor,
  chunkSignalsFailure,
} from './readyPatterns';
import { makePrettifier } from './prettyOutput';

interface Entry {
  execution: vscode.TaskExecution;
  configId: string;
  // Side task (e.g., `gradle -t classes` watcher). Terminated whenever the
  // main task stops; its own lifecycle doesn't affect the config's running
  // state.
  watcher?: vscode.TaskExecution;
  // Timer that marks the config "started" after a fixed delay. Used for
  // runtimes where we can't (or don't want to) observe stdout — Quarkus
  // uses its own interactive shell, so we surrender log scanning and just
  // assume the app is up after 15s. Cleared if the task ends early.
  readyTimer?: NodeJS.Timeout;
}

export interface RunOpts {
  // When true, prepareLaunch is called with { debug: true } so adapters can
  // wire in JDWP flags. DebugService uses this to attach after the JVM boots.
  debug?: boolean;
  debugPort?: number;
}

export class ExecutionService {
  private running = new Map<string, Entry>();
  // "Preparing" is the window between the user clicking Run and the shell
  // execution actually spawning. For Tomcat this can be 30+ seconds while
  // Gradle builds the WAR. Tree provider reads this to show a distinct
  // busy-but-not-yet-running state.
  private preparing = new Set<string>();
  // "Started" means the log scanner matched a readiness phrase for this
  // config's type. Tree provider upgrades the spinner to a green check.
  // Configs whose output never matches a known pattern just stay in the
  // spinner state — correctness trumps a false "ready" signal.
  private started = new Set<string>();
  // "Failed" means the log scanner matched a startup-failure pattern (e.g.
  // "APPLICATION FAILED TO START"). Renders as a red circle; the process may
  // still be alive but the tree reflects the terminal state.
  private failed = new Set<string>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private taskEndSub: vscode.Disposable;

  constructor(private readonly registry: AdapterRegistry) {
    this.taskEndSub = vscode.tasks.onDidEndTask(e => this.handleEnd(e.execution));
  }

  isRunning(configId: string): boolean {
    return this.running.has(configId);
  }

  isPreparing(configId: string): boolean {
    return this.preparing.has(configId);
  }

  isStarted(configId: string): boolean {
    return this.started.has(configId);
  }

  isFailed(configId: string): boolean {
    return this.failed.has(configId);
  }

  // Reveal the integrated terminal for the given running config. VS Code
  // names task terminals "Task - <source>: <taskName>" (versions vary —
  // older builds drop the "Task - " prefix). We match by substring against
  // the config's display name since the source is stable ("Run
  // Configurations"). No-op if the config isn't running or the terminal
  // was already closed.
  focus(configId: string): void {
    const entry = this.running.get(configId);
    if (!entry) return;
    const taskName = entry.execution.task.name;
    const needle = `Run Configurations: ${taskName}`;
    for (const term of vscode.window.terminals) {
      if (term.name === taskName || term.name.includes(needle) || term.name.endsWith(taskName)) {
        term.show(true);
        return;
      }
    }
    log.warn(`focus(${configId}): no terminal found for "${taskName}"`);
  }

  async run(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    opts?: RunOpts,
  ): Promise<vscode.TaskExecution | undefined> {
    if (this.running.has(cfg.id)) return undefined;

    const adapter = this.registry.get(cfg.type);
    if (!adapter) {
      vscode.window.showErrorMessage(`No adapter for type: ${cfg.type}`);
      return undefined;
    }

    // Resolve ${VAR} / ${env:VAR} / ${workspaceFolder} etc. in every text field
    // of the config. Unresolved variables become empty strings and are logged.
    const initialCwd = buildCwd(cfg, folder);
    const ctx = makeRunContext({ workspaceFolder: folder.uri.fsPath, cwd: initialCwd });
    const { value: resolvedCfg, unresolved } = resolveConfig(cfg, ctx);
    if (unresolved.length) {
      log.warn(`Unresolved variable(s) in "${cfg.name}": ${unresolved.join(', ')} (expanded to empty string)`);
    }

    // Let the adapter prep any filesystem state / env vars (Tomcat writes its
    // CATALINA_BASE scaffold here). prepareLaunch may override cwd.
    let prepared: { env?: Record<string, string>; cwd?: string } = {};
    if (adapter.prepareLaunch) {
      this.preparing.add(cfg.id);
      this.emitter.fire(cfg.id);
      log.debug(`Preparing launch: ${cfg.name} (debug=${opts?.debug ?? false})`);
      try {
        prepared = await adapter.prepareLaunch(resolvedCfg, folder, {
          debug: opts?.debug ?? false,
          debugPort: opts?.debugPort,
        });
        const envKeys = Object.keys(prepared.env ?? {});
        if (envKeys.length || prepared.cwd) {
          log.debug(
            `prepareLaunch result: env=[${envKeys.join(', ')}]` +
            (prepared.cwd ? `, cwd=${prepared.cwd}` : ''),
          );
        }
      } catch (e) {
        this.preparing.delete(cfg.id);
        this.emitter.fire(cfg.id);
        log.error(`prepareLaunch failed for ${cfg.name}`, e);
        vscode.window.showErrorMessage(`Failed to prepare "${cfg.name}": ${(e as Error).message}`);
        return undefined;
      }
      this.preparing.delete(cfg.id);
      this.emitter.fire(cfg.id);
    }

    const cwd = prepared.cwd ?? initialCwd;
    const { command, args } = adapter.buildCommand(resolvedCfg, folder);
    log.debug(`buildCommand: ${command} ${args.join(' ')}`);
    log.debug(`cwd: ${cwd}`);
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      ...resolvedCfg.env,
      ...(prepared.env ?? {}),
    };

    // Quarkus dev mode is an interactive shell (press r to reload, s to run
    // tests, etc.). We'd have to forward keystrokes to the child — instead,
    // hand the PTY entirely to VS Code via ShellExecution and surrender log
    // scanning. Mark started after a fixed delay; readyTimer is cleared if
    // the task ends early.
    const useShellExecution = resolvedCfg.type === 'quarkus';

    const readyPatterns = useShellExecution ? [] : readyPatternsFor(resolvedCfg);
    const failPatterns = useShellExecution ? [] : failurePatternsFor(resolvedCfg);
    const markReady = (reason: string) => {
      if (this.running.has(cfg.id) && !this.started.has(cfg.id) && !this.failed.has(cfg.id)) {
        this.started.add(cfg.id);
        this.emitter.fire(cfg.id);
        log.info(`Ready: ${cfg.name} — ${reason}`);
      }
    };
    const markFailed = (reason: string) => {
      if (this.running.has(cfg.id) && !this.failed.has(cfg.id)) {
        this.failed.add(cfg.id);
        // Clear started in case a ready signal fired just before the failure.
        this.started.delete(cfg.id);
        this.emitter.fire(cfg.id);
        log.warn(`Failed: ${cfg.name} — ${reason}`);
      }
    };

    // ShellExecution insists on Record<string, string>; filter out the
    // undefined entries that come from inheriting process.env.
    const strictEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (typeof v === 'string') strictEnv[k] = v;
    }

    const execution2: vscode.ShellExecution | vscode.CustomExecution = useShellExecution
      ? new vscode.ShellExecution(command, args, { cwd, env: strictEnv })
      : new vscode.CustomExecution(async () => new RunTerminal({
          command,
          args,
          cwd,
          env: mergedEnv,
          prettifier: makePrettifier(resolvedCfg, { cwd }),
          onOutput: chunk => {
            if (failPatterns.length && chunkSignalsFailure(chunk, failPatterns)) {
              markFailed('matched failure pattern');
              return;
            }
            if (readyPatterns.length && chunkSignalsReady(chunk, readyPatterns)) {
              markReady('matched readiness pattern');
            }
          },
          onExit: () => {
            // Handled by onDidEndTask listener; no-op here.
          },
        }));

    const task = new vscode.Task(
      { type: 'run-config', configId: cfg.id } as any,
      folder,
      cfg.name,
      'Run Configurations',
      execution2,
      [],
    );

    try {
      const execution = await vscode.tasks.executeTask(task);
      const entry: Entry = { execution, configId: cfg.id };

      // Quarkus: optimistic "started" after a fixed delay (no log scanning).
      if (useShellExecution) {
        entry.readyTimer = setTimeout(() => {
          markReady('elapsed grace period');
        }, 15_000);
      }

      // Opt-in continuous rebuild: spawns a parallel `./gradlew -t :mod:classes`
      // task alongside the main run. DevTools (if present on the classpath)
      // triggers a warm restart each time classes change.
      if (resolvedCfg.type === 'spring-boot' && shouldStartWatcher(resolvedCfg)) {
        try {
          entry.watcher = await startRebuildWatcher(resolvedCfg, folder);
        } catch (e) {
          log.warn(`Rebuild watcher failed to start for ${cfg.name}: ${(e as Error).message}`);
        }
      }

      this.running.set(cfg.id, entry);
      this.emitter.fire(cfg.id);
      log.info(`Started: ${cfg.name} (${command} ${args.join(' ')})`);
      return execution;
    } catch (e) {
      log.error(`Failed to start ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Failed to start "${cfg.name}": ${(e as Error).message}`);
      return undefined;
    }
  }

  async stop(configId: string): Promise<void> {
    const entry = this.running.get(configId);
    if (!entry) return;
    entry.execution.terminate();
    entry.watcher?.terminate();
    if (entry.readyTimer) clearTimeout(entry.readyTimer);
    this.running.delete(configId);
    this.started.delete(configId);
    this.failed.delete(configId);
    this.emitter.fire(configId);
  }

  private handleEnd(execution: vscode.TaskExecution): void {
    for (const [id, entry] of this.running.entries()) {
      if (entry.execution === execution) {
        // Main task ended — also kill the watcher.
        entry.watcher?.terminate();
        if (entry.readyTimer) clearTimeout(entry.readyTimer);
        this.running.delete(id);
        this.started.delete(id);
        this.failed.delete(id);
        this.emitter.fire(id);
        return;
      }
      // If only the watcher ended (e.g., user killed it manually), leave the
      // main task alone. The map entry's `watcher` reference goes stale;
      // dispose() will no-op when terminate is called on a dead execution.
      if (entry.watcher === execution) {
        entry.watcher = undefined;
        return;
      }
    }
  }

  dispose(): void {
    for (const entry of this.running.values()) {
      try { entry.execution.terminate(); } catch { /* ignore */ }
      try { entry.watcher?.terminate(); } catch { /* ignore */ }
      if (entry.readyTimer) clearTimeout(entry.readyTimer);
    }
    this.running.clear();
    this.started.clear();
    this.failed.clear();
    this.taskEndSub.dispose();
    this.emitter.dispose();
  }
}

function buildCwd(cfg: RunConfig, folder: vscode.WorkspaceFolder): string {
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

function shouldStartWatcher(cfg: RunConfig): boolean {
  if (cfg.type !== 'spring-boot') return false;
  const to = cfg.typeOptions;
  if (!to.rebuildOnSave) return false;
  // Gradle is required for the watcher (no equivalent in Maven without extra
  // plugins). gradle launchMode runs bootRun's own reload; we still start the
  // watcher for devtools coverage of resources.
  return to.launchMode === 'gradle' || to.launchMode === 'java-main';
}

async function startRebuildWatcher(
  cfg: Extract<RunConfig, { type: 'spring-boot' }>,
  folder: vscode.WorkspaceFolder,
): Promise<vscode.TaskExecution> {
  const to = cfg.typeOptions;
  const buildRoot = to.buildRoot || resolveProjectUri(folder, cfg.projectPath).fsPath;
  const projectPath = resolveProjectUri(folder, cfg.projectPath).fsPath;
  const modulePrefix = gradleModulePrefix(buildRoot, projectPath);
  const task = modulePrefix ? `${modulePrefix}:classes` : 'classes';

  const gradleBinary =
    to.gradleCommand === './gradlew'
      ? './gradlew'
      : to.gradlePath
      ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle`
      : 'gradle';

  const shell = new vscode.ShellExecution(gradleBinary, ['-t', '--console=plain', task], {
    cwd: buildRoot,
    env: to.jdkPath ? { JAVA_HOME: to.jdkPath } : undefined,
  });

  const vsTask = new vscode.Task(
    { type: 'run-config-watcher', configId: cfg.id } as any,
    folder,
    `${cfg.name} (watch)`,
    'Run Configurations',
    shell,
    [],
  );
  log.info(`Started rebuild watcher: ${gradleBinary} -t ${task} (cwd ${buildRoot})`);
  return vscode.tasks.executeTask(vsTask);
}
