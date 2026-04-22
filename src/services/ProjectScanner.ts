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
      // Let each adapter describe its own detection context — avoids assuming
      // the context has a scripts array (that's npm-specific).
      const summary = summarizeContext(result.context);
      log.info(`  → detected: ${summary}`);
    }
    return result;
  }
}

function summarizeContext(ctx: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (Array.isArray(v)) {
      parts.push(`${k}=[${v.join(', ')}]`);
    } else if (v && typeof v === 'object') {
      parts.push(`${k}={…}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.length ? parts.join(', ') : '(no extra context)';
}
