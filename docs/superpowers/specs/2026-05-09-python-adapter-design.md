# Python config adapter

**Date:** 2026-05-09
**Status:** Design approved, ready for implementation plan

## Problem

The extension supports Java, Spring Boot, Tomcat, Quarkus, npm, Docker, Maven goal, Gradle task, custom command, and HTTP request configurations. Python — the second-most-common runtime in the working population — is missing. Users with Python projects fall back to the `custom-command` adapter, which gives them no interpreter detection, no entry-point discovery, no framework awareness, and no debug support.

The fix: a new `python` adapter modeled on the Java adapter's structure, with Python-idiomatic detection (venvs, pyenv, pip), framework awareness, and debugpy-based debug.

## Goals

- A new `python` config type with name, project path, interpreter dropdown, launch-mode select, mode-specific entry-point fields, port, env files / env table / program args / dependsOn / etc.
- Auto-detect installed Python interpreters (system installs + project venvs + version managers) and surface them in a dropdown like the JDK selector.
- Auto-detect frameworks (django, fastapi, flask, uvicorn, gunicorn, celery, typer, click, starlette) from project metadata and pre-fill launch-mode + framework command + default port.
- Auto-detect entry-point scripts (`if __name__ == "__main__":`) and modules (`__main__.py` packages) and surface them in dropdowns.
- One-click debug via debugpy, with a clear "Fix: install debugpy" path when missing.
- Pip proxy info bubble below Save, re-evaluated when the user picks a different interpreter.
- Live command preview reflecting the current launch mode.

## Non-goals

- Full pytest test-name autocomplete (free-form `pytestArgs` textarea instead — covers ~95% of cases).
- Conda `conda activate` shell hooks (we point at `<env>/bin/python` directly; conda's activation script behaviors aren't replicated).
- Poetry/PDM `[project.scripts]` execution as a separate launch mode (user gets there through `module` + the import path).
- Auto-installing project requirements (`pip install -r requirements.txt`) before run.
- Linting / formatting tool runners (black/ruff/mypy) as launch modes — `custom-command` covers it.

## Architecture

A new adapter under `src/adapters/python/`, following the Java adapter's directory shape. Files are split by responsibility so each unit is testable on its own.

### Files

| File | Responsibility |
|---|---|
| `PythonAdapter.ts` | Main adapter class. Implements `RuntimeAdapter`. ~600 lines. |
| `detectPythons.ts` | Scans the system for Python interpreters. Returns absolute install dirs (one containing `bin/python` or `python.exe`). |
| `probePythonVersion.ts` | Spawns `<interpreter> --version`, parses to `{ version: '3.12.1' }`. Cached in-process per path. |
| `probePythonsStreaming.ts` | Two-phase emit: paths first (form usable), versions enriched second. Mirrors `probeJdksStreaming.ts`. |
| `findEntryPoints.ts` | Walks the project for `*.py` files containing `if __name__ == "__main__":`. Also identifies importable packages with `__main__.py`. |
| `detectFrameworks.ts` | Parses `pyproject.toml`, `requirements*.txt`, `setup.cfg` to detect known frameworks. Returns `Array<{ name; source }>`. |
| `detectPythonPort.ts` | Picks a default port from framework convention, Django settings, or Procfile/script `--port`. |
| `detectPipProxy.ts` | Runs `<interpreter>/pip config list` and merges with env vars. Returns merged proxy info. |
| `buildPythonCommand.ts` | Pure function: `(cfg) → { command, args }`. Branches on launchMode. |
| `frameworkCommands.ts` | Static data: per-framework default port + suggested command list. |

### Schema additions

```ts
// src/shared/types.ts
export type PythonLaunchMode = 'script' | 'module' | 'framework' | 'pytest' | 'custom';

export type PythonFramework =
  | '' | 'django' | 'fastapi' | 'flask' | 'uvicorn'
  | 'gunicorn' | 'celery' | 'typer' | 'starlette' | 'click';

export interface PythonTypeOptions {
  launchMode: PythonLaunchMode;
  pythonPath: string;          // absolute install dir; '' means "use python on PATH"
  scriptPath: string;          // relative to projectPath; only meaningful when launchMode='script'
  moduleName: string;          // dotted name; only meaningful when launchMode='module'
  framework: PythonFramework;  // only meaningful when launchMode='framework'
  frameworkCommand: string;    // only meaningful when launchMode='framework'
  pytestArgs: string;          // only meaningful when launchMode='pytest'
  customArgs: string;          // only meaningful when launchMode='custom'
  buildRoot: string;           // optional absolute path; '' = use projectPath
}

// Discriminated union
export type RunConfig =
  | …existing types…
  | (RunConfigBase & { type: 'python'; typeOptions: PythonTypeOptions });
```

```ts
// src/shared/schema.ts
export const PythonLaunchModeSchema = z.enum(['script', 'module', 'framework', 'pytest', 'custom']);
export const PythonFrameworkSchema = z.enum([
  '', 'django', 'fastapi', 'flask', 'uvicorn',
  'gunicorn', 'celery', 'typer', 'starlette', 'click',
]);

export const PythonTypeOptionsSchema = z.object({
  launchMode: PythonLaunchModeSchema,
  pythonPath: z.string().default(''),
  scriptPath: z.string().default(''),
  moduleName: z.string().default(''),
  framework: PythonFrameworkSchema.default(''),
  frameworkCommand: z.string().default(''),
  pytestArgs: z.string().default(''),
  customArgs: z.string().default(''),
  buildRoot: z.string().default(''),
});
```

### Detection sources

`detectPythons(projectUri)` scans, in priority order:

1. **Project-local venvs** (highest priority — auto-selected as default):
   - `<projectPath>/.venv`
   - `<projectPath>/venv`
   - `<projectPath>/env`
2. **`$VIRTUAL_ENV`** if set in the extension host's environment.
3. **`which python3` / `which python`** resolved through symlinks (skips the symlink → real install dedupe at the end).
4. **Version managers:**
   - `~/.pyenv/versions/<v>/`
   - `~/.asdf/installs/python/<v>/`
   - `~/.rye/py/<v>/install/` and `~/.local/share/rye/py/<v>/install/`
   - `~/.local/share/uv/python/<v>/` (uv-managed)
   - `~/.local/share/mise/installs/python/<v>/`
   - `~/.conda/envs/<name>/`, `~/miniconda3/envs/<name>/`, `~/anaconda3/envs/<name>/`
5. **Standard system locations:**
   - POSIX: `/usr/bin/python3`, `/usr/local/bin/python3`, `/opt/homebrew/bin/python3`, `/opt/homebrew/opt/python@*/bin/python3`, `/Library/Frameworks/Python.framework/Versions/*/bin/python3`
   - Windows: `C:\Python*\`, `C:\Program Files\Python*\`, `C:\Program Files (x86)\Python*\`, `%LOCALAPPDATA%\Programs\Python\Python*\`

Each candidate is validated by stat-ing `<dir>/bin/python` (POSIX) or `<dir>/python.exe` (Windows) and de-duped by `realpath`. The shape of `detectPythons` mirrors `detectJdks`/`detectNodes` exactly.

### Form schema (per launchMode)

The form changes shape based on `typeOptions.launchMode`. Common fields are always present; mode-specific fields use the existing `dependsOn` mechanism on FormField to show/hide.

| Field | script | module | framework | pytest | custom |
|---|---|---|---|---|---|
| Name (common) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Project path (common) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Python runtime (selectOrCustom + ☁ icon) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Launch mode (select) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Script (selectOrCustom of detected entry points + folder picker) | ✓ | | | | |
| Module (selectOrCustom of detected modules) | | ✓ | | | |
| Framework (select) | | | ✓ | | |
| Framework command (selectOrCustom, options scoped to selected framework) | | | ✓ | | |
| Pytest args (textarea) | | | | ✓ | |
| Custom args (textarea, inspectable) | | | | | ✓ |
| Port | ✓ | ✓ | ✓ | | ✓ |
| Interpreter args (`vmArgs` slot, e.g. `-O -W default`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Program args | ✓ | ✓ | ✓ | | |
| envFiles, env, dependsOn, group, closeTerminalOnExit | (advanced section, all modes) |

### Framework detection

`detectFrameworks(folder)` parses, first-match-wins per package name:

1. `pyproject.toml` → `[project] dependencies` (PEP 621)
2. `pyproject.toml` → `[tool.poetry] dependencies`
3. `requirements*.txt` (any matching glob)
4. `setup.cfg` → `[options] install_requires`
5. `setup.py` is skipped — parsing it would require executing arbitrary code.

Returns `Array<{ name: PythonFramework; source: string }>`. Source is the relative path of the file the dependency was found in, surfaced in the help bubble for transparency.

Per framework — `frameworkCommands.ts` holds:

```ts
{
  django: { defaultPort: 8000, commands: ['runserver', 'runserver 0.0.0.0:8000', 'migrate', 'makemigrations', 'shell', 'createsuperuser', 'test', 'collectstatic'] },
  fastapi: { defaultPort: 8000, commands: ['app:main --reload'] /* augmented at runtime by scanning for FastAPI() instances */ },
  flask: { defaultPort: 5000, commands: ['--app <auto> run', '--app <auto> run --debug'] },
  uvicorn: { defaultPort: 8000, commands: ['app:main', 'app:main --reload'] },
  gunicorn: { defaultPort: 8000, commands: ['app:app -b 0.0.0.0:8000', 'app:app -w 4 -b 0.0.0.0:8000'] },
  celery: { defaultPort: null, commands: ['-A <auto> worker --loglevel=info', '-A <auto> beat'] },
  typer: { defaultPort: null, commands: [] /* CLI — user picks the script in script mode */ },
  starlette: { defaultPort: 8000, commands: ['app:main'] },
  click: { defaultPort: null, commands: [] },
}
```

`<auto>` placeholders are resolved at form-schema build time by scanning the project for matching imports — `findFastapiApps()`, `findFlaskApps()`, `findCeleryApps()` — each implementation is small (~30 lines) and lives next to `detectFrameworks.ts`.

### Port detection

`detectPythonPort(folder, framework)` looks in this order, first hit wins:

1. **Procfile** at the project root: parse lines like `web: uvicorn app:main --port 9000`. Look for `--port <n>`, `-p <n>`, or `:<n>` in bind strings (`-b 0.0.0.0:9000`).
2. **`runserver` argument** in any `*.sh` / `Makefile` / `*.cfg` script under the project (regex match for `runserver[: ]([\d:.]+)`).
3. **Django settings module:** if `settings.py` (or `settings/__init__.py`) exists, search for `RUN_PORT = <n>` or similar — same lightweight approach Django itself uses for `manage.py runserver`. (Django doesn't actually have a port setting; `manage.py runserver` defaults to 8000. We fall through to (4) when nothing matches.)
4. **Framework convention default** from `frameworkCommands.ts`.

Returns `number | undefined`. The user can override via the form's `port` field.

### Pip proxy detection

`detectPipProxy(interpreterPath)`:

1. Spawn `<interpreterPath>/<binname> -m pip config list` with a 2-second timeout.
2. Parse output (key=value lines like `global.proxy='http://corp:8080'`, `global.index-url='https://nexus.local/simple'`).
3. Merge with `process.env.HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`. Pip config wins for `proxyUrl` and `indexUrl`; env vars fill in when pip is silent.
4. Returns:
   ```ts
   { proxyUrl: string | null;
     indexUrl: string | null;
     noProxy: string | null;
     source: 'pip' | 'env' | 'mixed' | 'none' }
   ```

The form's advanced section includes an `info`-kind FormField that renders this when non-empty:

> **Effective pip proxy:** `http://corp:8080`
> **Index URL:** `https://nexus.local/simple`
> **Source:** pip config (also overrides `$HTTP_PROXY`)

Hidden when `source === 'none'`. Re-evaluates whenever `typeOptions.pythonPath` changes — handled by emitting a fresh `pipProxy` value in the streaming context whenever the field's currently-bound value changes. The webview's existing `dependsOn`/schema-update mechanism already supports field-level re-renders on context changes.

### Debug

`getDebugConfig(cfg, folder)` returns a `vscode.DebugConfiguration` with:

```ts
{
  type: 'debugpy',
  request: 'attach',
  name: cfg.name,
  connect: { host: '127.0.0.1', port: <ctx.debugPort ?? 5678> },
  pathMappings: [{ localRoot: '<projectPath>', remoteRoot: '.' }],
  justMyCode: true,
}
```

`prepareLaunch(cfg, folder, ctx)` (called when `ctx.debug === true`):
1. Probes whether `debugpy` is importable: spawns `<interpreter> -m debugpy --version`. Cached per-interpreter.
2. If missing, throws `DebugpyMissingError(interpreterPath)` so ExecutionService can surface a Fix-button error to the user.
3. Otherwise, returns `extraArgs: ['-m', 'debugpy', '--listen', `127.0.0.1:${ctx.debugPort}`, '--wait-for-client']` to be prepended in front of the user's command.

ExecutionService catches `DebugpyMissingError` and renders an actionable error toast: "debugpy not installed in `<interpreter>`. [Install]" — clicking Install runs `<interpreter> -m pip install debugpy` and retries.

The Fix button lives on the Python field's existing schema (kind `'action'` with id `'installDebugpy'`, shown only when `prepareLaunch` failed with the missing error). Same pattern the Spring Boot "Recompute classpath" button uses for action IDs.

### Command preview

`buildPythonCommand(cfg, folder)`:

| launchMode | command | args |
|---|---|---|
| `script` | `<py>/bin/python` | `[...interpreterArgs, scriptPath, ...programArgs]` |
| `module` | `<py>/bin/python` | `[...interpreterArgs, '-m', moduleName, ...programArgs]` |
| `framework` | `<py>/bin/python` | `[...interpreterArgs, ...frameworkInvocation, ...programArgs]` (per framework table) |
| `pytest` | `<py>/bin/python` | `[...interpreterArgs, '-m', 'pytest', ...splitArgs(pytestArgs)]` |
| `custom` | `<py>/bin/python` | `[...interpreterArgs, ...splitArgs(customArgs)]` |

When `pythonPath` is empty, `<py>/bin/python` falls back to `python3` on PATH.

The form's existing `buildCommandPreview` rendering picks this up automatically through the registered adapter — no separate UI work for the live preview.

## Schema migration

No migration needed for existing configs (Python type is new). The Zod schema's `default('')` semantics handle pre-this-spec save formats during the staged rollout.

## Error handling

- **No interpreters found:** Streaming emits an empty `pythons` array; the dropdown shows "No Python interpreters detected — install one or download manually." Form save still works with an empty `pythonPath` (falls back to `python3` on PATH at run time). A `selectOrCustom` field accepts a manually-typed path.
- **Selected interpreter doesn't exist on disk:** Run-time error from `child_process.spawn`. Clear error in the integrated terminal.
- **`debugpy` not installed:** Caught in `prepareLaunch`, surfaces as the Fix-button error described above.
- **Framework detection fails (malformed pyproject.toml, etc.):** Logged as `log.warn`, detection returns `[]`. Form shows the launchMode dropdown without framework option.
- **Pip proxy probe times out:** Returns `{ source: 'env', ... }` using only env vars. Logged at debug level.

## Testing

Each detection / parsing module gets its own focused test file:

- `detectPythons.test.ts` — venv detection (`.venv` / `venv` / `env`), pyenv scan, asdf scan, uv scan, conda envs, fixed-roots scan, dedupe by realpath, Windows path handling.
- `probePythonVersion.test.ts` — parses `Python 3.12.1`, handles trailing whitespace, returns `undefined` for non-version output, 2-second timeout.
- `findEntryPoints.test.ts` — `if __name__ == "__main__":` regex (single-line, multi-line, with type hint annotations), `__main__.py` discovery, ignores `tests/` and `.venv/` and `__pycache__/`.
- `detectFrameworks.test.ts` — pyproject (PEP 621), poetry, requirements.txt (with version pins, hashes, comments), setup.cfg, mixed sources.
- `detectPythonPort.test.ts` — Procfile parsing (`--port`, `-p`, bind strings), Django settings, framework defaults, fall-through to `undefined`.
- `detectPipProxy.test.ts` — pip output parsing (`global.proxy='...'` quoted/unquoted), env var merge, source labeling.
- `buildPythonCommand.test.ts` — every launchMode branch, with and without `pythonPath`, with and without `interpreterArgs`/`programArgs`, framework-specific arg expansion.
- `PythonAdapter.detect.test.ts` — adapter detection result shape, framework → defaults pre-fill.
- `PythonAdapter.build.test.ts` — adapter `buildCommand` integration, debug-mode `prepareLaunch` error path.

Roughly 60-80 new test cases.

## Risks

- **`detectPythons` cost.** Eight detection sources × parallel stat calls × per-path version probe = noticeable IO on slow filesystems. Mitigation: streaming detection means the form is usable before version probes finish, and version probes run in `Promise.all` with per-call 2-second timeouts (mirrors JDK detection).
- **Framework detection accuracy.** Reading dependencies isn't perfect — a project that imports `flask` but doesn't declare it in `pyproject.toml` won't be detected. Acceptable: the `custom` launchMode covers any miss.
- **debugpy install dependency.** First Debug click on a fresh interpreter triggers a `pip install debugpy` (50-100 MB download). Mitigation: the Fix button explains what it's doing; we don't auto-install silently.
- **Conda activation gap.** We point at `<env>/bin/python` directly, bypassing `conda activate`. For most user code this is fine, but conda envs that rely on activation hooks (CUDA env, certain compiled packages) may not work. Documented in the field help text. Users with this constraint can fall back to `custom-command` and run `conda run -n env python ...`.
- **Procfile parsing edge cases.** Heroku Procfile lines have many shapes. We do a best-effort regex match; if we miss the port, the user just types it.

## Out of scope (deferred)

- pytest test-name discovery / autocomplete.
- Conda `conda activate` shell hook integration.
- Poetry/PDM `[project.scripts]` console-script execution as a launchMode.
- Auto-install requirements before run (`pip install -r requirements.txt`).
- Tox/nox runner support.
- Tool runners (black/ruff/mypy as a launchMode).
- A separate Python installer dialog (downloads from python.org) — too platform-specific for v1; users install Python through their preferred tool.
