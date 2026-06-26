import * as vscode from 'vscode';
import * as path from 'path';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { splitArgs } from '../npm/splitArgs';
import { probeGosStreaming, readGos, goOption } from './probeGosStreaming';
import { findGoMains } from './findGoMains';
import { dependsOnField, envFilesField, closeTerminalOnExitField } from '../sharedFields';
import { log } from '../../utils/logger';
import { resolveProjectUri } from '../../utils/paths';

const VAR_SYNTAX_HINT =
  'Supports `${VAR}` and `${env:VAR}` (environment variables), `${workspaceFolder}`, `${userHome}`, and `${cwd}` / `${projectPath}`. Unresolved variables expand to an empty string at launch.';

export class GoAdapter implements RuntimeAdapter {
  readonly type = 'go' as const;
  readonly label = 'Go';
  // Debug uses the official Go VS Code extension (golang.go) which provides
  // the Delve DAP adapter. supportsDebug = true so the Debug button appears.
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Go detect: ${folder.fsPath}`);
    // Only activate for projects that have a go.mod (the Go module root).
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, 'go.mod'));
    } catch {
      log.debug(`Go detect: no go.mod`);
      return null;
    }
    log.debug(`Go detect: go.mod found`);
    return {
      defaults: {
        type: 'go',
        typeOptions: {
          launchMode: 'run',
          goPath: '',
          packagePath: '',
          testArgs: './...',
          outputPath: '',
          customArgs: '',
          buildRoot: '',
          race: false,
          colorOutput: true,
        },
      },
      context: {
        gos: [],
        mainPackages: [],
        moduleName: '',
      },
    };
  }

  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    log.debug(`Go detectStreaming: ${folder.fsPath}`);

    // Phase 0: check whether the Go VS Code extension (golang.go) is installed.
    // This runs synchronously in the extension host — no async needed.
    // The result is threaded into the context so getFormSchema can decide
    // whether to show the "debug requires golang.go" info banner.
    const goExtMissing = !vscode.extensions.getExtension('golang.go');
    emit({ contextPatch: { goExtensionMissing: goExtMissing }, resolved: [] });

    // Phase 1a: read go.mod for the module name (fast).
    // buildRoot for a Go project is just the folder containing go.mod —
    // typically the same as projectPath, so we leave it blank (empty = use
    // projectPath). Emit resolved immediately so the spinner on the
    // "Module root" field (which is in the shared STREAMING_PENDING_FIELDS
    // list for JVM types) clears right away instead of spinning forever.
    emit({ contextPatch: {}, resolved: ['typeOptions.buildRoot'] });

    try {
      const modBuf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'go.mod'));
      const modText = new TextDecoder().decode(modBuf);
      const m = modText.match(/^module\s+(\S+)/m);
      if (m) {
        log.debug(`Go probe: module=${m[1]}`);
        emit({ contextPatch: { moduleName: m[1] }, resolved: [] });
      }
    } catch { /* no go.mod – detect() returned null, shouldn't reach here */ }

    // Phase 1b: scan for main packages in parallel with Go install probe.
    (async () => {
      const mains = await findGoMains(folder);
      log.debug(`Go probe: mainPackages=${mains.length}`);
      const mainOptions = mains.map(p => ({ value: p, label: p }));
      emit({
        contextPatch: { mainPackages: mains },
        defaultsPatch: mains.length === 1
          ? { typeOptions: { packagePath: mains[0] } } as any
          : undefined,
        resolved: ['typeOptions.packagePath'],
      });
      // Also surface the options list so the form can build the dropdown.
      emit({ contextPatch: { mainPackageOptions: mainOptions }, resolved: [] });
    })().catch(e => log.warn(`Go probe (mains) failed: ${(e as Error).message}`));

    // Phase 2: detect Go installations + their versions.
    probeGosStreaming(emit).catch(e =>
      log.warn(`Go probe (installs) failed: ${(e as Error).message}`),
    );
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const gos = readGos(context.gos);
    const goOptions = gos.map(goOption);
    const mainPackageOptions = (context.mainPackageOptions as Array<{ value: string; label: string }> | undefined) ?? [];
    const hasMain = mainPackageOptions.length > 0;
    // Only show the debug prerequisites banner when the Go extension is
    // actually missing. When installed, the banner would just add noise.
    const goExtensionMissing = context.goExtensionMissing === true;

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Go App',
          help: 'Display name shown in the sidebar tree. Purely cosmetic.',
          examples: ['API Server', 'Background Worker', 'CLI Tool'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to the Go project root (where go.mod or the main package lives), relative to the workspace folder.',
          examples: ['', 'backend', 'services/api'],
        },
        {
          kind: 'select',
          key: 'typeOptions.launchMode',
          label: 'Launch mode',
          options: [
            { value: 'run',     label: 'Run a package  (go run)' },
            { value: 'test',    label: 'Run tests  (go test)' },
            { value: 'build',   label: 'Build binary  (go build)' },
            { value: 'install', label: 'Install binary  (go install)' },
            { value: 'custom',  label: 'Custom command  (go <args>)' },
          ],
          help: 'How to invoke the `go` tool.\n\n- **run** — compile and run a package in one step (no output binary produced).\n- **test** — run the test suite.\n- **build** — produce a binary; use the Output binary field to control where it lands.\n- **install** — build and install the binary into `$GOPATH/bin`.\n- **custom** — append free-form arguments directly to `go` for advanced use cases (e.g. `go generate ./...`).',
        },
      ],
      typeSpecific: [
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.goPath',
          label: 'Go runtime',
          options: goOptions,
          placeholder: '/usr/local/go',
          help: 'Go installation to use. Auto-detected from `$GOROOT`, `go` on PATH, version managers (gvm, asdf, mise, goenv), and standard install locations.\n\nLeave blank to use `go` on PATH. When set, `$GOROOT` and the install\'s `bin/` directory are prepended to `PATH` at launch.\n\n**Tip:** Download Go from [go.dev/dl](https://go.dev/dl/).',
          examples: ['/usr/local/go', '/opt/homebrew/opt/go/libexec'],
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.packagePath',
          label: 'Package',
          options: hasMain ? mainPackageOptions : [],
          placeholder: './cmd/server',
          help: 'Package path passed to `go run`, `go build`, or `go install`. Examples: `.` (module root), `./cmd/server` (a specific command), `./...` (all packages — mainly for build/install). Leave blank for `.`.',
          examples: ['.', './cmd/server', './cmd/...'],
          dependsOn: { key: 'typeOptions.launchMode', oneOf: ['run', 'build', 'install'] } as any,
        },
        {
          kind: 'text',
          key: 'typeOptions.testArgs',
          label: 'Test args',
          placeholder: './... -run TestFoo -v -count=1',
          help: 'Arguments appended to `go test`. Include package paths and `-run` regex filters here. Examples:\n- `./...` — run all tests\n- `./internal/... -run TestAuth -v` — verbose, filtered to TestAuth\n- `-bench=.` — run benchmarks',
          examples: ['./...', './... -run TestFoo -v', '-bench=. -benchmem'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'test' },
          inspectable: true,
        },
        {
          kind: 'text',
          key: 'typeOptions.outputPath',
          label: 'Output binary',
          placeholder: './bin/server',
          help: 'Path for the `-o` flag when building. Empty = the default output name from `go build` (typically the module/package name in the current directory).',
          examples: ['./bin/server', './build/app', '/usr/local/bin/mytool'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'build' },
        },
        {
          kind: 'text',
          key: 'typeOptions.customArgs',
          label: 'Custom args',
          placeholder: 'generate ./...',
          help: 'Arguments appended verbatim to `go`. The full command becomes: `go <customArgs>`.\n\nExamples: `generate ./...`, `vet ./...`, `env GOARCH=arm64 build .`',
          examples: ['generate ./...', 'vet ./...', 'env GOARCH=arm64 build .'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'custom' },
          inspectable: true,
        },
        {
          kind: 'boolean',
          key: 'typeOptions.race',
          label: 'Enable race detector (-race)',
          inlineLabel: true,
          help: 'Passes `-race` to `go run`, `go test`, or `go build`. The race detector instruments memory accesses and reports data races at runtime. Incurs a modest CPU overhead (~2×) and small memory overhead. **Not supported for `go install` or `custom` mode.**',
          dependsOn: { key: 'typeOptions.launchMode', oneOf: ['run', 'test', 'build'] } as any,
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          inlineLabel: true,
          help: 'Sets `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`, and `TERM=xterm-256color` so libraries that auto-detect TTY don\'t strip ANSI color codes.',
        },
        {
          kind: 'number',
          key: 'port',
          label: 'Port (optional)',
          min: 1,
          max: 65535,
          help: 'Informational — the app is responsible for binding the port. Used for dependency resolution and can appear in tooltips.',
          examples: ['8080', '3000', '9090'],
          dependsOn: { key: 'typeOptions.launchMode', oneOf: ['run', 'custom'] } as any,
        },
        // Show the debug prerequisites banner only when the golang.go extension
        // is not installed. When it's already present, the banner is noise.
        ...(goExtensionMissing ? [{
          kind: 'info' as const,
          key: '__debug_info',
          label: 'Debug prerequisites',
          content: {
            banner: {
              kind: 'warning' as const,
              text: 'Debug requires the Go extension (golang.go). Install it from the Extensions panel to enable step-through debugging via Delve.',
            },
          },
        }] : []),
      ],
      advanced: [
        envFilesField(),
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of the inherited environment. Later entries override earlier ones. ' + VAR_SYNTAX_HINT,
          examples: ['GOENV=production', 'PORT=8080', 'DATABASE_URL=${env:DATABASE_URL}'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--port 8080 --config config.yaml',
          help: 'Arguments passed to the **program** (not to `go`). For `go run`, these appear after the package path. ' + VAR_SYNTAX_HINT,
          examples: ['--port 8080', '--config ${workspaceFolder}/config.yaml'],
          inspectable: true,
          dependsOn: { key: 'typeOptions.launchMode', oneOf: ['run', 'custom'] } as any,
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'Go tool flags',
          placeholder: '-ldflags "-X main.version=1.0" -tags prod',
          help: 'Extra flags inserted between the `go` subcommand and the package path. Used for build-time customisation:\n- `-ldflags "..."` — linker flags (embed version, strip debug info)\n- `-tags <tag>` — build constraint tags\n- `-trimpath` — remove local path info from binaries\n\n' + VAR_SYNTAX_HINT,
          examples: ['-ldflags "-X main.version=1.0.0 -s -w"', '-tags integration', '-trimpath -ldflags "-s -w"'],
          inspectable: true,
        },
        {
          kind: 'folderPath',
          key: 'typeOptions.buildRoot',
          label: 'Module root',
          relativeTo: 'workspaceFolder',
          help: 'Directory containing `go.mod`. Leave blank when `go.mod` is in the same directory as the project path. Override for monorepos where the module root is above the workspace folder, or when the project path is a subdirectory of the module.',
          examples: ['', 'backend', '..'],
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
        closeTerminalOnExitField(),
      ],
    };
  }

  buildCommand(cfg: RunConfig, _folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'go') throw new Error('GoAdapter received non-go config');
    const to = cfg.typeOptions;

    const goBin = to.goPath
      ? path.join(to.goPath.replace(/[/\\]$/, ''), 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
      : 'go';

    const raceFlag = to.race ? ['-race'] : [];
    const toolFlags = splitArgs(cfg.vmArgs ?? '');

    if (to.launchMode === 'run') {
      const pkg = to.packagePath?.trim() || '.';
      const programArgTokens = splitArgs(cfg.programArgs ?? '');
      return { command: goBin, args: ['run', ...raceFlag, ...toolFlags, pkg, ...programArgTokens] };
    }
    if (to.launchMode === 'test') {
      const testTokens = splitArgs(to.testArgs?.trim() ? to.testArgs : './...');
      return { command: goBin, args: ['test', ...raceFlag, ...toolFlags, ...testTokens] };
    }
    if (to.launchMode === 'build') {
      const outArgs = to.outputPath?.trim() ? ['-o', to.outputPath.trim()] : [];
      const pkg = to.packagePath?.trim() || '.';
      return { command: goBin, args: ['build', ...raceFlag, ...outArgs, ...toolFlags, pkg] };
    }
    if (to.launchMode === 'install') {
      const pkg = to.packagePath?.trim() || '.';
      return { command: goBin, args: ['install', ...toolFlags, pkg] };
    }
    // custom
    const customTokens = splitArgs(to.customArgs ?? '');
    return { command: goBin, args: customTokens };
  }

  async prepareLaunch(
    cfg: RunConfig,
    _folder: vscode.WorkspaceFolder,
    _ctx: { debug: boolean; debugPort?: number; monitor?: boolean; monitorPort?: number },
  ): Promise<{ env?: Record<string, string> }> {
    if (cfg.type !== 'go') return {};
    const env: Record<string, string> = {};

    // Color output
    if (cfg.typeOptions.colorOutput !== false) {
      env.FORCE_COLOR = '1';
      env.CLICOLOR_FORCE = '1';
      env.TERM = 'xterm-256color';
    }

    // Prepend the selected Go install's bin/ to PATH and set GOROOT.
    if (cfg.typeOptions.goPath) {
      const goRoot = cfg.typeOptions.goPath.replace(/[/\\]$/, '');
      const binDir = path.join(goRoot, 'bin');
      const pathSep = process.platform === 'win32' ? ';' : ':';
      env.GOROOT = goRoot;
      env.PATH = `${binDir}${pathSep}${process.env.PATH ?? ''}`;
    }

    return { env };
  }

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    if (cfg.type !== 'go') throw new Error('GoAdapter received non-go config');
    const to = cfg.typeOptions;

    // Resolve the project root: buildRoot > projectPath > workspaceFolder
    const projectRoot = to.buildRoot
      ? to.buildRoot
      : cfg.projectPath
      ? resolveProjectUri(folder, cfg.projectPath).fsPath
      : folder.uri.fsPath;

    // `program` must be an absolute path to a package directory so Delve
    // knows exactly which package to build. Relative package paths like
    // './cmd/server' are resolved against the project root. When no package
    // is specified we default to the project root itself (Delve will build
    // the package at that directory). Using '${workspaceFolder}' here is
    // wrong — it resolves to the VS Code workspace root, not the project
    // directory, causing "no Go files in …" errors for nested projects.
    const rawPkg = to.packagePath?.trim() || '';
    let program: string;
    if (!rawPkg || rawPkg === '.') {
      // No package specified — build the project root directory.
      program = projectRoot;
    } else if (path.isAbsolute(rawPkg)) {
      // Already absolute.
      program = rawPkg;
    } else {
      // Relative path like './cmd/server' or 'cmd/server'.
      program = path.resolve(projectRoot, rawPkg);
    }

    // cwd: the directory `go` runs from. For `go run ./cmd/server` this
    // is the module root (projectRoot), not the package directory itself.
    const cwd = projectRoot;

    const debugConfig: vscode.DebugConfiguration = {
      type: 'go',
      request: 'launch',
      name: cfg.name,
      // 'auto' lets Delve decide between 'debug' (run from source) and
      // 'exec' (run a pre-built binary) based on whether `program` is a
      // Go source package or a binary.
      mode: 'auto',
      program,
      args: splitArgs(cfg.programArgs ?? ''),
      env: { ...(cfg.env ?? {}) },
      cwd,
    };

    // Race detector flag is passed via buildFlags in debug mode.
    if (to.race) {
      debugConfig.buildFlags = '-race';
    }

    // Tool flags (ldflags, tags) go into buildFlags too.
    const toolFlags = (cfg.vmArgs ?? '').trim();
    if (toolFlags) {
      debugConfig.buildFlags = debugConfig.buildFlags
        ? `${debugConfig.buildFlags} ${toolFlags}`
        : toolFlags;
    }

    return debugConfig;
  }
}
