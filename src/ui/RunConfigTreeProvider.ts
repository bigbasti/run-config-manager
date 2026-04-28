import * as vscode from 'vscode';
import type { RunConfigService } from '../services/RunConfigService';
import type { ConfigStore } from '../services/ConfigStore';
import type { ExecutionService } from '../services/ExecutionService';
import type { DebugService } from '../services/DebugService';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { DockerService } from '../services/DockerService';
import type { DependencyOrchestrator, OrchestrationStatus } from '../services/DependencyOrchestrator';
import type { NativeRunnerService } from '../services/NativeRunnerService';
import { parseDependencyRef, rcmRef } from '../services/dependencyCandidates';
import { resolveBuildContext, resolveNpmContext } from '../services/buildActions';
import { buildCommandPreview } from '../shared/buildCommandPreview';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';
import { iconForConfig, brandIconUri } from './iconForConfig';
import { checkConfigHealth, peekConfigHealth, type ConfigHealth } from '../services/configHealth';
import { log } from '../utils/logger';

export type Node =
  | { kind: 'folder'; folderKey: string; label: string }
  | { kind: 'typeGroup'; folderKey: string; type: RunConfig['type']; label: string; count: number }
  | { kind: 'config'; folderKey: string; config: RunConfig }
  | { kind: 'invalid'; folderKey: string; entry: InvalidConfigEntry }
  // A dependency child under a config node. Four flavours:
  //   - rcm:   another run configuration defined in RCM.
  //   - launch/task: pointer into VS Code's native launch.json / tasks.json.
  //   - missing: the ref no longer resolves (renamed/removed).
  // The rootId is the RCM config the chain started from — we carry it so
  // orchestration status can be looked up without an extra search.
  | { kind: 'depRcm'; rootId: string; parentKey: string; ref: string; config: RunConfig; delaySeconds: number; depth: number }
  | { kind: 'depLaunch'; rootId: string; parentKey: string; ref: string; launchName: string; launchType?: string; delaySeconds: number; depth: number }
  | { kind: 'depTask'; rootId: string; parentKey: string; ref: string; source: string; taskName: string; delaySeconds: number; depth: number }
  | { kind: 'depMissing'; rootId: string; parentKey: string; ref: string; delaySeconds: number; depth: number };

export class RunConfigTreeProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  // Tracks which config ids have an in-flight health probe, so we don't kick
  // a second probe while the first is running (each render calls getTreeItem).
  private pendingHealthProbes = new Set<string>();

  constructor(
    private readonly store: ConfigStore,
    private readonly svc: RunConfigService,
    private readonly exec: ExecutionService,
    private readonly dbg: DebugService,
    private readonly registry: AdapterRegistry,
    // Needed so we can build absolute URIs to the bundled brand SVGs under
    // media/icons/. Passed in from extension.ts activate().
    private readonly extensionUri: vscode.Uri,
    // Running-state source for docker configs. Separate from ExecutionService
    // because start/stop semantics differ (no long-running task wrapper).
    private readonly docker: DockerService,
    private readonly orchestrator: DependencyOrchestrator,
    private readonly native: NativeRunnerService,
  ) {
    store.onChange(() => this.refresh());
    exec.onRunningChanged(() => this.refresh());
    dbg.onRunningChanged(() => this.refresh());
    docker.onChanged(() => this.refresh());
    orchestrator.onChanged(() => this.refresh());
    native.onRunningChanged(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'depRcm' || n.kind === 'depLaunch' || n.kind === 'depTask' || n.kind === 'depMissing') {
      return this.renderDepItem(n);
    }
    if (n.kind === 'folder') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'folder';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    if (n.kind === 'typeGroup') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `(${n.count})`;
      item.contextValue = 'typeGroup';
      // Brand icon from media/icons/ (the npm icon for plain npm groups;
      // the specific brand — Spring Boot, Tomcat, etc. — for every other
      // type). No sub-type detection here because a group spans multiple
      // configs that may belong to different frameworks. Use the shared
      // helper so gradle / java pick up their light-theme variants.
      item.iconPath = brandIconUri(iconForGroupType(n.type), this.extensionUri);
      return item;
    }
    if (n.kind === 'invalid') {
      const item = new vscode.TreeItem(n.entry.name, vscode.TreeItemCollapsibleState.None);
      const shortErr = n.entry.error.length > 80 ? n.entry.error.slice(0, 77) + '…' : n.entry.error;
      item.description = `(invalid — ${shortErr})`;
      item.tooltip = `${n.entry.error}\n\n${n.entry.rawText.slice(0, 400)}`;
      item.iconPath = new vscode.ThemeIcon('warning');
      item.contextValue = 'configInvalid';
      item.command = { command: 'runConfig.edit', title: 'Edit', arguments: [n] };
      return item;
    }

    // Docker configs have different lifecycle semantics than every other type
    // — start/stop aren't backed by a long-running task, running-state comes
    // from polling the daemon, and clicking the row should show logs rather
    // than open the editor. Render them down a separate short-circuit path.
    if (n.config.type === 'docker') {
      return this.renderDockerItem(n);
    }

    const preparing = this.exec.isPreparing(n.config.id);
    const running = this.exec.isRunning(n.config.id) || this.dbg.isRunning(n.config.id);
    const started = this.exec.isStarted(n.config.id);
    const failed = this.exec.isFailed(n.config.id);
    const rebuilding = this.exec.isRebuilding(n.config.id);
    const adapter = this.registry.get(n.config.type);
    const debuggable = adapter?.supportsDebug === true;
    // Stale-config check: consult the synchronous cache first; the async
    // probe (kicked off below when it hasn't run) refreshes the view once
    // the result is in. Keeps the initial render instant and the later
    // re-render updates the icon / tooltip in place.
    const folder = this.store.getFolder(n.folderKey);
    const health = folder ? peekConfigHealth(n.config, folder) : undefined;
    if (folder && health === undefined && !this.pendingHealthProbes.has(n.config.id)) {
      this.pendingHealthProbes.add(n.config.id);
      checkConfigHealth(n.config, folder)
        .catch(e => { log.warn(`configHealth probe failed for ${n.config.name}: ${(e as Error).message}`); return { healthy: true } as ConfigHealth; })
        .finally(() => {
          this.pendingHealthProbes.delete(n.config.id);
          this.refresh();
        });
    }
    const stale = health && health.healthy === false ? health : null;

    // Configs become collapsible when they either (a) declare dependencies
    // or (b) have a Maven/Gradle build tool the user can trigger via the
    // Clean/Build/Test shortcuts. While an orchestration is active for
    // this root we force Expanded; once it clears we revert to Collapsed.
    //
    // VS Code caches collapsibleState per node id. To make state changes
    // actually take effect we mint a different id whenever the active-flag
    // flips — the new id makes VS Code treat this as a fresh node and
    // respect the collapsibleState we set.
    const hasDeps = (n.config.dependsOn?.length ?? 0) > 0;
    // Build tool (maven/gradle) — surfaced via the contextValue suffix so
    // the right-click menu can light up Clean/Build/Test for JVM configs.
    // Not a reason to make the config row collapsible; those actions live
    // in the context menu, not in a sub-tree.
    const buildCtx = folder ? resolveBuildContext(n.config, folder) : null;
    const orchActive = this.orchestrator.snapshotOf(n.config.id) !== undefined;
    const collapsibleState = !hasDeps
      ? vscode.TreeItemCollapsibleState.None
      : orchActive
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(n.config.name, collapsibleState);
    if (hasDeps) {
      // Reuse the same id normally so user-driven expand/collapse sticks,
      // but flip to a state-tagged id while orchestration is active so the
      // forced-expanded state wins. When the orchestration finishes the
      // id flips back → VS Code treats it as a different node again and
      // reverts to the stored default (collapsed).
      item.id = orchActive
        ? `config:${n.config.id}:orch`
        : `config:${n.config.id}`;
    }
    item.tooltip = new vscode.MarkdownString(
      `**${n.config.name}** _(${n.config.type})_\n\n` +
      (n.config.projectPath ? `Path: \`${n.config.projectPath}\`\n\n` : '') +
      `Command: \`${buildCommandPreview(n.config)}\`` +
      (stale ? `\n\n⚠ **Config may be stale.** ${stale.reason}` : '') +
      (preparing
        ? '\n\n_Preparing (running build / writing scaffold)…_'
        : rebuilding
        ? '\n\n_Rebuilding — dev server detected a file change._'
        : failed
        ? '\n\n_Startup failed — see terminal for details._'
        : running && !started
        ? '\n\n_Starting…_'
        : started
        ? '\n\n_Running._'
        : ''),
    );
    // Visual states, in order of precedence:
    //   preparing  (blue sync-spin + "Preparing…")
    //   rebuilding (yellow sync-spin — dev server is recompiling on change)
    //   failed     (red error — log scanner matched a failure banner)
    //   starting   (loading-spin — running, no ready signal yet)
    //   started    (green pass-filled — ready pattern matched)
    //   idle       (type icon)
    //
    // Rebuilding sits above failed because a user-initiated save-and-rebuild
    // is a transient in-flight state even if the previous build was red;
    // keeping the icon red while the dev server is actively working would
    // misrepresent the situation.
    if (preparing) {
      item.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
      item.description = 'Preparing…';
    } else if (rebuilding) {
      item.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
      item.description = 'Rebuilding…';
    } else if (failed) {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      item.description = 'Failed';
    } else if (running && !started) {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.description = 'Starting…';
    } else if (started) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
      item.description = undefined;
    } else if (stale) {
      // Idle + stale: surface the warning as the idle-state signal. The
      // tooltip explains; the description nudges the user to re-create the
      // config without claiming we'll do it for them.
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      item.description = 'Stale — re-create to fix';
    } else {
      // Idle — show the brand icon so the user can visually scan npm /
      // Angular / Spring Boot / Gradle / etc. at a glance. Brand icon
      // resolution sniffs config-file tell-tales + package.json scripts
      // for npm configs to pick the specific framework (Angular, Vite,
      // Next, Svelte, Vue, React, Node).
      item.iconPath = iconForConfig(n.config, folder, this.extensionUri);
      item.description = undefined;
    }
    // The contextValue encodes three flags the context menu's `when`
    // clauses key on:
    //   - runtime state: Idle | Running
    //   - debuggability: debuggable adapters omit the NoDebug suffix
    //   - tool suffix:   `:maven`, `:gradle`, or `:npm` when resolvable
    //                    (context menu lights up tool-specific actions).
    const baseContextValue = (preparing || running)
      ? debuggable ? 'configRunning' : 'configRunningNoDebug'
      : debuggable ? 'configIdle' : 'configIdleNoDebug';
    const npmCtx = !buildCtx && folder ? resolveNpmContext(n.config, folder) : null;
    const toolSuffix = buildCtx ? `:${buildCtx.tool}` : npmCtx ? ':npm' : '';
    item.contextValue = `${baseContextValue}${toolSuffix}`;
    // Click behavior: running/preparing configs reveal the task terminal;
    // idle configs open the editor. The inline Edit button always opens the
    // editor regardless of state.
    item.command = (running || preparing)
      ? { command: 'runConfig.reveal', title: 'Reveal terminal', arguments: [n] }
      : { command: 'runConfig.edit', title: 'Edit', arguments: [n] };
    return item;
  }

  private renderDockerItem(n: Extract<Node, { kind: 'config' }>): vscode.TreeItem {
    if (n.config.type !== 'docker') throw new Error('renderDockerItem: non-docker config');
    const to = n.config.typeOptions;
    const summary = this.docker.find(to.containerId);
    const running = this.docker.isRunning(to.containerId);
    const item = new vscode.TreeItem(n.config.name, vscode.TreeItemCollapsibleState.None);

    const tipLines = [
      `**${n.config.name}** _(docker)_`,
      '',
      `Container: \`${to.containerId.slice(0, 12) || '(none)'}\`${summary?.name ? ` (${summary.name})` : to.containerName ? ` (${to.containerName}, last seen)` : ''}`,
    ];
    if (summary) {
      tipLines.push(`Image: \`${summary.image}\``);
      tipLines.push(`Status: ${summary.status}`);
      if (summary.ports) tipLines.push(`Ports: \`${summary.ports}\``);
    } else if (this.docker.isAvailable() === false) {
      tipLines.push('');
      tipLines.push('⚠ Docker daemon unreachable.');
    } else if (to.containerId) {
      tipLines.push('');
      tipLines.push('⚠ Container not found. It may have been removed — re-create the config.');
    }
    tipLines.push('');
    tipLines.push('Click to open logs. Inline buttons: Run / Stop / Edit.');
    item.tooltip = new vscode.MarkdownString(tipLines.join('\n'));

    // Idle configs get the Docker brand SVG (media/icons/docker.svg),
    // matching how every other type renders when idle. Running state
    // overrides with the green pass-filled marker; "container missing" is
    // the one exception — the warning icon is more informative than the
    // brand icon when the saved id no longer exists on this machine.
    const folder = this.store.getFolder(n.folderKey);
    if (running) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
      item.description = summary?.image ?? 'running';
      item.contextValue = 'dockerRunning';
    } else if (!summary && to.containerId) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      item.description = 'not found';
      item.contextValue = 'dockerIdle';
    } else {
      item.iconPath = iconForConfig(n.config, folder, this.extensionUri);
      item.description = summary?.status || (summary?.state ?? 'stopped');
      item.contextValue = 'dockerIdle';
    }

    // Single click → open the log tail. Edit is available via the inline
    // button declared in package.json for dockerIdle/dockerRunning.
    item.command = {
      command: 'runConfig.viewDockerLogs',
      title: 'View logs',
      arguments: [n],
    };
    return item;
  }

  private renderDepItem(
    n: Extract<Node, { kind: 'depRcm' | 'depLaunch' | 'depTask' | 'depMissing' }>,
  ): vscode.TreeItem {
    const snap = this.orchestrator.snapshotOf(n.rootId);
    const status: OrchestrationStatus | undefined = snap?.statuses.get(n.ref);
    const reason = snap?.reasons.get(n.ref);
    const delayLabel = n.delaySeconds > 0 ? ` · +${n.delaySeconds}s` : '';

    if (n.kind === 'depMissing') {
      const item = new vscode.TreeItem(n.ref, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      item.description = 'missing dependency';
      item.tooltip = new vscode.MarkdownString(
        `**Missing dependency**\n\n` +
        `Ref: \`${n.ref}\`\n\n` +
        `This referenced config/launch/task could not be resolved — it may have been renamed or removed. ` +
        `Edit the parent config to fix.`,
      );
      item.contextValue = 'depMissing';
      return item;
    }

    if (n.kind === 'depLaunch') {
      const item = new vscode.TreeItem(n.launchName, vscode.TreeItemCollapsibleState.None);
      const running = this.native.isLaunchRunning(n.launchName);
      item.iconPath = iconForDepStatus(status, running)
        ?? new vscode.ThemeIcon('debug-alt');
      item.description = `launch · ${n.launchType ?? 'launch'}${delayLabel}${running ? ' · running' : ''}`;
      item.tooltip = depTooltip('Launch configuration', n.launchName, status, reason, n.delaySeconds);
      item.contextValue = running ? 'depLaunchRunning' : 'depLaunchIdle';
      return item;
    }

    if (n.kind === 'depTask') {
      const item = new vscode.TreeItem(n.taskName, vscode.TreeItemCollapsibleState.None);
      const running = this.native.isTaskRunning(n.source, n.taskName);
      item.iconPath = iconForDepStatus(status, running)
        ?? new vscode.ThemeIcon('tools');
      item.description = `task · ${n.source}${delayLabel}${running ? ' · running' : ''}`;
      item.tooltip = depTooltip('Task', `${n.taskName} (${n.source})`, status, reason, n.delaySeconds);
      item.contextValue = running ? 'depTaskRunning' : 'depTaskIdle';
      return item;
    }

    // depRcm — recurse by making this node collapsible if it has its own
    // deps. While the owning orchestration is active we force this node
    // Expanded so the whole tree opens up; when it clears we flip back to
    // Collapsed (the id change makes VS Code re-read the state — see the
    // config-node path above for the rationale).
    const cfg = n.config;
    const hasOwnDeps = (cfg.dependsOn?.length ?? 0) > 0;
    const folderForCfg = this.store.getFolder(this.folderKeyOf(cfg));
    const buildCtx = folderForCfg ? resolveBuildContext(cfg, folderForCfg) : null;
    const orchActive = this.orchestrator.snapshotOf(n.rootId) !== undefined;
    const state = !hasOwnDeps
      ? vscode.TreeItemCollapsibleState.None
      : orchActive
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(cfg.name, state);
    if (hasOwnDeps) {
      item.id = orchActive
        ? `dep:${n.rootId}:${n.parentKey}:${cfg.id}:orch`
        : `dep:${n.rootId}:${n.parentKey}:${cfg.id}`;
    }
    const running = cfg.type === 'docker'
      ? this.docker.isRunning(cfg.typeOptions.containerId)
      : (this.exec.isRunning(cfg.id) || this.dbg.isRunning(cfg.id));
    item.iconPath = iconForDepStatus(status, running)
      ?? iconForConfig(cfg, this.store.getFolder(this.folderKeyOf(cfg)), this.extensionUri);
    item.description = `${cfg.type}${delayLabel}${running ? ' · running' : ''}`;
    item.tooltip = depTooltip('Run configuration', cfg.name, status, reason, n.delaySeconds);
    const depBase = running ? 'depRcmRunning' : 'depRcmIdle';
    item.contextValue = buildCtx ? `${depBase}:${buildCtx.tool}` : depBase;
    return item;
  }

  // Best-effort lookup of which folder a RunConfig belongs to — used for
  // icon resolution on dep-rcm nodes. We match on the stored workspaceFolder
  // name first, then fall back to the first known folder.
  private folderKeyOf(cfg: RunConfig): string {
    const keys = this.store.folderKeys();
    const match = keys.find(k => this.store.getFolder(k)?.name === cfg.workspaceFolder);
    return match ?? keys[0] ?? '';
  }

  getChildren(parent?: Node): Node[] {
    if (!parent) {
      const keys = this.store.folderKeys();
      if (keys.length <= 1) {
        return keys.flatMap(key => this.rootNodes(key));
      }
      return keys.map(key => {
        const label = this.store.getFolder(key)?.name ?? key;
        return { kind: 'folder', folderKey: key, label } as const;
      });
    }
    if (parent.kind === 'folder') return this.rootNodes(parent.folderKey);
    if (parent.kind === 'typeGroup') {
      return this.configsOfType(parent.folderKey, parent.type);
    }
    if (parent.kind === 'config') {
      return this.depChildren(parent.config, parent.config.id, 1, parent.config.workspaceFolder);
    }
    if (parent.kind === 'depRcm') {
      // RCM-config deps can themselves have deps — recurse another level.
      return this.depChildren(parent.config, parent.rootId, parent.depth + 1, parent.config.workspaceFolder);
    }
    return [];
  }

  // Build child nodes for a config whose dependsOn list is non-empty. Each
  // entry becomes a depRcm / depLaunch / depTask / depMissing node based on
  // what the ref resolves to. Depth is capped at 10 to guard against
  // pathological self-referencing configs (the orchestrator itself detects
  // cycles; this is a UI-only safety net).
  private depChildren(cfg: RunConfig, rootId: string, depth: number, folderName: string): Node[] {
    const deps = cfg.dependsOn ?? [];
    if (depth > 10) return [];
    const parentKey = cfg.id;
    const out: Node[] = [];
    for (const dep of deps) {
      const resolved = this.orchestrator.resolve(dep.ref, folderName);
      if (!resolved) {
        out.push({
          kind: 'depMissing',
          rootId,
          parentKey,
          ref: dep.ref,
          delaySeconds: dep.delaySeconds ?? 0,
          depth,
        });
        continue;
      }
      if (resolved.kind === 'rcm') {
        out.push({
          kind: 'depRcm',
          rootId,
          parentKey,
          ref: dep.ref,
          config: resolved.cfg,
          delaySeconds: dep.delaySeconds ?? 0,
          depth,
        });
      } else if (resolved.kind === 'launch') {
        out.push({
          kind: 'depLaunch',
          rootId,
          parentKey,
          ref: dep.ref,
          launchName: resolved.launch.name,
          launchType: resolved.launch.launchType,
          delaySeconds: dep.delaySeconds ?? 0,
          depth,
        });
      } else {
        out.push({
          kind: 'depTask',
          rootId,
          parentKey,
          ref: dep.ref,
          source: resolved.source,
          taskName: resolved.taskName,
          delaySeconds: dep.delaySeconds ?? 0,
          depth,
        });
      }
    }
    return out;
  }

  // Root (or per-folder) nodes: each type with >1 config becomes a group;
  // single-config types render the config directly; invalid entries always
  // render at the end (they aren't grouped — they're anomalies).
  private rootNodes(folderKey: string): Node[] {
    const file = this.store.getForFolder(folderKey);
    const invalid = this.store.invalidForFolder(folderKey);
    const byType = new Map<RunConfig['type'], RunConfig[]>();
    for (const cfg of file.configurations) {
      const bucket = byType.get(cfg.type) ?? [];
      bucket.push(cfg);
      byType.set(cfg.type, bucket);
    }
    const out: Node[] = [];
    for (const [type, bucket] of byType) {
      if (bucket.length > 1) {
        out.push({
          kind: 'typeGroup',
          folderKey,
          type,
          label: labelForType(type),
          count: bucket.length,
        });
      } else {
        for (const config of bucket) {
          out.push({ kind: 'config', folderKey, config });
        }
      }
    }
    for (const entry of invalid) {
      out.push({ kind: 'invalid', folderKey, entry });
    }
    return out;
  }

  private configsOfType(folderKey: string, type: RunConfig['type']): Node[] {
    const file = this.store.getForFolder(folderKey);
    return file.configurations
      .filter(c => c.type === type)
      .map(config => ({ kind: 'config', folderKey, config } as const));
  }
}

function labelForType(type: RunConfig['type']): string {
  switch (type) {
    case 'npm': return 'npm / Node.js';
    case 'spring-boot': return 'Spring Boot';
    case 'tomcat': return 'Tomcat';
    case 'quarkus': return 'Quarkus';
    case 'java': return 'Java Application';
    case 'maven-goal': return 'Maven Goal';
    case 'gradle-task': return 'Gradle Task';
    case 'custom-command': return 'Custom Command';
    case 'docker': return 'Docker';
    default: return type;
  }
}

// Brand SVG basename for a type-group header. Per-config icons (including
// Angular / Vite / Next / etc. sub-type detection for npm) go through
// iconForConfig.
function iconForGroupType(type: string): string {
  switch (type) {
    case 'npm': return 'npm';
    case 'spring-boot': return 'spring-boot';
    case 'tomcat': return 'tomcat';
    case 'quarkus': return 'quarkus';
    case 'java': return 'java';
    case 'maven-goal': return 'maven';
    case 'gradle-task': return 'gradle';
    case 'custom-command': return 'bash';
    case 'docker': return 'docker';
    default: return 'npm';
  }
}


// Overlay the orchestration status on top of the default icon for a dep
// node. Returning undefined lets the caller fall back to its normal icon
// (launch/debug-alt, tools, brand SVG for rcm).
function iconForDepStatus(
  status: OrchestrationStatus | undefined,
  runningNow: boolean,
): vscode.ThemeIcon | undefined {
  if (!status) {
    // No active orchestration: if the dep already looks running (user
    // started it manually, or a previous orchestration finished), keep the
    // tree honest about that.
    return runningNow
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
      : undefined;
  }
  switch (status) {
    case 'waiting':
      return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.foreground'));
    case 'starting':
      return new vscode.ThemeIcon('loading~spin');
    case 'delaying':
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.yellow'));
    case 'running':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'skipped':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.foreground'));
    default:
      return undefined;
  }
}

function depTooltip(
  kind: string,
  label: string,
  status: OrchestrationStatus | undefined,
  reason: string | undefined,
  delaySeconds: number,
): vscode.MarkdownString {
  const lines = [`**${kind}**: ${label}`];
  if (delaySeconds > 0) {
    lines.push(`\nDelay after start: ${delaySeconds}s`);
  }
  if (status) {
    lines.push(`\nStatus: _${status}_`);
  }
  if (reason) {
    lines.push(`\n${reason}`);
  }
  return new vscode.MarkdownString(lines.join('\n\n'));
}
