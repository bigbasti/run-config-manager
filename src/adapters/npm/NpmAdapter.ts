import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch, PrepareContext } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readPackageJsonInfo } from './detectPackageJson';
import { detectNpmFramework, type NpmFrameworkInfo } from './detectNpmFramework';
import { splitArgs } from './splitArgs';
import { log } from '../../utils/logger';
import { dependsOnField, envFilesField, closeTerminalOnExitField } from '../sharedFields';
import { detectNpmPort } from '../../services/detectProjectPort';
import { probeNodesStreaming, readNodes, nodeOption } from './probeNodesStreaming';
import { buildNodeMonitorEnv } from '../../utils/nodeMonitorEnv';
import * as path from 'path';

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
          nodePath: '',
        },
        ...(port ? { port } : {}),
      },
      context: { scripts: info.scripts },
    };
  }

  async detectStreaming(folder: vscode.Uri, emit: (p: StreamingPatch) => void): Promise<void> {
    // Phase 1: synchronous-feeling — read package.json scripts immediately
    // so the Script dropdown is populated on first paint. Without this,
    // the create flow opens an empty Script select because the streaming
    // path bypasses adapter.detect() (which is what populates scripts on
    // the legacy non-streaming path). Detected scripts AND the chosen
    // package manager flow into the form via contextPatch + defaultsPatch.
    try {
      const info = await readPackageJsonInfo(folder);
      if (info) {
        const fw = await detectNpmFramework(
          folder,
          info.scripts,
          info.pkgScripts,
          info.dependencies,
        );
        const port = await safeNpmPort(folder, info.defaultScript);
        const effectivePort = port ?? fw.defaultPort ?? undefined;
        emit({
          contextPatch: {
            scripts: info.scripts,
            npmFramework: fw,
          },
          defaultsPatch: {
            typeOptions: {
              scriptName: info.defaultScript,
              packageManager: info.packageManager,
            },
            ...(effectivePort !== undefined ? { port: effectivePort } : {}),
          } as any,
        });
      }
    } catch (e) {
      log.debug(`npm detectStreaming: package.json probe failed: ${(e as Error).message}`);
    }

    // Phase 2: Node interpreter probe (paths first, versions enriched).
    await probeNodesStreaming(emit, 'npm');
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const scripts = (context.scripts as string[] | undefined) ?? [];
    const fw = context.npmFramework as NpmFrameworkInfo | undefined;
    const frameworkBadge: FormField | null = fw && fw.name ? {
      kind: 'info',
      key: 'npmFrameworkBadge',
      label: 'Detected framework',
      content: {
        banner: {
          kind: 'muted',
          text: `Detected: ${frameworkDisplayName(fw.name)} (${fw.source})`,
        },
      },
    } : null;
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
        ...(frameworkBadge ? [frameworkBadge] : []),
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.nodePath',
          label: 'Node',
          options: readNodes(context.nodes).map(nodeOption),
          placeholder: '/path/to/node-home',
          help:
            '`node` runtime to use for this configuration.\n\n' +
            'Auto-detected from `$NODE_HOME` / `$NVM_DIR`, `node` on `PATH`, the extension\'s own ' +
            'install root, version managers (`nvm`, `volta`, `asdf`, `fnm`, `n`), and standard ' +
            'install locations. The selected Node\'s `bin` directory is prepended to `PATH` at ' +
            'launch, so `npm` / `yarn` / `pnpm` and any binary they spawn (Node itself ' +
            'included) come from this install.\n\n' +
            'Leave blank to use whatever `node` is on `PATH` when VS Code started.\n\n' +
            '`nvm` users: when `nvm` is detected on your system, the cloud-icon installer routes ' +
            'through `nvm install` instead of downloading a standalone tarball, so the install ' +
            'lands in your existing nvm pool (`~/.nvm/versions/node/`).\n\n' +
            'Click ☁ to download a fresh Node from `nodejs.org`.',
          examples: ['/usr/local/lib/node_modules/node-v20', '~/.nvm/versions/node/v20.10.0'],
          action: { id: 'openNodeDownload', label: '☁', title: 'Download and install a Node from nodejs.org', inline: true },
        },
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
        envFilesField(),
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help:
            'Extra environment variables merged on top of VS Code\'s inherited env. Values are strings — do not quote them here, the shell sees them literally.\n\n' +
            'Supports `${VAR}` / `${env:VAR}` / `${workspaceFolder}` / `${cwd}` / `${userHome}`. Unresolved variables expand to empty strings at launch.',
          examples: ['NODE_ENV=development', 'DEBUG=app:*', 'DATA_DIR=${workspaceFolder}/data'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--port 5000',
          help:
            'Arguments passed to the script after `--`. Quote values with spaces using double quotes.\n\n' +
            'Supports `${VAR}` / `${env:VAR}` / `${workspaceFolder}` / `${cwd}` / `${userHome}`. Unresolved variables expand to empty strings at launch.',
          examples: ['--port 5000', '--open --host 0.0.0.0', '--config=${workspaceFolder}/cfg'],
          inspectable: true,
        },
        // vmArgs used to be rendered here with a "(unused for npm)" label —
        // removed because an input that can never take effect just wastes
        // screen space. The underlying field still exists on RunConfigBase
        // for schema compatibility with Java/Spring Boot configs; npm
        // configs simply leave it blank.
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
        closeTerminalOnExitField(),
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
  async prepareLaunch(
    cfg: RunConfig,
    _folder?: vscode.WorkspaceFolder,
    ctx?: PrepareContext,
  ): Promise<{ env?: Record<string, string> }> {
    const env: Record<string, string> = {
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      COLORTERM: 'truecolor',
      npm_config_color: 'always',
    };
    if (cfg.type === 'npm' && cfg.typeOptions.nodePath) {
      // Windows Node ships node.exe at the install root, not in bin/.
      const binDir = process.platform === 'win32'
        ? cfg.typeOptions.nodePath
        : path.join(cfg.typeOptions.nodePath, 'bin');
      const sep = process.platform === 'win32' ? ';' : ':';
      env.PATH = `${binDir}${sep}${process.env.PATH ?? ''}`;
    }
    // Node monitoring: inject the in-process agent. ExecutionService passes the
    // IPC server port (ctx.monitorPort) and the bundled agent path.
    if (ctx?.monitor && ctx.nodeAgentPath && ctx.monitorPort) {
      Object.assign(env, buildNodeMonitorEnv(ctx.nodeAgentPath, ctx.monitorPort, cfg.id));
    }
    return { env };
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

// Wrapper around detectNpmPort that swallows errors and returns
// `undefined` so the streaming detect path stays best-effort. Mirrors
// the try/catch the legacy `detect()` path uses.
async function safeNpmPort(folder: vscode.Uri, defaultScript: string): Promise<number | undefined> {
  try {
    const detected = await detectNpmPort(folder, defaultScript);
    return detected ?? undefined;
  } catch (e) {
    log.debug(`safeNpmPort: ${(e as Error).message}`);
    return undefined;
  }
}

// Maps the internal framework key to the user-facing display name. Kept
// next to NpmAdapter so any future entries land in one place.
function frameworkDisplayName(name: NpmFrameworkInfo['name']): string {
  switch (name) {
    case 'angular':   return 'Angular';
    case 'nextjs':    return 'Next.js';
    case 'nuxt':      return 'Nuxt';
    case 'vite':      return 'Vite';
    case 'sveltekit': return 'SvelteKit';
    case 'svelte':    return 'Svelte';
    case 'vue':       return 'Vue (CLI)';
    case 'react':     return 'Create React App';
    case 'astro':     return 'Astro';
    case 'remix':     return 'Remix';
    case 'gatsby':    return 'Gatsby';
    case 'storybook': return 'Storybook';
    case null:        return '';
  }
}
