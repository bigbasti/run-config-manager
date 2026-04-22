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
      item.iconPath = new vscode.ThemeIcon(iconForType(n.type));
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
    // Row description is kept empty so the grid stays uncluttered; the full
    // command preview lives in the tooltip (hover).
    item.tooltip = new vscode.MarkdownString(
      `**${n.config.name}** _(${n.config.type})_\n\n` +
      (n.config.projectPath ? `Path: \`${n.config.projectPath}\`\n\n` : '') +
      `Command: \`${buildCommandPreview(n.config)}\``,
    );
    item.iconPath = running
      ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon(iconForType(n.config.type));
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
    default: return type;
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
