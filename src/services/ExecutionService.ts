import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';
import { resolveProjectUri } from '../utils/paths';
import { gradleModulePrefix } from '../adapters/spring-boot/findBuildRoot';
import { makeRunContext, resolveConfig } from '../utils/resolveVars';

interface Entry {
  execution: vscode.TaskExecution;
  configId: string;
  // Side task (e.g., `gradle -t classes` watcher). Terminated whenever the
  // main task stops; its own lifecycle doesn't affect the config's running
  // state.
  watcher?: vscode.TaskExecution;
}

export class ExecutionService {
  private running = new Map<string, Entry>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private taskEndSub: vscode.Disposable;

  constructor(private readonly registry: AdapterRegistry) {
    this.taskEndSub = vscode.tasks.onDidEndTask(e => this.handleEnd(e.execution));
  }

  isRunning(configId: string): boolean {
    return this.running.has(configId);
  }

  async run(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<vscode.TaskExecution | undefined> {
    if (this.running.has(cfg.id)) return undefined;

    const adapter = this.registry.get(cfg.type);
    if (!adapter) {
      vscode.window.showErrorMessage(`No adapter for type: ${cfg.type}`);
      return undefined;
    }

    // Resolve ${VAR} / ${env:VAR} / ${workspaceFolder} etc. in every text field
    // of the config. Unresolved variables become empty strings and are logged.
    const cwd = buildCwd(cfg, folder);
    const ctx = makeRunContext({ workspaceFolder: folder.uri.fsPath, cwd });
    const { value: resolvedCfg, unresolved } = resolveConfig(cfg, ctx);
    if (unresolved.length) {
      log.warn(`Unresolved variable(s) in "${cfg.name}": ${unresolved.join(', ')} (expanded to empty string)`);
    }

    const { command, args } = adapter.buildCommand(resolvedCfg, folder);

    const shell = new vscode.ShellExecution(command, args, {
      cwd,
      env: { ...resolvedCfg.env },
    });

    const task = new vscode.Task(
      { type: 'run-config', configId: cfg.id } as any,
      folder,
      cfg.name,
      'Run Configurations',
      shell,
      [],
    );

    try {
      const execution = await vscode.tasks.executeTask(task);
      const entry: Entry = { execution, configId: cfg.id };

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
    this.running.delete(configId);
    this.emitter.fire(configId);
  }

  private handleEnd(execution: vscode.TaskExecution): void {
    for (const [id, entry] of this.running.entries()) {
      if (entry.execution === execution) {
        // Main task ended — also kill the watcher.
        entry.watcher?.terminate();
        this.running.delete(id);
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
    }
    this.running.clear();
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
