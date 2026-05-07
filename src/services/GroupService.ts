import * as vscode from 'vscode';
import type { RunConfigService } from './RunConfigService';
import type { RunConfig } from '../shared/types';
import type { ExecutionService } from './ExecutionService';
import type { DebugService } from './DebugService';
import type { DockerService } from './DockerService';
import type { DependencyOrchestrator } from './DependencyOrchestrator';
import { log } from '../utils/logger';
import {
  ancestorPaths,
  isStrictDescendant,
  isValidFolderPath,
  splitFolderPath,
} from '../shared/folderPath';

// Per-config state during a sequential group run. The tree reads these via
// `statusOfConfig()` and overlays the icon: queued shows a clock, starting
// shows a spinner, others fall through to the config's own running state.
export type GroupRunStatus = 'queued' | 'starting' | 'running' | 'failed' | 'skipped';

// Folders ("groups") are slash-separated paths stored on `config.group`.
// To support empty / freshly-created folders we additionally persist the
// full list of known paths in `RunFile.groups` — derived from configs
// when missing on disk. RunConfigService.knownFolders / setKnownFolders
// owns the persistence; this service handles the tree-shaped semantics
// (parents, descendants, recursive members) and the run-all walk.
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

  // Every known folder path (sorted), including ancestors of paths
  // referenced only via configs and explicitly-created empty folders.
  // The union ensures freshly-created folders (without any members
  // yet) still show up.
  list(folderKey: string): string[] {
    const out = new Set<string>();
    for (const p of this.svc.knownFolders(folderKey)) {
      for (const a of ancestorPaths(p)) out.add(a);
    }
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      if (ref.folderKey !== folderKey) continue;
      const g = ref.config.group?.trim();
      if (!g) continue;
      for (const a of ancestorPaths(g)) out.add(a);
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  // Direct child folder paths of `parentPath` (or top-level when
  // parentPath is empty). The tree provider uses this to build the
  // nested folder hierarchy without recomputing it per render.
  childFolders(folderKey: string, parentPath: string): string[] {
    const all = this.list(folderKey);
    const prefix = parentPath ? parentPath + '/' : '';
    const depth = parentPath ? splitFolderPath(parentPath).length : 0;
    return all.filter(p => {
      if (!p.startsWith(prefix)) return false;
      const segs = splitFolderPath(p);
      return segs.length === depth + 1;
    });
  }

  // Configs belonging to a folder.
  // - recursive: when true, also include configs nested in sub-folders
  //   so "Run all" on a parent folder walks the whole subtree.
  members(folderKey: string, groupPath: string, opts?: { recursive?: boolean }): RunConfig[] {
    const out: RunConfig[] = [];
    const recursive = opts?.recursive === true;
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      if (ref.folderKey !== folderKey) continue;
      const g = ref.config.group ?? '';
      if (g === groupPath) { out.push(ref.config); continue; }
      if (recursive && isStrictDescendant(g, groupPath)) out.push(ref.config);
    }
    return out;
  }

  async addToGroup(folderKey: string, configId: string, groupName: string): Promise<void> {
    const trimmed = groupName.trim();
    if (!trimmed) throw new Error('Group name cannot be empty.');
    if (!isValidFolderPath(trimmed)) {
      throw new Error('Folder paths use "/" as separator; segments cannot be empty or only whitespace.');
    }
    const ref = this.svc.list().find(r => r.valid && r.folderKey === folderKey && r.config.id === configId);
    if (!ref || !ref.valid) throw new Error(`Config not found: ${configId}`);
    if (ref.config.group === trimmed) return; // no-op
    log.info(`Group: add "${ref.config.name}" to "${trimmed}"`);
    // Make sure the folder (and all its ancestors) are marked as
    // known so an empty subfolder created via "Add to group …" still
    // renders even before another config joins.
    await this.ensureFoldersExist(folderKey, [trimmed]);
    await this.svc.update(folderKey, { ...ref.config, group: trimmed });
  }

  // Move a folder (and every descendant) to a new parent path. Used
  // by drag-and-drop to drop a folder into another folder ("nest")
  // or back to top-level (parent = ""). Implementation is a chain of
  // group-rewrites: every config / known-folder path that starts
  // with `oldPath` gets the prefix rewritten.
  //
  // Cycle guard: nesting a folder into one of its own descendants
  // would produce an infinite path. We reject that case explicitly.
  async moveFolder(folderKey: string, oldPath: string, newParent: string): Promise<void> {
    const trimmedOld = oldPath.trim();
    const trimmedParent = newParent.trim();
    if (!trimmedOld) return;
    if (trimmedParent && !isValidFolderPath(trimmedParent)) {
      throw new Error('Invalid destination folder path.');
    }
    if (trimmedParent === trimmedOld || isStrictDescendant(trimmedParent, trimmedOld)) {
      throw new Error('Cannot drop a folder into itself or one of its descendants.');
    }
    // Compute the new full path: parent + last segment of oldPath.
    const lastSeg = trimmedOld.includes('/')
      ? trimmedOld.slice(trimmedOld.lastIndexOf('/') + 1)
      : trimmedOld;
    const newPath = trimmedParent ? `${trimmedParent}/${lastSeg}` : lastSeg;
    if (newPath === trimmedOld) return; // no-op (already there)
    log.info(`Group: move folder "${trimmedOld}" → "${newPath}"`);
    await this.renameGroup(folderKey, trimmedOld, newPath);
  }

  // Move a config to a different folder (or back to top-level when
  // newPath is empty). Used both by the right-click "Move…" command
  // and the drag-and-drop controller.
  async moveConfig(folderKey: string, configId: string, newPath: string): Promise<void> {
    const trimmed = newPath.trim();
    if (trimmed && !isValidFolderPath(trimmed)) {
      throw new Error('Invalid folder path.');
    }
    const ref = this.svc.list().find(r => r.valid && r.folderKey === folderKey && r.config.id === configId);
    if (!ref || !ref.valid) throw new Error(`Config not found: ${configId}`);
    if ((ref.config.group ?? '') === trimmed) return;
    log.info(`Group: move "${ref.config.name}" → "${trimmed || '(top level)'}"`);
    if (trimmed) await this.ensureFoldersExist(folderKey, [trimmed]);
    const next = trimmed
      ? { ...ref.config, group: trimmed }
      : (() => { const { group: _drop, ...rest } = ref.config; void _drop; return rest as RunConfig; })();
    await this.svc.update(folderKey, next);
  }

  // Create a folder. Persists the path (and all ancestors) into
  // RunFile.groups so the empty folder survives across reloads.
  async addFolder(folderKey: string, path: string): Promise<void> {
    const trimmed = path.trim();
    if (!isValidFolderPath(trimmed)) {
      throw new Error('Invalid folder path.');
    }
    log.info(`Group: create folder "${trimmed}"`);
    await this.ensureFoldersExist(folderKey, [trimmed]);
  }

  // Remove a folder (and all its descendants) from the known list,
  // and unassign every config whose group equals one of those paths.
  // The configs themselves survive — "deleting a group keeps the
  // configs" was explicit in the spec.
  async deleteFolder(folderKey: string, path: string): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed) return;
    log.info(`Group: delete folder "${trimmed}" (and any descendants)`);
    // 1. Walk every config whose group sits in this subtree, drop the field.
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      if (ref.folderKey !== folderKey) continue;
      const g = ref.config.group ?? '';
      if (g === trimmed || isStrictDescendant(g, trimmed)) {
        const { group: _drop, ...rest } = ref.config;
        void _drop;
        await this.svc.update(folderKey, rest as RunConfig);
      }
    }
    // 2. Strip the folder + descendants from the known list.
    const known = this.svc.knownFolders(folderKey);
    const next = known.filter(p => p !== trimmed && !isStrictDescendant(p, trimmed));
    if (next.length !== known.length) {
      await this.svc.setKnownFolders(folderKey, next);
    }
  }

  // Internal: append the path + every ancestor to RunFile.groups (no
  // duplicates). Used by addFolder, addToGroup, moveConfig.
  private async ensureFoldersExist(folderKey: string, paths: string[]): Promise<void> {
    const known = new Set(this.svc.knownFolders(folderKey));
    let added = false;
    for (const p of paths) {
      for (const a of ancestorPaths(p)) {
        if (!known.has(a)) { known.add(a); added = true; }
      }
    }
    if (added) await this.svc.setKnownFolders(folderKey, [...known]);
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
    if (!isValidFolderPath(trimmed)) {
      throw new Error('Folder paths use "/" as separator; segments cannot be empty.');
    }
    if (trimmed === oldName) return;
    // Renaming a folder also moves every descendant. "A/B" renamed to
    // "C" → "A/B/X" becomes "C/X".
    const renames: Array<{ from: string; to: string }> = [];
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      if (ref.folderKey !== folderKey) continue;
      const g = ref.config.group ?? '';
      if (g === oldName) renames.push({ from: g, to: trimmed });
      else if (isStrictDescendant(g, oldName)) {
        renames.push({ from: g, to: trimmed + g.slice(oldName.length) });
      }
    }
    log.info(`Group: rename "${oldName}" → "${trimmed}" (${renames.length} member(s))`);
    for (const { from: _from } of renames) void _from; // satisfy ts noUnused
    for (const ref of this.svc.list()) {
      if (!ref.valid || ref.folderKey !== folderKey) continue;
      const g = ref.config.group ?? '';
      if (g === oldName) {
        await this.svc.update(folderKey, { ...ref.config, group: trimmed });
      } else if (isStrictDescendant(g, oldName)) {
        await this.svc.update(folderKey, { ...ref.config, group: trimmed + g.slice(oldName.length) });
      }
    }
    // Update the known-folders list: remove old prefixes, add new
    // prefixes (so empty subfolders rename too).
    const known = this.svc.knownFolders(folderKey);
    const next = known.map(p => {
      if (p === oldName) return trimmed;
      if (isStrictDescendant(p, oldName)) return trimmed + p.slice(oldName.length);
      return p;
    });
    await this.svc.setKnownFolders(folderKey, next);
  }

  // Delete the group by clearing the field on every member. Configs
  // survive — they just go back to the ungrouped top-level listing.
  // Equivalent to deleteFolder; kept as a backward-compatible name
  // for callers that still say "delete group".
  async deleteGroup(folderKey: string, groupName: string): Promise<void> {
    return this.deleteFolder(folderKey, groupName);
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
      // When a group member has a `dependsOn` chain, we route through the
      // orchestrator so its deps get started first (matching what happens
      // when the user clicks Run on the member individually). Without
      // this, group runs would skip dependency resolution entirely and
      // members silently fail to reach running state.
      orchestrator: DependencyOrchestrator;
    },
  ): Promise<void> {
    // Recursive walk: running a parent folder runs everything in its
    // subtree, matching the UX of "Run all" inside an IDE folder.
    const members = this.members(folderKey, groupName, { recursive: true });
    if (members.length === 0) {
      log.warn(`Group run: "${groupName}" has no members (incl. subfolders)`);
      return;
    }
    log.info(`Group run (${mode}): "${groupName}" — ${members.length} member(s) including subfolders`);

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
    deps: { exec: ExecutionService; dbg: DebugService; docker: DockerService; orchestrator: DependencyOrchestrator },
  ): Promise<void> {
    // Route through the orchestrator when the member has declared
    // dependencies — mirrors what `runConfig.run` does for individual
    // clicks. This ensures deps are started (and waited on) before the
    // member itself is kicked off, even during a group run.
    if ((cfg.dependsOn?.length ?? 0) > 0) {
      // Short-circuit: if already running, the orchestrator's
      // startRcmConfig would no-op, but avoid the plan walk too.
      if (cfg.type === 'docker' && deps.docker.isRunning(cfg.typeOptions.containerId)) return;
      if (cfg.type !== 'docker' && (deps.exec.isRunning(cfg.id) || deps.dbg.isRunning(cfg.id))) return;
      await deps.orchestrator.run(cfg, folder);
      return;
    }

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
    deps: { exec: ExecutionService; dbg: DebugService; docker: DockerService; orchestrator: DependencyOrchestrator },
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
