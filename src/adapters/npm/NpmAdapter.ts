import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readPackageJsonInfo } from './detectPackageJson';
import { splitArgs } from './splitArgs';

export class NpmAdapter implements RuntimeAdapter {
  readonly type = 'npm' as const;
  readonly label = 'npm / Node.js';
  readonly supportsDebug = true;

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
    const scriptField: FormField = scripts.length
      ? {
          kind: 'select',
          key: 'typeOptions.scriptName',
          label: 'Script',
          options: scripts.map(s => ({ value: s, label: s })),
          help: 'Which package.json script to invoke. The dropdown lists every script we detected in your package.json.',
          examples: ['start', 'dev', 'build'],
        }
      : {
          kind: 'text',
          key: 'typeOptions.scriptName',
          label: 'Script',
          required: true,
          placeholder: 'start',
          help: 'Name of the script to run. We did not detect any scripts in package.json — type the name you want to invoke (it will run as "<pm> run <name>").',
          examples: ['start', 'dev', 'serve'],
        };

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My App',
          help: 'Display name shown in the sidebar. Purely cosmetic — pick whatever you like.',
          examples: ['Angular Dev', 'API server', 'Storybook'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to your project, relative to the workspace folder. Leave blank if package.json lives at the workspace root.',
          examples: ['', 'web', 'packages/api'],
        },
      ],
      typeSpecific: [
        scriptField,
        {
          kind: 'select',
          key: 'typeOptions.packageManager',
          label: 'Package manager',
          options: [
            { value: 'npm', label: 'npm' },
            { value: 'yarn', label: 'yarn' },
            { value: 'pnpm', label: 'pnpm' },
          ],
          help: 'Which package manager to invoke. We auto-detect from the lockfile (yarn.lock → yarn, pnpm-lock.yaml → pnpm, otherwise npm) — override only if needed.',
          examples: ['npm', 'pnpm'],
        },
        {
          kind: 'number',
          key: 'port',
          label: 'Port (optional)',
          min: 1,
          max: 65535,
          help: 'Informational only in v1 — lets you remember which port the app uses. The script itself is responsible for actually binding to this port.',
          examples: ['4200', '3000', '8080'],
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help:
            'Extra environment variables merged on top of VS Code\'s inherited env. ' +
            'Values are strings. Do not quote values here — the shell sees them literally. ' +
            'Supports ${VAR} / ${env:VAR} / ${workspaceFolder} / ${cwd} / ${userHome}. ' +
            'Unresolved variables expand to empty strings at launch.',
          examples: ['NODE_ENV=development', 'DEBUG=app:*', 'DATA_DIR=${workspaceFolder}/data'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--port 5000',
          help:
            'Arguments passed to the script after "--". Quote values with spaces using double quotes. ' +
            'Supports ${VAR} / ${env:VAR} / ${workspaceFolder} / ${cwd} / ${userHome}. ' +
            'Unresolved variables expand to empty strings at launch.',
          examples: ['--port 5000', '--open --host 0.0.0.0', '--config=${workspaceFolder}/cfg'],
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args (unused for npm)',
          help: 'Reserved for future runtime types (e.g., Java -Xmx flags). Ignored for npm configurations.',
        },
      ],
    };
  }

  buildCommand(cfg: RunConfig): { command: string; args: string[] } {
    if (cfg.type !== 'npm') throw new Error('NpmAdapter received non-npm config');
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
    if (cfg.type !== 'npm') throw new Error('NpmAdapter received non-npm config');
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
