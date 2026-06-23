import type * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { ExecutionService } from './ExecutionService';
import type { DebugService } from './DebugService';
import type { MonitoringService } from './MonitoringService';

/**
 * Pause between stop and start so the OS releases the port and the child
 * process fully exits before we relaunch. Tuned for a usability "restart"
 * rather than correctness — a value too small risks a port-in-use relaunch.
 */
export const RESTART_DELAY_MS = 1000;

export interface RestartDeps {
  exec: Pick<ExecutionService, 'stop' | 'run'>;
  dbg: Pick<DebugService, 'isRunning' | 'stop' | 'debug'>;
  monitoring?: Pick<MonitoringService, 'state'>;
  /** Injectable purely so tests can pass 0. Defaults to RESTART_DELAY_MS. */
  delayMs?: number;
}

/**
 * Stop a running config and start it again in the SAME mode it was running.
 *
 * Mode is captured up front (before the stop tears down the tracking state):
 *  - debug:   dbg.isRunning(id) — true for both launch- and attach-mode debug.
 *  - monitor: monitoring.state(id) — present while a JMX agent is attached.
 *
 * dbg.stop() also tears down the underlying run task in attach-mode, so a
 * single stop call is sufficient regardless of mode.
 */
export async function restartConfig(
  deps: RestartDeps,
  config: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const { exec, dbg, monitoring } = deps;
  const delayMs = deps.delayMs ?? RESTART_DELAY_MS;

  const wasDebugging = dbg.isRunning(config.id);
  const wasMonitoring = Boolean(monitoring?.state(config.id));

  if (wasDebugging) {
    await dbg.stop(config.id);
  } else {
    await exec.stop(config.id);
  }

  if (delayMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  }

  if (wasDebugging) {
    await dbg.debug(config, folder, wasMonitoring ? { monitor: true } : undefined);
  } else if (wasMonitoring) {
    await exec.run(config, folder, { monitor: true });
  } else {
    await exec.run(config, folder, undefined);
  }
}
