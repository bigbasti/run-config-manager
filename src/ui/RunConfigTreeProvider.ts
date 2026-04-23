import * as vscode from 'vscode';
import type { RunConfigService } from '../services/RunConfigService';
import type { ConfigStore } from '../services/ConfigStore';
import type { ExecutionService } from '../services/ExecutionService';
import type { DebugService } from '../services/DebugService';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import { buildCommandPreview } from '../shared/buildCommandPreview';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';
import { iconForConfig, brandIconUri } from './iconForConfig';

export type Node =
  | { kind: 'folder'; folderKey: string; label: string }
  | { kind: 'typeGroup'; folderKey: string; type: RunConfig['type']; label: string; count: number }
  | { kind: 'config'; folderKey: string; config: RunConfig }
  | { kind: 'invalid'; folderKey: string; entry: InvalidConfigEntry };

export class RunConfigTreeProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: ConfigStore,
    private readonly svc: RunConfigService,
    private readonly exec: ExecutionService,
    private readonly dbg: DebugService,
    private readonly registry: AdapterRegistry,
    // Needed so we can build absolute URIs to the bundled brand SVGs under
    // media/icons/. Passed in from extension.ts activate().
    private readonly extensionUri: vscode.Uri,
  ) {
    store.onChange(() => this.refresh());
    exec.onRunningChanged(() => this.refresh());
    dbg.onRunningChanged(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
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

    const preparing = this.exec.isPreparing(n.config.id);
    const running = this.exec.isRunning(n.config.id) || this.dbg.isRunning(n.config.id);
    const started = this.exec.isStarted(n.config.id);
    const failed = this.exec.isFailed(n.config.id);
    const rebuilding = this.exec.isRebuilding(n.config.id);
    const adapter = this.registry.get(n.config.type);
    const debuggable = adapter?.supportsDebug === true;
    const item = new vscode.TreeItem(n.config.name, vscode.TreeItemCollapsibleState.None);
    item.tooltip = new vscode.MarkdownString(
      `**${n.config.name}** _(${n.config.type})_\n\n` +
      (n.config.projectPath ? `Path: \`${n.config.projectPath}\`\n\n` : '') +
      `Command: \`${buildCommandPreview(n.config)}\`` +
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
    } else {
      // Idle — show the brand icon so the user can visually scan npm /
      // Angular / Spring Boot / Gradle / etc. at a glance. Brand icon
      // resolution sniffs config-file tell-tales + package.json scripts
      // for npm configs to pick the specific framework (Angular, Vite,
      // Next, Svelte, Vue, React, Node).
      const folder = this.store.getFolder(n.folderKey);
      item.iconPath = iconForConfig(n.config, folder, this.extensionUri);
      item.description = undefined;
    }
    item.contextValue = (preparing || running)
      ? debuggable ? 'configRunning' : 'configRunningNoDebug'
      : debuggable ? 'configIdle' : 'configIdleNoDebug';
    // Click behavior: running/preparing configs reveal the task terminal;
    // idle configs open the editor. The inline Edit button always opens the
    // editor regardless of state.
    item.command = (running || preparing)
      ? { command: 'runConfig.reveal', title: 'Reveal terminal', arguments: [n] }
      : { command: 'runConfig.edit', title: 'Edit', arguments: [n] };
    return item;
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
    return [];
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
    default: return 'npm';
  }
}
