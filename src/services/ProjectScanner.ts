import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { DetectionResult } from '../adapters/RuntimeAdapter';
import type { RunConfigType } from '../shared/types';

export class ProjectScanner {
  constructor(private readonly registry: AdapterRegistry) {}

  async scan(folder: vscode.Uri, type: RunConfigType): Promise<DetectionResult | null> {
    const adapter = this.registry.get(type);
    if (!adapter) throw new Error(`No adapter registered for type: ${type}`);
    return adapter.detect(folder);
  }
}
