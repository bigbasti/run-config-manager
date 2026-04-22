import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { readPackageJsonInfo } from './detectPackageJson';
import { splitArgs } from './splitArgs';

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

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const scripts = (context.scripts as string[] | undefined) ?? [];
    const scriptOptions = scripts.length
      ? scripts.map(s => ({ value: s, label: s }))
      : [{ value: '', label: '(no scripts detected — type one)' }];

    return {
      common: [
        { kind: 'text', key: 'name', label: 'Name', required: true, placeholder: 'My App' },
        { kind: 'folderPath', key: 'projectPath', label: 'Project path', relativeTo: 'workspaceFolder' },
      ],
      typeSpecific: [
        { kind: 'select', key: 'typeOptions.scriptName', label: 'Script', options: scriptOptions },
        {
          kind: 'select',
          key: 'typeOptions.packageManager',
          label: 'Package manager',
          options: [
            { value: 'npm', label: 'npm' },
            { value: 'yarn', label: 'yarn' },
            { value: 'pnpm', label: 'pnpm' },
          ],
        },
        { kind: 'number', key: 'port', label: 'Port (optional)', min: 1, max: 65535 },
      ],
      advanced: [
        { kind: 'kv', key: 'env', label: 'Environment variables' },
        { kind: 'text', key: 'programArgs', label: 'Program args', placeholder: '--port 5000' },
        { kind: 'text', key: 'vmArgs', label: 'VM args (unused for npm)' },
      ],
    };
  }

  buildCommand(cfg: RunConfig): { command: string; args: string[] } {
    const pm = cfg.typeOptions.packageManager;
    const script = cfg.typeOptions.scriptName;
    const args = ['run', script];
    const extra = splitArgs(cfg.programArgs ?? '');
    if (extra.length > 0) {
      args.push('--', ...extra);
    }
    return { command: pm, args };
  }

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    const pm = cfg.typeOptions.packageManager;
    const cwd = cfg.projectPath
      ? `${folder.uri.fsPath}/${cfg.projectPath}`
      : folder.uri.fsPath;
    return {
      type: 'pwa-node',
      request: 'launch',
      name: cfg.name,
      runtimeExecutable: pm,
      runtimeArgs: ['run', cfg.typeOptions.scriptName],
      cwd,
      env: cfg.env ?? {},
      console: 'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
    };
  }
}
