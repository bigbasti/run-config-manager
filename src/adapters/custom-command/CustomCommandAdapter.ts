import * as vscode from 'vscode';
import * as os from 'os';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { resolveProjectUri } from '../../utils/paths';
import { log } from '../../utils/logger';
import { dependsOnField } from '../sharedFields';

const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';

export class CustomCommandAdapter implements RuntimeAdapter {
  readonly type = 'custom-command' as const;
  readonly label = 'Custom Command';
  readonly supportsDebug = false;

  async detect(_folder: vscode.Uri): Promise<DetectionResult | null> {
    // Every folder is a valid place to run a custom command; we don't auto-
    // populate any fields (user pastes the command themselves). Auto-create
    // skips this type — it's user-authored by definition.
    log.debug(`Custom Command detect: matches any folder`);
    return {
      defaults: {
        type: 'custom-command',
        typeOptions: {
          command: '',
          cwd: '',
          shell: 'default',
          interactive: false,
          colorOutput: true,
        },
      },
      context: {},
    };
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Script',
          help: 'Display name shown in the sidebar.',
          examples: ['Seed DB', 'Rebuild assets', 'Deploy to staging'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to the project the command belongs to. Used as the default working directory if "Working directory" below is blank.',
          examples: ['', 'backend', 'tools/scripts'],
        },
      ],
      typeSpecific: [
        {
          kind: 'textarea',
          key: 'typeOptions.command',
          label: 'Command',
          required: true,
          rows: 3,
          placeholder: './scripts/seed.sh --profile dev',
          help:
            'The command to run. The whole string is passed through a shell, so operators like `&&`, `|`, `>`, globs (`*.txt`), and shell variables (`$FOO`) all work. ' +
            'Use `${workspaceFolder}` / `${env:FOO}` for cross-environment paths. ' +
            VAR_SYNTAX_HINT,
          examples: [
            './scripts/seed.sh --profile dev',
            'docker compose up -d && docker compose logs -f api',
            'node build/gen.js > dist/output.json',
            'pytest tests/ -k "not slow"',
          ],
          inspectable: true,
        },
        {
          kind: 'folderPath',
          key: 'typeOptions.cwd',
          label: 'Working directory (optional)',
          relativeTo: 'workspaceFolder',
          help: 'Where the command runs. Leave blank to use the project path above. ' + VAR_SYNTAX_HINT,
          examples: ['', 'scripts', '${workspaceFolder}/tools'],
        },
        {
          kind: 'select',
          key: 'typeOptions.shell',
          label: 'Shell',
          options: [
            { value: 'default', label: 'Default ($SHELL / COMSPEC)' },
            { value: 'bash', label: 'bash' },
            { value: 'sh', label: 'sh (POSIX)' },
            { value: 'zsh', label: 'zsh' },
            { value: 'pwsh', label: 'PowerShell Core (pwsh)' },
            { value: 'cmd', label: 'cmd.exe' },
          ],
          help:
            'Which shell interprets the command. "Default" picks $SHELL on Unix, COMSPEC on Windows. Pin to a specific shell when your script relies on shell-specific features. ' +
            'PowerShell scripts on mixed teams: pick `pwsh` to force PowerShell 7+ regardless of the user\'s default.',
        },
        {
          kind: 'boolean',
          key: 'typeOptions.interactive',
          label: 'Interactive (stdin, Ctrl+C)',
          help:
            'When enabled, VS Code owns the terminal and your script can read from stdin, receive Ctrl+C, display interactive prompts, and redraw (spinners, TUIs). ' +
            'Output prettification (colored log levels, clickable paths) is disabled in this mode. ' +
            'Leave off for scripts that just print output — they get the prettifier plus output-channel logging.',
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Force colored output',
          help: 'Sets FORCE_COLOR=1 / CLICOLOR_FORCE=1 so libraries that auto-detect TTY don\'t strip ANSI codes.',
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['NODE_ENV=production', 'DB_URL=${DB_URL}', 'DEBUG=app:*'],
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
      ],
    };
  }

  buildCommand(cfg: RunConfig, _folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'custom-command') {
      throw new Error('CustomCommandAdapter received non-custom-command config');
    }
    const to = cfg.typeOptions;
    const isWin = os.platform() === 'win32';

    // IMPORTANT: RunTerminal ALREADY wraps the command in the outer shell
    // (/bin/bash -c <cmdLine> on Unix, cmd /c <cmdLine> on Windows). Its
    // join-with-spaces strategy means any shell-operator in our args (|,
    // &&, >) would be re-interpreted by the OUTER shell, breaking the
    // intended pipeline (reported as "bash -c ls -la | grep java" was
    // being pipe-split by the outer bash into two independent commands).
    //
    // Two paths:
    //   - When the user's chosen shell matches the outer shell (default on
    //     Unix → bash; default / cmd on Windows → cmd), we pass the command
    //     verbatim with no wrapping. The outer shell handles the operators
    //     exactly as the user would expect from their terminal.
    //   - When the user picked a different shell (sh / zsh / pwsh, or
    //     pwsh on Unix, or bash / sh / zsh / pwsh on Windows), we DO wrap,
    //     but single-quote the command so the outer shell treats it as one
    //     argv element before handing it to the inner shell.

    const usesOuterShell =
      (isWin && (to.shell === 'default' || to.shell === 'cmd')) ||
      (!isWin && (to.shell === 'default' || to.shell === 'bash'));

    if (usesOuterShell) {
      // No inner wrap. cmdLine in RunTerminal becomes just the user's
      // command; the outer shell parses pipes/operators naturally. The
      // `command` slot holds the whole string — RunTerminal's join step is
      // a no-op since args is empty.
      return { command: to.command, args: [] };
    }

    // Inner wrap required. Single-quote for Unix targets (bash / sh / zsh /
    // pwsh on Unix — pwsh accepts single-quoted strings as the -Command
    // argument, and the outer bash strips them before handing to pwsh).
    // Double-quote-with-doubling for Windows cmd outer (pwsh on Windows).
    const quoted = isWin ? cmdQuote(to.command) : bashQuote(to.command);

    if (to.shell === 'pwsh') {
      return { command: 'pwsh', args: ['-Command', quoted] };
    }
    if (to.shell === 'cmd') {
      return { command: 'cmd.exe', args: ['/c', quoted] };
    }
    // sh / zsh on Unix.
    const unixShell = to.shell === 'sh' ? 'sh' : 'zsh';
    return { command: unixShell, args: ['-c', quoted] };
  }

  async prepareLaunch(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    _ctx: { debug: boolean; debugPort?: number },
  ): Promise<{ env?: Record<string, string>; cwd?: string }> {
    if (cfg.type !== 'custom-command') return {};
    const to = cfg.typeOptions;
    const env: Record<string, string> = {};
    if (to.colorOutput) {
      env.FORCE_COLOR = '1';
      env.CLICOLOR_FORCE = '1';
    }
    // cwd override. Relative paths resolve against the workspace folder;
    // absolute paths and variable-expanded values pass through.
    let cwd: string | undefined;
    if (to.cwd.trim()) {
      cwd = /^(?:[A-Za-z]:[\\/]|\/)/.test(to.cwd)
        ? to.cwd
        : resolveProjectUri(folder, to.cwd).fsPath;
    }
    return { env, cwd };
  }
}

// Single-quote a string so an outer POSIX shell treats it as one literal
// token. Inner single quotes are escaped with the `'\''` trick.
function bashQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Windows cmd.exe treats " as the quote character; embedded " need to be
// doubled. This is less robust than POSIX (cmd lacks real quote levels),
// but covers typical command lines.
function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
