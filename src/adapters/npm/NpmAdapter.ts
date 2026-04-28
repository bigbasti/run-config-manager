import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readPackageJsonInfo } from './detectPackageJson';
import { splitArgs } from './splitArgs';
import { log } from '../../utils/logger';
import { dependsOnField } from '../sharedFields';
import { detectNpmPort } from '../../services/detectProjectPort';

export class NpmAdapter implements RuntimeAdapter {
  readonly type = 'npm' as const;
  readonly label = 'npm / Node.js';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`npm detect: ${folder.fsPath}`);
    const info = await readPackageJsonInfo(folder);
    if (!info) {
      log.debug(`npm detect: no package.json`);
      return null;
    }
    log.info(
      `npm detect: packageManager=${info.packageManager}, scripts=${info.scripts.length}, ` +
      `defaultScript=${info.defaultScript}`,
    );
    // Port detection: framework convention default or --port in the picked
    // script. Null when we can't determine (plain Node scripts).
    let port: number | undefined;
    try {
      const detected = await detectNpmPort(folder, info.defaultScript);
      if (detected) port = detected;
    } catch (e) {
      log.debug(`npm port detect failed: ${(e as Error).message}`);
    }
    return {
      defaults: {
        type: 'npm',
        typeOptions: {
          scriptName: info.defaultScript,
          packageManager: info.packageManager,
        },
        ...(port ? { port } : {}),
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
          required: true,
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
          inspectable: true,
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args (unused for npm)',
          help: 'Reserved for future runtime types (e.g., Java -Xmx flags). Ignored for npm configurations.',
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
      ],
    };
  }

  // Child tools (Angular CLI, webpack, Vite, Node libraries) auto-detect
  // whether stdout is a TTY and strip ANSI when it isn't. Because the
  // prettifier's pseudoterminal pipes the child's stdout through Node's
  // `cp.spawn`, isatty() returns false and color gets dropped by default.
  // Setting FORCE_COLOR=1 (Node standard) + CLICOLOR_FORCE=1 (Unix standard)
  // + COLORTERM=truecolor flips those auto-detect checks back on for the
  // overwhelming majority of CLIs.
  async prepareLaunch(): Promise<{ env?: Record<string, string> }> {
    return {
      env: {
        FORCE_COLOR: '1',
        CLICOLOR_FORCE: '1',
        COLORTERM: 'truecolor',
        npm_config_color: 'always',
      },
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
