import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch, PrepareContext, PrepareResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { detectPythons } from './detectPythons';
import { probePythonsStreaming, readPythons, pythonOption } from './probePythonsStreaming';
import { findEntryPoints, type ScriptEntryPoint, type ModuleEntryPoint } from './findEntryPoints';
import { detectFrameworks, type FrameworkHit } from './detectFrameworks';
import { findAsgiApps, findDjangoProject, type AsgiAppHit, type DjangoProject } from './findAsgiApps';
import { detectPythonPort } from './detectPythonPort';
import { detectPipProxy, type PipProxyInfo } from './detectPipProxy';
import { buildPythonCommand } from './buildPythonCommand';
import { FRAMEWORK_COMMANDS } from './frameworkCommands';
import { dependsOnField, envFilesField, closeTerminalOnExitField } from '../sharedFields';
import { log } from '../../utils/logger';

const VAR_SYNTAX_HINT =
  'Supports `${VAR}` and `${env:VAR}` (environment variables), `${workspaceFolder}`, `${userHome}`, and `${cwd}` / `${projectPath}`. Unresolved variables expand to an empty string at launch.';

export class PythonAdapter implements RuntimeAdapter {
  readonly type = 'python' as const;
  readonly label = 'Python';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`python detect: ${folder.fsPath}`);
    return {
      defaults: {
        type: 'python',
        typeOptions: {
          launchMode: 'script',
          pythonPath: '',
          scriptPath: '',
          moduleName: '',
          framework: '',
          frameworkCommand: '',
          pytestArgs: '',
          customArgs: '',
          buildRoot: '',
        },
      },
      context: {
        pythons: [],
        entryPoints: { scripts: [], modules: [] },
        frameworks: [],
      },
    };
  }

  async detectStreaming(folder: vscode.Uri, emit: (p: StreamingPatch) => void): Promise<void> {
    // Phase 1: synchronous-feeling — emit entry points + frameworks + port
    // immediately, then kick off the python-version probes.
    const [entryPoints, frameworks, asgiApps, djangoProject] = await Promise.all([
      findEntryPoints(folder),
      detectFrameworks(folder),
      findAsgiApps(folder),
      findDjangoProject(folder),
    ]);
    const primaryFramework = frameworks[0]?.name ?? '';
    const port = await detectPythonPort(folder, primaryFramework);
    // Pre-fill framework + frameworkCommand when a framework is detected.
    // Prefer a project-specific ASGI/WSGI app reference (`module:attr`)
    // over the static "app:main --reload" boilerplate, which is wrong for
    // virtually every real project. Falls back to the static suggestion
    // when no app instance was found in the source tree.
    // mergeBlanks semantics in the webview means a saved config's existing
    // values are preserved.
    const frameworkDefault = primaryFramework
      ? FRAMEWORK_COMMANDS[primaryFramework]
      : undefined;
    const frameworkCommand = pickFrameworkCommandDefault(
      primaryFramework,
      asgiApps,
      djangoProject,
      frameworkDefault?.commands[0] ?? '',
    );
    const defaultsPatch: Record<string, unknown> = {};
    if (port !== undefined) defaultsPatch.port = port;
    if (primaryFramework) {
      defaultsPatch.typeOptions = {
        framework: primaryFramework,
        ...(frameworkCommand ? { frameworkCommand } : {}),
      };
    }
    emit({
      contextPatch: {
        entryPoints,
        frameworks,
        asgiApps,
        djangoProject,
        ...(port !== undefined ? { detectedPort: port } : {}),
      },
      ...(Object.keys(defaultsPatch).length > 0
        ? { defaultsPatch: defaultsPatch as any }
        : {}),
    });

    // Phase 2 + 3: pythons.
    await probePythonsStreaming(folder, emit, 'python');

    // Phase 4: pip proxy probe — uses the just-detected default python.
    const pythonPaths = await detectPythons(folder);
    const proxy = await detectPipProxy(pythonPaths[0]);
    emit({ contextPatch: { pipProxy: proxy } });
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const pythons = readPythons(context.pythons);
    const entryPoints = (context.entryPoints as { scripts: ScriptEntryPoint[]; modules: ModuleEntryPoint[] } | undefined)
      ?? { scripts: [], modules: [] };
    const frameworks = (context.frameworks as FrameworkHit[] | undefined) ?? [];
    const asgiApps = (context.asgiApps as AsgiAppHit[] | undefined) ?? [];
    const djangoProject = context.djangoProject as DjangoProject | undefined;
    const pipProxy = context.pipProxy as PipProxyInfo | undefined;

    const launchModeField: FormField = {
      kind: 'select',
      key: 'typeOptions.launchMode',
      label: 'Launch mode',
      options: [
        { value: 'script', label: 'Run a script (.py file)' },
        { value: 'module', label: 'Run a module (-m)' },
        { value: 'framework', label: 'Run a framework' },
        { value: 'pytest', label: 'Run pytest' },
        { value: 'custom', label: 'Custom command' },
      ],
      help: 'Selects how the interpreter is invoked. The form changes shape based on this — script mode shows a file picker, framework mode shows a command select scoped to the detected framework, etc.',
    };

    const fwOptions: Array<{ value: string; label: string }> =
      frameworks.map(f => ({ value: f.name as string, label: f.name as string }));
    if (fwOptions.length === 0) fwOptions.push({ value: '', label: '(none detected)' });

    const fwBadge = frameworks.length
      ? `**Detected frameworks:** ${frameworks.map(f => `\`${f.name}\``).join(', ')}\n\n`
      : '';

    // pip-proxy info is rendered in the persistent BuildToolSettingsPanel
    // under the form's Save/Cancel row (same place Maven/Gradle proxies
    // appear). It re-fetches whenever pythonPath changes via the
    // `loadBuildToolSettings` webview round-trip — no inline field here.
    void pipProxy;

    // No-venv hint: when none of the detected pythons live under the
    // project (i.e. no `.venv` / `venv` / `env` exists), show an info
    // banner with a [Create .venv] button. Common for fresh clones where
    // the user hasn't run `python -m venv .venv` yet — without it,
    // `pip install <fw>` would dump packages into the system interpreter.
    //
    // Detection of "is a project venv" is conservative: any path that
    // contains the project root as a prefix counts. Misses uv/poetry-
    // managed venvs that live outside the project tree (e.g.
    // `~/.cache/pypoetry/virtualenvs/<name>/`) — those are still
    // selectable, just not recognized as "the project venv".
    const projectPath = (context.projectPath as string | undefined) ?? '';
    const hasProjectVenv = pythons.some(p =>
      /[\\/](\.venv|venv|env)([\\/]|$)/.test(p.path),
    );
    const noVenvHint: FormField | null = (!hasProjectVenv && pythons.length === 0)
      ? null  // No pythons at all — don't suggest venv creation; user has nothing to create one with.
      : !hasProjectVenv
        ? {
            kind: 'info',
            key: 'noVenvHint',
            label: 'No project venv',
            content: {
              banner: {
                kind: 'warning',
                text:
                  'No virtual environment found in this project. Without one, ' +
                  '`pip install` would write to the system interpreter — usually not what you want. ' +
                  'Click below to create a `.venv` using the selected interpreter.',
              },
            },
            action: {
              id: 'createVenv',
              label: 'Create .venv',
              busyLabel: 'Creating .venv…',
              title: 'Run `<python> -m venv .venv` in the project root',
            },
          }
        : null;

    // Framework-import advisory: when launchMode='framework' and a framework
    // is picked, hint at the missing module so the user can pre-emptively
    // install it. Only fires when a runtime probe didn't find the module —
    // we surface a banner that maps the framework to its required `-m`
    // target. The actual probe runs at launch time (B); this is just the
    // up-front hint.
    const frameworkImportHint: FormField | null = (() => {
      // Static map mirrors buildPythonCommand.FRAMEWORK_M_TARGET — duplicated
      // here because that file uses node-only imports the form-schema path
      // can't reach.
      const target: Record<string, string | null> = {
        django: 'django', flask: 'flask', uvicorn: 'uvicorn',
        gunicorn: 'gunicorn', celery: 'celery',
        fastapi: 'uvicorn', starlette: 'uvicorn',
        typer: null, click: null,
      };
      const detected = frameworks[0]?.name ?? '';
      const importTarget = detected ? target[detected] : undefined;
      if (!importTarget) return null;
      return {
        kind: 'info',
        key: 'frameworkImportHint',
        label: `Missing package?`,
        content: {
          banner: {
            kind: 'muted',
            text:
              `${detected === importTarget ? detected : `${detected} runs through ${importTarget}`}` +
              ` — make sure \`${importTarget}\` is installed in the chosen interpreter. ` +
              `If it isn't, the run will fail with \`ModuleNotFoundError\`. ` +
              `Click below to install it now.`,
          },
        },
        action: {
          id: `pipInstall:${importTarget}`,
          label: `Install ${importTarget}`,
          busyLabel: `Installing ${importTarget}…`,
          title: `Run \`<python> -m pip install ${importTarget}\` in a fresh terminal`,
        },
        dependsOn: { key: 'typeOptions.launchMode', equals: 'framework' },
      };
    })();

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Python App',
          help: 'Display name shown in the sidebar.',
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to your Python project, relative to the workspace folder.',
          examples: ['', 'apps/api', 'src'],
        },
      ],
      typeSpecific: [
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.pythonPath',
          label: 'Python runtime',
          options: pythons.map(pythonOption),
          placeholder: '/path/to/python-home',
          help:
            fwBadge +
            'Python interpreter to use for this configuration.\n\n' +
            'Auto-detected from `.venv` / `venv` / `env`, `$VIRTUAL_ENV`, `python3` on `PATH`, ' +
            'version managers (`pyenv`, `asdf`, `rye`, `uv`, `mise`, `conda`), and standard ' +
            'install locations.\n\n' +
            'Leave blank to use whatever `python3` is on `PATH` when VS Code started.',
          examples: ['/proj/.venv', '~/.pyenv/versions/3.12.1'],
        },
        ...(noVenvHint ? [noVenvHint] : []),
        launchModeField,
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.scriptPath',
          label: 'Script',
          options: entryPoints.scripts.map(s => ({ value: s.relativePath, label: s.relativePath })),
          placeholder: 'main.py',
          help: entryPoints.scripts.length
            ? `Detected ${entryPoints.scripts.length} script(s) with \`if __name__ == "__main__":\`. Pick one or type a different path.`
            : 'Path to the .py file to run. No entry-point scripts detected — type the path you want.',
          dependsOn: { key: 'typeOptions.launchMode', equals: 'script' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.moduleName',
          label: 'Module',
          options: entryPoints.modules.map(m => ({ value: m.dotted, label: m.dotted })),
          placeholder: 'mypkg.cli',
          help: entryPoints.modules.length
            ? `Detected ${entryPoints.modules.length} package(s) with a \`__main__.py\`. Pick one or type a different dotted name.`
            : 'Dotted module name (e.g. `mypkg.cli`). Runs via `python -m <module>`.',
          dependsOn: { key: 'typeOptions.launchMode', equals: 'module' },
        },
        {
          kind: 'select',
          key: 'typeOptions.framework',
          label: 'Framework',
          options: fwOptions,
          help: fwBadge + 'Framework to run. The framework command select below offers framework-specific options.',
          dependsOn: { key: 'typeOptions.launchMode', equals: 'framework' },
        },
        ...(frameworkImportHint ? [frameworkImportHint] : []),
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.frameworkCommand',
          label: 'Framework command',
          options: buildFrameworkCommandOptions(frameworks, asgiApps, djangoProject),
          placeholder: 'runserver',
          help: 'Command passed to the framework. The dropdown is scoped to the selected framework above; pick `Custom…` to type your own.',
          dependsOn: { key: 'typeOptions.launchMode', equals: 'framework' },
        },
        {
          kind: 'textarea',
          key: 'typeOptions.pytestArgs',
          label: 'Pytest args',
          rows: 2,
          placeholder: 'tests/foo.py::TestX -k smoke',
          help: 'Free-form pytest selection. Runs `python -m pytest <args>`. ' + VAR_SYNTAX_HINT,
          dependsOn: { key: 'typeOptions.launchMode', equals: 'pytest' },
          inspectable: true,
        },
        {
          kind: 'textarea',
          key: 'typeOptions.customArgs',
          label: 'Custom command',
          rows: 2,
          placeholder: '-c "import sys; print(sys.version)"',
          help: 'Arguments appended verbatim to the interpreter. ' + VAR_SYNTAX_HINT,
          dependsOn: { key: 'typeOptions.launchMode', equals: 'custom' },
          inspectable: true,
        },
        {
          kind: 'number',
          key: 'port',
          label: 'Port (optional)',
          min: 1,
          max: 65535,
          help: 'Informational. Lets you remember which port the app uses; the script itself binds.',
          examples: ['8000', '5000'],
          dependsOn: { key: 'typeOptions.launchMode', equals: ['script', 'module', 'framework', 'custom'] },
        },
      ],
      advanced: [
        envFilesField(),
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['DJANGO_SETTINGS_MODULE=myproj.settings', 'DEBUG=1'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--verbose',
          help: 'Arguments passed to the script / module / framework command. ' + VAR_SYNTAX_HINT,
          inspectable: true,
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'Interpreter args',
          placeholder: '-O -W default',
          help: 'Flags passed to the python interpreter itself (before the script / -m). E.g. `-O` (optimize), `-W default` (warning filter), `-Xfaulthandler`. ' + VAR_SYNTAX_HINT,
          examples: ['-O', '-W default', '-Xfaulthandler'],
          inspectable: true,
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
        closeTerminalOnExitField(),
      ],
    };
  }

  buildCommand(cfg: RunConfig): { command: string; args: string[] } {
    return buildPythonCommand(cfg);
  }

  async prepareLaunch(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    ctx: PrepareContext,
  ): Promise<PrepareResult> {
    if (cfg.type !== 'python') return {};
    if (!ctx.debug) return {};
    // Probe for debugpy. If missing, throw a structured error so
    // ExecutionService can render the Fix-button.
    const pythonHome = cfg.typeOptions.pythonPath || '';
    const ok = await debugpyAvailable(pythonHome);
    if (!ok) {
      const err = new Error(`debugpy is not installed in the selected interpreter (${pythonHome || 'system python'}). Install it with: ${pythonHome ? pythonHome + '/bin/' : ''}pip install debugpy`);
      (err as any).debugpyMissing = true;
      (err as any).pythonHome = pythonHome;
      throw err;
    }
    const port = ctx.debugPort ?? 5678;

    // Composition matters here. ExecutionService runs:
    //   <command> <prepared.extraArgs...> <built.args...>
    // where built.args already starts with the user's vmArgs (interpreter
    // flags). For debugpy we need:
    //   python <vmArgs> -m debugpy --listen … --wait-for-client <script> <args>
    // i.e. vmArgs MUST come before `-m debugpy`, and debugpy's own
    // positional slot (the script) must come after `--wait-for-client`.
    //
    // To get that ordering:
    //   1. Hoist the user's vmArgs into extraArgs, in front of the debugpy
    //      bootstrap (so they sit before `-m debugpy`).
    //   2. Clear vmArgs on the cfg returned via PrepareResult.cfg, so
    //      buildPythonCommand doesn't re-emit them after `--wait-for-client`
    //      where debugpy would treat the first one (e.g. `-O`) as the
    //      script path.
    //
    // We also stash the chosen port on the cfg (via __debugPort) so
    // getDebugConfig agrees on the same port — the harness can pass a
    // non-default debugPort, and a mismatch between the listener and the
    // attach config makes attach silently fail.
    const origVmArgs = (cfg.vmArgs ?? '').trim();
    const vmArgsList = origVmArgs ? origVmArgs.split(/\s+/) : [];
    const updatedCfg: RunConfig = {
      ...cfg,
      vmArgs: '',
    };
    (updatedCfg as any).__debugPort = port;

    return {
      cfg: updatedCfg,
      extraArgs: [
        ...vmArgsList,
        '-m',
        'debugpy',
        '--listen',
        `127.0.0.1:${port}`,
        '--wait-for-client',
      ],
    };
  }

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    // Port must match what prepareLaunch passed to debugpy --listen. When
    // prepareLaunch ran, it stashed the chosen port on the cfg via
    // __debugPort; if it didn't (e.g. non-debug code paths exercising this
    // method directly), fall back to debugpy's default 5678.
    const port = ((cfg as any).__debugPort as number | undefined) ?? 5678;
    return {
      type: 'debugpy',
      request: 'attach',
      name: cfg.name,
      connect: { host: '127.0.0.1', port },
      pathMappings: [{ localRoot: folder.uri.fsPath, remoteRoot: '.' }],
      justMyCode: true,
    };
  }
}

// Picks the best default value for the `frameworkCommand` field given
// the detected primary framework + any project-specific app instances
// found by findAsgiApps + django manage.py probe. The static suggestion
// (e.g. "app:main --reload") is the last-resort fallback — it's almost
// never correct for real projects.
function pickFrameworkCommandDefault(
  primaryFramework: string,
  asgiApps: AsgiAppHit[],
  djangoProject: DjangoProject | null,
  staticFallback: string,
): string {
  if (!primaryFramework) return staticFallback;
  if (primaryFramework === 'django' && djangoProject) {
    // `manage.py runserver` auto-loads DJANGO_SETTINGS_MODULE — what
    // every Django tutorial uses. `python -m django runserver` would
    // require the user to set the env var explicitly.
    return `${djangoProject.managePy} runserver`;
  }
  const matchingApp = asgiApps.find(a => a.framework === primaryFramework);
  if (matchingApp) {
    if (primaryFramework === 'fastapi' || primaryFramework === 'starlette') {
      return `${matchingApp.ref} --reload`;
    }
    if (primaryFramework === 'flask') {
      return `--app ${matchingApp.module} run`;
    }
    if (primaryFramework === 'celery') {
      return `-A ${matchingApp.module} worker --loglevel=info`;
    }
  }
  return staticFallback;
}

function buildFrameworkCommandOptions(
  frameworks: FrameworkHit[],
  asgiApps: AsgiAppHit[],
  djangoProject: DjangoProject | undefined,
): Array<{ value: string; label: string; group?: string; description?: string }> {
  const out: Array<{ value: string; label: string; group?: string; description?: string }> = [];
  for (const f of frameworks) {
    // Project-specific suggestions FIRST — values derived from actual
    // source-scan hits, not the static "app:main --reload" boilerplate.
    if (f.name === 'django' && djangoProject) {
      // Django: route through manage.py so DJANGO_SETTINGS_MODULE
      // auto-loads. `python -m django <subcmd>` would require the user
      // to set the env var manually.
      const mp = djangoProject.managePy;
      out.push(
        { value: `${mp} runserver`,             label: `${mp} runserver`,            group: 'django', description: 'detected' },
        { value: `${mp} runserver 0.0.0.0:8000`, label: `${mp} runserver 0.0.0.0:8000`, group: 'django', description: 'detected (all interfaces)' },
        { value: `${mp} migrate`,               label: `${mp} migrate`,              group: 'django', description: 'detected' },
        { value: `${mp} makemigrations`,        label: `${mp} makemigrations`,       group: 'django', description: 'detected' },
        { value: `${mp} shell`,                 label: `${mp} shell`,                group: 'django', description: 'detected' },
        { value: `${mp} createsuperuser`,       label: `${mp} createsuperuser`,      group: 'django', description: 'detected' },
        { value: `${mp} test`,                  label: `${mp} test`,                 group: 'django', description: 'detected' },
        { value: `${mp} collectstatic`,         label: `${mp} collectstatic`,        group: 'django', description: 'detected' },
      );
    }
    // ASGI/WSGI app instances — `<module>:<attr>` for FastAPI / Flask /
    // Starlette, and `-A <module>` for Celery.
    const projectAppsForFramework = asgiApps.filter(a => a.framework === f.name);
    for (const a of projectAppsForFramework) {
      if (f.name === 'fastapi' || f.name === 'starlette') {
        out.push({
          value: `${a.ref} --reload`,
          label: `${a.ref} --reload`,
          group: f.name,
          description: 'detected (with auto-reload)',
        });
        out.push({
          value: a.ref,
          label: a.ref,
          group: f.name,
          description: 'detected',
        });
      } else if (f.name === 'flask') {
        // Flask CLI takes `--app <module>` not `<module>:<attr>` —
        // `flask --app <module>` looks for the FIRST Flask instance
        // by convention; if multiple, the user's explicit `<attr>`
        // (`<module>:<attr>`) variant disambiguates.
        out.push({
          value: `--app ${a.module} run`,
          label: `--app ${a.module} run`,
          group: f.name,
          description: 'detected',
        });
        out.push({
          value: `--app ${a.module} run --debug`,
          label: `--app ${a.module} run --debug`,
          group: f.name,
          description: 'detected (debug mode)',
        });
      } else if (f.name === 'celery') {
        out.push({
          value: `-A ${a.module} worker --loglevel=info`,
          label: `-A ${a.module} worker --loglevel=info`,
          group: 'celery',
          description: 'detected (worker)',
        });
        out.push({
          value: `-A ${a.module} beat`,
          label: `-A ${a.module} beat`,
          group: 'celery',
          description: 'detected (beat)',
        });
        out.push({
          value: `-A ${a.module} flower`,
          label: `-A ${a.module} flower`,
          group: 'celery',
          description: 'detected (flower monitor)',
        });
      }
    }
    // Gunicorn doesn't have its own ctor — it RUNS WSGI/ASGI apps.
    // Reuse the FastAPI/Flask/Starlette hits as candidates.
    if (f.name === 'gunicorn') {
      const wsgiCandidates = asgiApps.filter(a =>
        a.framework === 'fastapi' || a.framework === 'flask' || a.framework === 'starlette',
      );
      for (const a of wsgiCandidates) {
        out.push({
          value: `${a.ref} -b 0.0.0.0:8000`,
          label: `${a.ref} -b 0.0.0.0:8000`,
          group: 'gunicorn',
          description: `detected (${a.framework})`,
        });
        out.push({
          value: `${a.ref} -w 4 -b 0.0.0.0:8000`,
          label: `${a.ref} -w 4 -b 0.0.0.0:8000`,
          group: 'gunicorn',
          description: `detected (${a.framework}, 4 workers)`,
        });
      }
    }
    // Generic fallback suggestions from the static spec — useful when
    // detection didn't find anything (CLI-only frameworks, or projects
    // where the instance lives somewhere we don't scan).
    const spec = FRAMEWORK_COMMANDS[f.name];
    if (!spec) continue;
    for (const cmd of spec.commands) {
      out.push({ value: cmd, label: cmd, group: f.name });
    }
  }
  return out;
}

async function debugpyAvailable(pythonHome: string): Promise<boolean> {
  // Spawns `<py> -m debugpy --version`. 2 s timeout. Treats any non-zero
  // exit as "not available".
  // require() (not dynamic import) so Jest CommonJS can resolve the
  // modules without --experimental-vm-modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process');
  const bin = !pythonHome
    ? 'python3'
    : process.platform === 'win32'
      ? path.join(pythonHome, 'python.exe')
      : path.join(pythonHome, 'bin', 'python3');
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = cp.spawn(bin, ['-m', 'debugpy', '--version'], { windowsHide: true }); }
    catch { resolve(false); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 2000);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timed) return;
      resolve(code === 0);
    });
  });
}
