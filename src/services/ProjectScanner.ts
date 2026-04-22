import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { DetectionResult } from '../adapters/RuntimeAdapter';
import type { RunConfigType } from '../shared/types';
import { log } from '../utils/logger';

export class ProjectScanner {
  constructor(private readonly registry: AdapterRegistry) {}

  async scan(folder: vscode.Uri, type: RunConfigType): Promise<DetectionResult | null> {
    const adapter = this.registry.get(type);
    if (!adapter) throw new Error(`No adapter registered for type: ${type}`);
    log.info(`Scanning ${folder.fsPath} with ${type} adapter…`);
    const result = await adapter.detect(folder);
    if (!result) {
      log.info(`  → no ${type} project detected at ${folder.fsPath}`);
    } else {
      const scripts = (result.context.scripts as string[] | undefined) ?? [];
      log.info(`  → detected ${scripts.length} script(s): ${scripts.join(', ')}`);
    }
    return result;
  }
}
