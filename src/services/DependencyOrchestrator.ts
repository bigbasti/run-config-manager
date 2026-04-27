import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { RunConfigService } from './RunConfigService';
import type { ExecutionService } from './ExecutionService';
import type { DebugService } from './DebugService';
import type { DockerService } from './DockerService';
import type { NativeRunnerService } from './NativeRunnerService';
import { parseDependencyRef, rcmRef } from './dependencyCandidates';
import { log } from '../utils/logger';

// Status a dependency node can be in during an orchestrated run. Used by the
// tree provider to paint per-step progress while the orchestrator walks.
export type OrchestrationStatus =
  | 'idle'
  | 'waiting'     // queued, not yet started (earlier dep still running)
  | 'starting'   // start command issued, waiting for running-state
  | 'delaying'   // dependency is up, we're waiting out the per-edge delay
  | 'running'
  | 'failed'
  | 'skipped';   // cycle detected or ref unresolved

export interface OrchestrationSnapshot {
  // The root config the user clicked Run on.
  rootId: string;
  // Per-ref status. Keyed on the dependency ref (same string the form uses)
  // plus a special "rcm:<rootId>" entry for the root itself.
  statuses: Map<string, OrchestrationStatus>;
  // Reason text attached to 'failed' or 'skipped' entries.
  reasons: Map<string, string>;
}

// How long we wait for a dependency to report "running" before giving up.
// Conservative — some docker start-ups are slow. Never spin on this — we
// poll cheaply and the user can always click Stop.
const RUNNING_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;

export class DependencyOrchestrator {
  // One-shot orchestrations keyed by root config id. Lets the tree provider
  // show per-step state while a run is in progress, and lets the user click
  // Run again without double-starting.
  private active = new Map<string, OrchestrationSnapshot>();
  private emitter = new vscode.EventEmitter<OrchestrationSnapshot>();
  readonly onChanged = this.emitter.event;

  constructor(
    private readonly svc: RunConfigService,
    private readonly exec: ExecutionService,
    private readonly dbg: DebugService,
    private readonly docker: DockerService,
    private readonly native: NativeRunnerService,
  ) {}

  snapshotOf(rootId: string): OrchestrationSnapshot | undefined {
    return this.active.get(rootId);
  }

  // Entry point. The caller passes the config the user hit Run on — we walk
  // its dependencies (depth-first), start them in order with the configured
  // delays, then start the root itself. Promise resolves once the root is
  // started; it doesn't wait for root-started-state (tree keeps its existing
  // semantics for that).
  async run(rootCfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<void> {
    // If the root has no deps, fall through to the direct path — the caller
    // should have short-circuited, but handle it safely here too.
    const plan = this.buildPlan(rootCfg);
    if (plan.steps.length === 0 && plan.cycle === null) {
      await this.startRcmConfig(rootCfg, folder);
      return;
    }

    const snap: OrchestrationSnapshot = {
      rootId: rootCfg.id,
      statuses: new Map(),
      reasons: new Map(),
    };
    for (const step of plan.steps) {
      snap.statuses.set(step.ref, 'waiting');
    }
    snap.statuses.set(rcmRef(rootCfg.id), 'waiting');
    this.active.set(rootCfg.id, snap);
    this.emitter.fire(snap);

    if (plan.cycle) {
      snap.statuses.set(plan.cycle.ref, 'failed');
      snap.reasons.set(
        plan.cycle.ref,
        `Cycle detected: ${plan.cycle.path.join(' → ')}. Nothing was started — break the cycle in the config's "Depends on" list.`,
      );
      this.emitter.fire(snap);
      vscode.window.showErrorMessage(
        `Dependency cycle detected for "${rootCfg.name}": ${plan.cycle.path.join(' → ')}. No configs were started.`,
      );
      return;
    }

    // Execute steps in order. Each step: start the dep, wait for running,
    // wait for per-edge delay. On failure we stop and mark remaining steps
    // as skipped.
    let failed = false;
    for (const step of plan.steps) {
      if (failed) {
        snap.statuses.set(step.ref, 'skipped');
        snap.reasons.set(step.ref, 'Skipped because an earlier dependency failed.');
        this.emitter.fire(snap);
        continue;
      }
      try {
        await this.startStep(step, snap);
      } catch (e) {
        failed = true;
        snap.statuses.set(step.ref, 'failed');
        snap.reasons.set(step.ref, (e as Error).message);
        this.emitter.fire(snap);
        vscode.window.showErrorMessage(
          `Dependency "${labelForRef(step.ref, step.cfg?.name)}" failed: ${(e as Error).message}. "${rootCfg.name}" was NOT started.`,
        );
      }
    }

    if (failed) {
      snap.statuses.set(rcmRef(rootCfg.id), 'skipped');
      snap.reasons.set(rcmRef(rootCfg.id), 'Root config skipped because a dependency failed.');
      this.emitter.fire(snap);
      // Leave snapshot in place so tree stays expanded showing the failure.
      return;
    }

    // Kick off the root. Tree flips `rcm:<rootId>` to 'starting' → 'running'
    // using the exec/docker services' own state channels; we still mirror
    // here so the snapshot is self-contained.
    snap.statuses.set(rcmRef(rootCfg.id), 'starting');
    this.emitter.fire(snap);
    try {
      await this.startRcmConfig(rootCfg, folder);
      snap.statuses.set(rcmRef(rootCfg.id), 'running');
      this.emitter.fire(snap);
      // Happy path — drop the snapshot so the tree collapses on its own.
      // Caller (tree provider) can read `active` and auto-collapse the
      // row when the snapshot disappears.
      setTimeout(() => {
        if (this.active.get(rootCfg.id) === snap) {
          this.active.delete(rootCfg.id);
          this.emitter.fire(snap);
        }
      }, 1500);
    } catch (e) {
      snap.statuses.set(rcmRef(rootCfg.id), 'failed');
      snap.reasons.set(rcmRef(rootCfg.id), (e as Error).message);
      this.emitter.fire(snap);
    }
  }

  // Expose plan computation so the tree provider can render dep children
  // even when an orchestration isn't active.
  plan(rootCfg: RunConfig): PlanResult {
    return this.buildPlan(rootCfg);
  }

  // ---- internals -------------------------------------------------------

  private buildPlan(rootCfg: RunConfig): PlanResult {
    const steps: PlanStep[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    let cycle: { ref: string; path: string[] } | null = null;

    const rootRef = rcmRef(rootCfg.id);
    visiting.add(rootRef);

    const walk = (cfg: RunConfig, trail: string[]) => {
      const deps = cfg.dependsOn ?? [];
      for (const dep of deps) {
        if (cycle) return;
        if (done.has(dep.ref)) continue;
        if (visiting.has(dep.ref)) {
          cycle = { ref: dep.ref, path: [...trail, dep.ref] };
          return;
        }
        visiting.add(dep.ref);
        const resolved = this.resolve(dep.ref, cfg.workspaceFolder);
        if (resolved?.kind === 'rcm' && resolved.cfg) {
          walk(resolved.cfg, [...trail, dep.ref]);
          if (cycle) return;
        }
        steps.push({
          ref: dep.ref,
          delaySeconds: dep.delaySeconds ?? 0,
          resolved,
          cfg: resolved?.kind === 'rcm' ? resolved.cfg : undefined,
        });
        visiting.delete(dep.ref);
        done.add(dep.ref);
      }
    };

    walk(rootCfg, [rootRef]);
    return cycle ? { steps: [], cycle } : { steps, cycle: null };
  }

  // Resolve a ref to something we can start — an RCM config, a native
  // launch handle, or a native task handle. Returns null when the ref
  // doesn't match anything currently known.
  resolve(ref: string, workspaceFolderName: string): ResolvedRef | null {
    const parsed = parseDependencyRef(ref);
    if (!parsed) return null;

    if (parsed.kind === 'rcm') {
      const entry = this.svc.getById(parsed.key);
      if (!entry || !entry.valid) return null;
      return { kind: 'rcm', cfg: entry.config };
    }
    if (parsed.kind === 'launch') {
      const launches = this.native.getLaunches();
      const match = launches.find(l => l.name === parsed.key);
      if (!match) return null;
      return { kind: 'launch', launch: match };
    }
    if (parsed.kind === 'task') {
      void workspaceFolderName;
      // Task refs already carry source+name — orchestrator does the lookup
      // async in startStep. Return a lightweight marker here.
      return { kind: 'task', source: parsed.source ?? '', taskName: parsed.taskName ?? '' };
    }
    return null;
  }

  private async startStep(step: PlanStep, snap: OrchestrationSnapshot): Promise<void> {
    snap.statuses.set(step.ref, 'starting');
    this.emitter.fire(snap);

    if (!step.resolved) {
      throw new Error(`Dependency "${step.ref}" not found — may have been renamed or removed.`);
    }

    if (step.resolved.kind === 'rcm') {
      const cfg = step.resolved.cfg;
      const folder = this.folderFor(cfg);
      if (!folder) throw new Error(`Workspace folder not found for "${cfg.name}"`);
      await this.startRcmConfig(cfg, folder);
      await this.waitUntilRcmRunning(cfg);
    } else if (step.resolved.kind === 'launch') {
      await this.native.runLaunch(step.resolved.launch);
      await this.waitUntilLaunchRunning(step.resolved.launch.name);
    } else {
      const taskRef = step.resolved;
      const tasks = await this.native.getTasks();
      const match = tasks.find(t => t.source === taskRef.source && t.name === taskRef.taskName);
      if (!match) throw new Error(`Task "${taskRef.taskName}" (${taskRef.source}) not found.`);
      await this.native.runTask(match);
      // Tasks may complete immediately (one-shot) — we accept "started" or
      // "ended" as sufficient to proceed.
      await this.waitUntilTaskStartedOrEnded(taskRef.source, taskRef.taskName);
    }

    snap.statuses.set(step.ref, 'running');
    this.emitter.fire(snap);

    if (step.delaySeconds && step.delaySeconds > 0) {
      snap.statuses.set(step.ref, 'delaying');
      this.emitter.fire(snap);
      log.info(`Dep "${step.ref}": waiting ${step.delaySeconds}s before continuing.`);
      await sleep(step.delaySeconds * 1000);
      snap.statuses.set(step.ref, 'running');
      this.emitter.fire(snap);
    }
  }

  private folderFor(cfg: RunConfig): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.find(f => f.name === cfg.workspaceFolder) ?? folders[0];
  }

  private async startRcmConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<void> {
    if (cfg.type === 'docker') {
      if (this.docker.isRunning(cfg.typeOptions.containerId)) return;
      await this.docker.startContainer(cfg.typeOptions.containerId);
      return;
    }
    if (this.exec.isRunning(cfg.id) || this.dbg.isRunning(cfg.id)) return;
    await this.exec.run(cfg, folder);
  }

  private async waitUntilRcmRunning(cfg: RunConfig): Promise<void> {
    const deadline = Date.now() + RUNNING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cfg.type === 'docker') {
        if (this.docker.isRunning(cfg.typeOptions.containerId)) return;
      } else {
        if (this.exec.isStarted(cfg.id) || this.exec.isRunning(cfg.id)) return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`"${cfg.name}" did not reach running state within ${RUNNING_TIMEOUT_MS / 1000}s.`);
  }

  private async waitUntilLaunchRunning(name: string): Promise<void> {
    const deadline = Date.now() + RUNNING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.native.isLaunchRunning(name)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Launch "${name}" did not start within ${RUNNING_TIMEOUT_MS / 1000}s.`);
  }

  private async waitUntilTaskStartedOrEnded(source: string, name: string): Promise<void> {
    // Tasks may be one-shot (completing quickly). We consider either "saw
    // it start" or "short enough it already ended" as success — but we
    // need SOME signal, so we wait up to a second for a start event.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (this.native.isTaskRunning(source, name)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    // Assume the task was one-shot. Don't block the chain on it.
    log.debug(`Task ${source}::${name} didn't appear as running — treating as one-shot.`);
  }
}

type PlanStep = {
  ref: string;
  delaySeconds: number;
  resolved: ResolvedRef | null;
  cfg?: RunConfig;
};

export type PlanResult =
  | { steps: PlanStep[]; cycle: null }
  | { steps: PlanStep[]; cycle: { ref: string; path: string[] } };

export type ResolvedRef =
  | { kind: 'rcm'; cfg: RunConfig }
  | { kind: 'launch'; launch: import('./NativeRunnerService').NativeLaunch }
  | { kind: 'task'; source: string; taskName: string };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function labelForRef(ref: string, cfgName?: string): string {
  if (cfgName) return cfgName;
  const parsed = parseDependencyRef(ref);
  if (!parsed) return ref;
  if (parsed.kind === 'launch') return parsed.key;
  if (parsed.kind === 'task') return `${parsed.taskName} (${parsed.source})`;
  return parsed.key;
}
