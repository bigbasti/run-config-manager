import type * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { ExecutionService } from './ExecutionService';
import type { DebugService } from './DebugService';
import type { MonitoringService } from './MonitoringService';

/**
 * Extra settle delay applied AFTER the old process has released its port(s),
 * to be sure the shutdown is fully complete before relaunching. The
 * port-release wait itself is open-ended (see ExecutionService.waitForShutdown)
 * — this is only the safety margin on top of it.
 */
export const RESTART_SETTLE_MS = 3000;

export interface RestartDeps {
  exec: Pick<ExecutionService, 'stop' | 'run' | 'waitForShutdown'>;
  dbg: Pick<DebugService, 'isRunning' | 'stop' | 'debug'>;
  monitoring?: Pick<MonitoringService, 'state'>;
  /** Settle margin after the port frees. Injectable so tests can pass 0. */
  settleMs?: number;
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
 *
 * Between stop and start we wait for the process to actually release its
 * port(s) plus a settle margin (exec.waitForShutdown) — otherwise the relaunch
 * races the still-closing process and run() prompts the user to kill & restart.
 */
export async function restartConfig(
  deps: RestartDeps,
  config: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const { exec, dbg, monitoring } = deps;
  const settleMs = deps.settleMs ?? RESTART_SETTLE_MS;

  const wasDebugging = dbg.isRunning(config.id);
  const wasMonitoring = Boolean(monitoring?.state(config.id));

  if (wasDebugging) {
    await dbg.stop(config.id);
  } else {
    await exec.stop(config.id);
  }

  // Wait until the old process has released its port(s) (shutdown finished),
  // then the settle margin, before relaunching.
  await exec.waitForShutdown(config, folder, settleMs);

  if (wasDebugging) {
    await dbg.debug(config, folder, wasMonitoring ? { monitor: true } : undefined);
  } else if (wasMonitoring) {
    await exec.run(config, folder, { monitor: true });
  } else {
    await exec.run(config, folder, undefined);
  }
}
