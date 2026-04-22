import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';

export class DebugService {
  private running = new Map<string, string>(); // configId → sessionName
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private subs: vscode.Disposable[];

  constructor(private readonly registry: AdapterRegistry) {
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

    const conf = adapter.getDebugConfig(cfg, folder);
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

  async stop(configId: string): Promise<void> {
    const sessionName = this.running.get(configId);
    if (!sessionName) return;
    const session = vscode.debug.activeDebugSession?.name === sessionName
      ? vscode.debug.activeDebugSession
      : undefined;
    try {
      // Prefer stopping the exact session when we can find it; otherwise fall
      // back to stopping the active session (VS Code API forgives extra calls).
      await vscode.debug.stopDebugging(session);
    } catch (e) {
      log.error(`Debug stop failed for ${sessionName}`, e);
    }
    // handleEnd via onDidTerminateDebugSession will clear state; as a
    // safety net, clear eagerly too.
    this.running.delete(configId);
    this.emitter.fire(configId);
  }

  private handleEnd(sessionName: string): void {
    for (const [id, name] of this.running.entries()) {
      if (name === sessionName) {
        this.running.delete(id);
        this.emitter.fire(id);
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
