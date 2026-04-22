import * as vscode from 'vscode';
import type { RunConfigService } from '../services/RunConfigService';
import type { ConfigStore } from '../services/ConfigStore';
import type { ExecutionService } from '../services/ExecutionService';
import type { DebugService } from '../services/DebugService';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import { buildCommandPreview } from '../shared/buildCommandPreview';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';

export type Node =
  | { kind: 'folder'; folderKey: string; label: string }
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

    const running = this.exec.isRunning(n.config.id) || this.dbg.isRunning(n.config.id);
    const adapter = this.registry.get(n.config.type);
    const debuggable = adapter?.supportsDebug === true;
    const item = new vscode.TreeItem(n.config.name, vscode.TreeItemCollapsibleState.None);
    item.description = buildCommandPreview(n.config);
    item.tooltip = `${n.config.type} · ${n.config.projectPath || '.'}`;
    // `loading~spin` is a built-in animated codicon; when not running, show the
    // type-specific icon.
    item.iconPath = running
      ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon(iconForType(n.config.type));
    // Context value encodes both run state AND debug capability so the
    // `when` clauses in package.json can hide the Debug button when the
    // adapter doesn't support it.
    item.contextValue = running
      ? debuggable ? 'configRunning' : 'configRunningNoDebug'
      : debuggable ? 'configIdle' : 'configIdleNoDebug';
    item.command = { command: 'runConfig.edit', title: 'Edit', arguments: [n] };
    return item;
  }

  getChildren(parent?: Node): Node[] {
    if (!parent) {
      const keys = this.store.folderKeys();
      if (keys.length <= 1) {
        return keys.flatMap(key => this.allNodes(key));
      }
      return keys.map(key => {
        const label = this.store.getFolder(key)?.name ?? key;
        return { kind: 'folder', folderKey: key, label } as const;
      });
    }
    if (parent.kind === 'folder') return this.allNodes(parent.folderKey);
    return [];
  }

  private allNodes(folderKey: string): Node[] {
    const file = this.store.getForFolder(folderKey);
    const invalid = this.store.invalidForFolder(folderKey);
    const valid: Node[] = file.configurations.map(config => ({ kind: 'config', folderKey, config } as const));
    const bad: Node[] = invalid.map(entry => ({ kind: 'invalid', folderKey, entry } as const));
    return [...valid, ...bad];
  }
}

function iconForType(type: string): string {
  // Codicon names only — see https://code.visualstudio.com/api/references/icons-in-labels
  switch (type) {
    case 'npm': return 'package';
    case 'spring-boot': return 'rocket';
    default: return 'circle-outline';
  }
}
