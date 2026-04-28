import * as vscode from 'vscode';
import type { RunConfigService } from './RunConfigService';
import type { RunConfig } from '../shared/types';
import type { ExecutionService } from './ExecutionService';
import type { DebugService } from './DebugService';
import type { DockerService } from './DockerService';
import { log } from '../utils/logger';

// Per-config state during a sequential group run. The tree reads these via
// `statusOfConfig()` and overlays the icon: queued shows a clock, starting
// shows a spinner, others fall through to the config's own running state.
export type GroupRunStatus = 'queued' | 'starting' | 'running' | 'failed' | 'skipped';

// Groups are derived: there's no separate store. A group exists whenever at
// least one config declares `group: <name>`. Consequences:
//   - "List groups" scans configs and dedupes by name.
//   - "Add to group" updates one config.
//   - "Delete group" clears the field on every member (configs survive —
//     the spec explicitly says delete removes the group, not the configs).
//   - "Rename group" rewrites the field on every member.
export class GroupService {
  // configId → status while a sequential group run is in flight. Cleared as
  // soon as the config transitions to running (tree then reflects the
  // actual running state) and fully wiped when the run finishes.
  private runStatus = new Map<string, GroupRunStatus>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onChanged = this.emitter.event;

  constructor(private readonly svc: RunConfigService) {}

  // Status read by the tree provider to pick a queued/starting icon.
  statusOfConfig(configId: string): GroupRunStatus | undefined {
    return this.runStatus.get(configId);
  }

  // Names of all groups in the given folder, sorted alphabetically.
  list(folderKey: string): string[] {
    const names = new Set<string>();
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      if (ref.folderKey !== folderKey) continue;
      const g = ref.config.group?.trim();
      if (g) names.add(g);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  // Configs belonging to the given group in a folder, in the order the
  // service returned them (matches on-disk order — users' intent).
  members(folderKey: string, groupName: string): RunConfig[] {
    const out: RunConfig[] = [];
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      if (ref.folderKey !== folderKey) continue;
      if (ref.config.group === groupName) out.push(ref.config);
    }
    return out;
  }

  async addToGroup(folderKey: string, configId: string, groupName: string): Promise<void> {
    const trimmed = groupName.trim();
    if (!trimmed) throw new Error('Group name cannot be empty.');
    const ref = this.svc.list().find(r => r.valid && r.folderKey === folderKey && r.config.id === configId);
    if (!ref || !ref.valid) throw new Error(`Config not found: ${configId}`);
    if (ref.config.group === trimmed) return; // no-op
    log.info(`Group: add "${ref.config.name}" to "${trimmed}"`);
    await this.svc.update(folderKey, { ...ref.config, group: trimmed });
  }

  async removeFromGroup(folderKey: string, configId: string): Promise<void> {
    const ref = this.svc.list().find(r => r.valid && r.folderKey === folderKey && r.config.id === configId);
    if (!ref || !ref.valid) throw new Error(`Config not found: ${configId}`);
    if (!ref.config.group) return;
    log.info(`Group: remove "${ref.config.name}" from "${ref.config.group}"`);
    const { group: _drop, ...rest } = ref.config;
    void _drop;
    await this.svc.update(folderKey, rest as RunConfig);
  }

  async renameGroup(folderKey: string, oldName: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Group name cannot be empty.');
    if (trimmed === oldName) return;
    const members = this.members(folderKey, oldName);
    log.info(`Group: rename "${oldName}" → "${trimmed}" (${members.length} member(s))`);
    for (const cfg of members) {
      await this.svc.update(folderKey, { ...cfg, group: trimmed });
    }
  }

  // Delete the group by clearing the field on every member. Configs
  // survive — they just go back to the ungrouped top-level listing.
  async deleteGroup(folderKey: string, groupName: string): Promise<void> {
    const members = this.members(folderKey, groupName);
    log.info(`Group: delete "${groupName}" (unassigning ${members.length} config(s))`);
    for (const cfg of members) {
      const { group: _drop, ...rest } = cfg;
      void _drop;
      await this.svc.update(folderKey, rest as RunConfig);
    }
  }

  // Run every member of a group. Two modes:
  //   - parallel: fire each config's start in parallel, don't wait between.
  //   - sequential: start one config, wait for it to reach running state
  //                 (reusing the adapters' own "isRunning / isStarted"
  //                 signals), then move to the next. If any member fails
  //                 the chain aborts and remaining configs are marked
  //                 skipped in the tree.
  //
  // Returns when all members have been dispatched (parallel) or the chain
  // completes/fails (sequential).
  async runGroup(
    folderKey: string,
    groupName: string,
    mode: 'sequential' | 'parallel',
    folder: vscode.WorkspaceFolder,
    deps: {
      exec: ExecutionService;
      dbg: DebugService;
      docker: DockerService;
    },
  ): Promise<void> {
    const members = this.members(folderKey, groupName);
    if (members.length === 0) {
      log.warn(`Group run: "${groupName}" has no members`);
      return;
    }
    log.info(`Group run (${mode}): "${groupName}" — ${members.length} member(s)`);

    if (mode === 'parallel') {
      // Queue-state icon briefly blinks — we set all to 'starting' up
      // front and clear as each kicks off. Concurrent start-up means
      // meaningful per-config sequencing isn't possible here anyway.
      for (const cfg of members) this.runStatus.set(cfg.id, 'starting');
      this.emitter.fire();
      await Promise.all(members.map(async cfg => {
        try {
          await this.startOne(cfg, folder, deps);
        } catch (e) {
          log.error(`Group run (parallel): "${cfg.name}" failed`, e);
          this.runStatus.set(cfg.id, 'failed');
          this.emitter.fire();
          return;
        }
        this.runStatus.delete(cfg.id);
        this.emitter.fire();
      }));
      this.runStatus.clear();
      this.emitter.fire();
      return;
    }

    // Sequential — mark every member as queued up front so the tree
    // instantly shows the full pipeline.
    for (const cfg of members) this.runStatus.set(cfg.id, 'queued');
    this.emitter.fire();

    let failed = false;
    for (const cfg of members) {
      if (failed) {
        this.runStatus.set(cfg.id, 'skipped');
        this.emitter.fire();
        continue;
      }
      this.runStatus.set(cfg.id, 'starting');
      this.emitter.fire();
      try {
        await this.startOne(cfg, folder, deps);
        await this.waitUntilRunning(cfg, deps);
        this.runStatus.set(cfg.id, 'running');
        this.emitter.fire();
      } catch (e) {
        log.error(`Group run (sequential): "${cfg.name}" failed`, e);
        this.runStatus.set(cfg.id, 'failed');
        this.emitter.fire();
        vscode.window.showErrorMessage(
          `Group "${groupName}": "${cfg.name}" failed to start — remaining configs skipped. ${(e as Error).message}`,
        );
        failed = true;
      }
    }

    // Brief linger so the user sees the final state, then clear so the
    // tree reverts to plain running/idle icons driven by the per-service
    // state channels.
    setTimeout(() => {
      this.runStatus.clear();
      this.emitter.fire();
    }, 1500);
  }

  private async startOne(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    deps: { exec: ExecutionService; dbg: DebugService; docker: DockerService },
  ): Promise<void> {
    if (cfg.type === 'docker') {
      if (deps.docker.isRunning(cfg.typeOptions.containerId)) return;
      await deps.docker.startContainer(cfg.typeOptions.containerId);
      return;
    }
    if (deps.exec.isRunning(cfg.id) || deps.dbg.isRunning(cfg.id)) return;
    await deps.exec.run(cfg, folder);
  }

  private async waitUntilRunning(
    cfg: RunConfig,
    deps: { exec: ExecutionService; dbg: DebugService; docker: DockerService },
  ): Promise<void> {
    // 120s cap — same budget as DependencyOrchestrator. Polling is cheap
    // (in-memory Set lookups); 250ms gives near-instant progress.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (cfg.type === 'docker') {
        if (deps.docker.isRunning(cfg.typeOptions.containerId)) return;
      } else if (deps.exec.isStarted(cfg.id) || deps.exec.isRunning(cfg.id)) {
        return;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`"${cfg.name}" did not reach running state within 120s.`);
  }
}
