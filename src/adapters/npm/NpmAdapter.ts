import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { readPackageJsonInfo } from './detectPackageJson';

export class NpmAdapter implements RuntimeAdapter {
  readonly type = 'npm' as const;
  readonly label = 'npm / Node.js';

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    const info = await readPackageJsonInfo(folder);
    if (!info) return null;
    return {
      defaults: {
        type: 'npm',
        typeOptions: {
          scriptName: info.defaultScript,
          packageManager: info.packageManager,
        },
      },
      context: { scripts: info.scripts },
    };
  }

  // Stubs — implemented in Task 6.
  getFormSchema(_context: Record<string, unknown>): FormSchema {
    throw new Error('not yet implemented');
  }

  buildCommand(_cfg: RunConfig): { command: string; args: string[] } {
    throw new Error('not yet implemented');
  }

  getDebugConfig(_cfg: RunConfig, _folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    throw new Error('not yet implemented');
  }
}
