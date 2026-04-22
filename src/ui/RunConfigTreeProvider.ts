import * as vscode from 'vscode';
import type { RunConfigService } from '../services/RunConfigService';
import type { ConfigStore } from '../services/ConfigStore';
import type { ExecutionService } from '../services/ExecutionService';
import type { DebugService } from '../services/DebugService';
import { buildCommandPreview } from '../shared/buildCommandPreview';
import type { RunConfig } from '../shared/types';

type Node =
  | { kind: 'folder'; folderKey: string; label: string }
  | { kind: 'config'; folderKey: string; config: RunConfig };

export class RunConfigTreeProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: ConfigStore,
    private readonly svc: RunConfigService,
    private readonly exec: ExecutionService,
    private readonly dbg: DebugService,
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
    const running = this.exec.isRunning(n.config.id) || this.dbg.isRunning(n.config.id);
    const prefix = running ? '$(sync~spin) ' : '';
    const item = new vscode.TreeItem(prefix + n.config.name, vscode.TreeItemCollapsibleState.None);
    item.description = buildCommandPreview(n.config);
    item.tooltip = `${n.config.type} · ${n.config.projectPath || '.'}`;
    item.iconPath = new vscode.ThemeIcon(iconForType(n.config.type));
    item.contextValue = running ? 'configRunning' : 'configIdle';
    item.command = {
      command: 'runConfig.edit',
      title: 'Edit',
      arguments: [n],
    };
    return item;
  }

  getChildren(parent?: Node): Node[] {
    if (!parent) {
      const keys = this.store.folderKeys();
      if (keys.length <= 1) {
        return keys.flatMap(key => this.configNodes(key));
      }
      return keys.map(key => {
        const label = this.store.getFolder(key)?.name ?? key;
        return { kind: 'folder', folderKey: key, label };
      });
    }
    if (parent.kind === 'folder') return this.configNodes(parent.folderKey);
    return [];
  }

  private configNodes(folderKey: string): Node[] {
    const file = this.store.getForFolder(folderKey);
    return file.configurations.map(config => ({ kind: 'config', folderKey, config } as const));
  }
}

function iconForType(type: string): string {
  switch (type) {
    case 'npm': return 'nodejs';
    default: return 'circle-outline';
  }
}
