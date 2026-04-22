import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';
import { resolveProjectUri } from '../utils/paths';

type Entry = { execution: vscode.TaskExecution; configId: string };

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

    const { command, args } = adapter.buildCommand(cfg);
    const cwd = resolveProjectUri(folder, cfg.projectPath).fsPath;

    const shell = new vscode.ShellExecution(command, args, {
      cwd,
      env: { ...cfg.env },
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
      this.running.set(cfg.id, { execution, configId: cfg.id });
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
    // handleEnd will clear state when onDidEndTask fires. For robustness:
    this.running.delete(configId);
    this.emitter.fire(configId);
  }

  private handleEnd(execution: vscode.TaskExecution): void {
    for (const [id, entry] of this.running.entries()) {
      if (entry.execution === execution) {
        this.running.delete(id);
        this.emitter.fire(id);
        return;
      }
    }
  }

  dispose(): void {
    for (const entry of this.running.values()) {
      try { entry.execution.terminate(); } catch { /* ignore */ }
    }
    this.running.clear();
    this.taskEndSub.dispose();
    this.emitter.dispose();
  }
}
