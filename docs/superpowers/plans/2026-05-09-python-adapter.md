# Python Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `python` config type to the extension. Detects installed interpreters (system, venvs, version managers), entry-point scripts and modules, popular frameworks and their default ports, pip proxy settings; supports debug via `debugpy`; renders a launchMode-aware form.

**Architecture:** Mirrors the existing `java` adapter's directory structure under `src/adapters/python/`. Pure detection / parser modules each in their own file. Adapter orchestrates them via `detect()` and `detectStreaming()`. Schema and types extended discriminated-union style alongside the other 10 adapters.

**Tech Stack:** TypeScript, Node `child_process`, Zod for schema validation, Jest for tests, the existing `RuntimeAdapter` interface, the existing `archiveInstall.ts` helpers (paths only — no installer for Python in v1), the existing `dependsOn` mechanism on FormField for launchMode-driven UI changes.

---

## Spec reference

Implements `docs/superpowers/specs/2026-05-09-python-adapter-design.md`.

## File map

**New files (under `src/adapters/python/`):**

| File | Responsibility |
|---|---|
| `PythonAdapter.ts` | Main adapter class. `RuntimeAdapter` impl. Orchestrates detection + form schema + buildCommand + getDebugConfig + prepareLaunch. |
| `detectPythons.ts` | Scans the filesystem for Python interpreter install dirs. Returns `string[]`. |
| `probePythonVersion.ts` | Spawns `<py> --version`, parses `Python 3.12.1` → `'3.12.1'`. Cached per path. |
| `probePythonsStreaming.ts` | Two-phase emit (paths → enriched). Mirrors `probeJdksStreaming.ts`. |
| `findEntryPoints.ts` | Walks the project for `if __name__ == "__main__":` files + `__main__.py` packages. |
| `detectFrameworks.ts` | Parses `pyproject.toml` / `requirements*.txt` / `setup.cfg` for known frameworks. |
| `detectPythonPort.ts` | Picks default port (Procfile / framework default). |
| `detectPipProxy.ts` | Runs `<py>/pip config list`, merges with env vars. |
| `frameworkCommands.ts` | Static data: per-framework default port + suggested commands. |
| `buildPythonCommand.ts` | Pure `(cfg) → { command, args }`. |
| `splitArgs.ts` | (Reuses the existing `src/adapters/npm/splitArgs.ts` — no new file.) |

**Test files (under `test/`):** one per pure module, plus the adapter integration tests:
- `detectPythons.test.ts`
- `probePythonVersion.test.ts`
- `findEntryPoints.test.ts`
- `detectFrameworks.test.ts`
- `detectPythonPort.test.ts`
- `detectPipProxy.test.ts`
- `buildPythonCommand.test.ts`
- `PythonAdapter.detect.test.ts`
- `PythonAdapter.build.test.ts`

**Modified files:**
- `src/shared/types.ts` — extend `RunConfigType` and add `PythonTypeOptions`, `PythonLaunchMode`, `PythonFramework`, plus the discriminated-union arm.
- `src/shared/schema.ts` — add `PythonTypeOptionsSchema`, extend `RunConfigSchema` discriminated union.
- `src/ui/EditorPanel.ts` — add Python's `nodes`/equivalent context shape to `sanitizeConfig` (defaulting all string fields to `''`).
- `src/extension.ts` — register `new PythonAdapter()`, add `'typeOptions.pythonPath'` and other Python pending fields to `STREAMING_PENDING_FIELDS`.
- `src/ui/RunConfigTreeProvider.ts` — `case 'python'` for label and brand icon.
- `src/ui/iconForConfig.ts` — `case 'python': return 'python'`.
- `media/icons/python.svg` and `media/icons/python-light.svg` — new icon assets.
- `package.json` — register the new config type in the contributes list (if there's an enum there for type pickers — verify by running `grep` first).

## Conventions

- **No commits.** Each task ends with verification only.
- Follow the existing Java adapter as the reference implementation when uncertain about file shape.
- Tests use the project's existing patterns: Jest, `jest.mock('child_process')` for spawn-mocked tests, `fs.promises` overrides for filesystem-mocked tests.

---

## Task 1: Schema and types

**Files:**
- Modify: `src/shared/types.ts:1-11` (extend `RunConfigType` union)
- Modify: `src/shared/types.ts` (add interfaces, extend `RunConfig` union)
- Modify: `src/shared/schema.ts` (add `PythonTypeOptionsSchema`, extend `RunConfigSchema`)

- [ ] **Step 1: Extend `RunConfigType`**

In `src/shared/types.ts`, change:

```ts
export type RunConfigType =
  | 'npm'
  | 'spring-boot'
  | 'tomcat'
  | 'quarkus'
  | 'java'
  | 'maven-goal'
  | 'gradle-task'
  | 'custom-command'
  | 'docker'
  | 'http-request';
```

to:

```ts
export type RunConfigType =
  | 'npm'
  | 'spring-boot'
  | 'tomcat'
  | 'quarkus'
  | 'java'
  | 'python'
  | 'maven-goal'
  | 'gradle-task'
  | 'custom-command'
  | 'docker'
  | 'http-request';
```

- [ ] **Step 2: Add Python types**

Insert immediately after the existing `JavaTypeOptions` block in `src/shared/types.ts`:

```ts
// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

// Five launch modes. The form changes shape based on this — see the
// PythonAdapter form schema for the per-mode field list.
//   script    — run a .py file: `python path/to/script.py [args]`
//   module    — run a package via -m: `python -m mypkg.cli [args]`
//   framework — run a detected framework (django/uvicorn/flask/...)
//   pytest    — run pytest with free-form selection args
//   custom    — free-form args appended to the interpreter
export type PythonLaunchMode = 'script' | 'module' | 'framework' | 'pytest' | 'custom';

// Frameworks v1 detects. Empty string when no framework is selected.
export type PythonFramework =
  | ''
  | 'django'
  | 'fastapi'
  | 'flask'
  | 'uvicorn'
  | 'gunicorn'
  | 'celery'
  | 'typer'
  | 'starlette'
  | 'click';

export interface PythonTypeOptions {
  launchMode: PythonLaunchMode;
  // Absolute path to a Python install directory (containing bin/python on
  // POSIX, or python.exe on Windows). Empty string means "use whatever
  // python3 / python is on PATH at launch time."
  pythonPath: string;
  // Used when launchMode === 'script'. Path relative to projectPath.
  scriptPath: string;
  // Used when launchMode === 'module'. Dotted module name, e.g. 'mypkg.cli'.
  moduleName: string;
  // Used when launchMode === 'framework'.
  framework: PythonFramework;
  // Used when launchMode === 'framework'. Argument string passed to the
  // framework's invocation (`runserver`, `app:main --reload`, etc.).
  frameworkCommand: string;
  // Used when launchMode === 'pytest'. Free-form argument string.
  pytestArgs: string;
  // Used when launchMode === 'custom'. Free-form argument string appended
  // verbatim to the interpreter command.
  customArgs: string;
  // Optional override of the project root (defaults to projectPath).
  buildRoot: string;
}
```

- [ ] **Step 3: Extend the `RunConfig` discriminated union**

In `src/shared/types.ts`, find the `export type RunConfig =` union (search for `type: 'java'`). Add the Python arm immediately after the `java` arm:

```ts
  | (RunConfigBase & { type: 'python'; typeOptions: PythonTypeOptions })
```

- [ ] **Step 4: Add the Zod schema**

In `src/shared/schema.ts`, add immediately after the `JavaTypeOptionsSchema` block:

```ts
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

- [ ] **Step 5: Extend the discriminated `RunConfigSchema`**

In `src/shared/schema.ts`, find `export const RunConfigSchema = z.discriminatedUnion('type', [` (around line 356). Add the Python arm immediately after the `java` arm (around line 381):

```ts
  z.object({
    ...commonFields,
    type: z.literal('python'),
    typeOptions: PythonTypeOptionsSchema,
  }),
```

- [ ] **Step 6: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -5`
Expected: typecheck errors will appear because `EditorPanel.sanitizeConfig`, `extension.ts`, `iconForConfig.ts`, `RunConfigTreeProvider.ts`, etc. have not been extended yet. Note them — they'll resolve in later tasks.

For now, verify the schema/types files themselves typecheck cleanly:

```bash
cd /git/run-config-manager && npx tsc --noEmit src/shared/types.ts src/shared/schema.ts 2>&1 | head -20
```

(This isolates the two files. The full `npm run typecheck` will be green only after Tasks 11+12.)

- [ ] **Step 7: Run schema-existing tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern schema 2>&1 | tail -10`
Expected: existing schema tests pass; the Python addition is purely additive to the discriminated union.

DO NOT COMMIT.

---

## Task 2: detectPythons — interpreter discovery

**Files:**
- Create: `src/adapters/python/detectPythons.ts`
- Create: `test/detectPythons.test.ts`

- [ ] **Step 1: Write the parse tests**

Create `test/detectPythons.test.ts`:

```ts
import { detectPythons } from '../src/adapters/python/detectPythons';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    // Default: empty output (no `which python` hits) so detection falls
    // back to filesystem scans the test mocks directly.
    const ee = new (require('events').EventEmitter)();
    ee.stdout = new (require('events').EventEmitter)();
    ee.stderr = new (require('events').EventEmitter)();
    setImmediate(() => ee.emit('close', 1));
    return ee;
  }),
}));

describe('detectPythons (filesystem mocks)', () => {
  let realReaddir: typeof fs.promises.readdir;
  let realStat: typeof fs.promises.stat;
  let realRealpath: typeof fs.promises.realpath;
  let savedVirtualEnv: string | undefined;

  beforeEach(() => {
    realReaddir = fs.promises.readdir;
    realStat = fs.promises.stat;
    realRealpath = fs.promises.realpath;
    savedVirtualEnv = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
  });

  afterEach(() => {
    (fs.promises as any).readdir = realReaddir;
    (fs.promises as any).stat = realStat;
    (fs.promises as any).realpath = realRealpath;
    if (savedVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
    else process.env.VIRTUAL_ENV = savedVirtualEnv;
  });

  test('picks up project-local .venv', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    (fs.promises as any).readdir = jest.fn(async () => []);
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p === path.join('/proj/sample', '.venv', 'bin', 'python')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result).toContain(path.join('/proj/sample', '.venv'));
  });

  test('scans pyenv versions and dedupes by realpath', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    const home = os.homedir();
    const pyenvDir = path.join(home, '.pyenv', 'versions');

    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === pyenvDir) {
        return [
          { name: '3.12.1', isDirectory: () => true, isSymbolicLink: () => false },
          { name: '3.11.7', isDirectory: () => true, isSymbolicLink: () => false },
        ];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p.endsWith(path.join('bin', 'python')) || p.endsWith(path.join('bin', 'python3')) || p.endsWith('python.exe')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result).toEqual(expect.arrayContaining([
      path.join(pyenvDir, '3.12.1'),
      path.join(pyenvDir, '3.11.7'),
    ]));
  });

  test('respects VIRTUAL_ENV when set', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    process.env.VIRTUAL_ENV = '/some/active/venv';

    (fs.promises as any).readdir = jest.fn(async () => []);
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p === path.join('/some/active/venv', 'bin', 'python')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result).toContain('/some/active/venv');
  });

  test('drops paths that lack a python binary', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    const home = os.homedir();
    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === path.join(home, '.pyenv', 'versions')) {
        return [{ name: '3.12.1', isDirectory: () => true, isSymbolicLink: () => false }];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result.filter(p => p.includes('.pyenv'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests; expect failure (file doesn't exist yet)**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectPythons 2>&1 | tail -10`
Expected: import error (`Cannot find module ../src/adapters/python/detectPythons`).

- [ ] **Step 3: Implement `detectPythons.ts`**

Create `src/adapters/python/detectPythons.ts`:

```ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

export interface PythonInfo {
  // Absolute path to the install directory containing bin/python (POSIX)
  // or python.exe (Windows). Mirrors NodeInfo / JdkInfo.
  path: string;
  // Filled in by probePythonVersion; absent at first emit.
  version?: string;
}

// Returns Python install directories found on this machine. Each entry is
// guaranteed to have a usable python binary. Versions are NOT populated
// here — call probePythonVersion(path) separately, in parallel.
//
// Detection sources, in priority order (project-local venvs win the
// default-selection race in the streaming probe):
//   1. Project-local venvs (.venv / venv / env)
//   2. $VIRTUAL_ENV
//   3. `which python3` / `which python` resolved through symlinks
//   4. Version managers (pyenv, asdf, rye, uv, mise, conda)
//   5. Fixed roots (Linux, macOS framework paths, Windows)
export async function detectPythons(projectUri: vscode.Uri): Promise<string[]> {
  const found: string[] = [];

  // 1. Project-local venvs.
  for (const sub of ['.venv', 'venv', 'env']) {
    found.push(path.join(projectUri.fsPath, sub));
  }

  // 2. VIRTUAL_ENV.
  if (process.env.VIRTUAL_ENV) found.push(process.env.VIRTUAL_ENV);

  // 3. which python.
  for (const p of await whichPython()) found.push(p);

  // 4. Version managers.
  for (const p of await scanVersionManagerDirs()) found.push(p);

  // 5. Fixed roots.
  for (const p of await scanFixedRoots()) found.push(p);

  const out = await dedupeRealPythons(found);
  log.debug(`detectPythons: found ${out.length} unique Python install(s)`);
  return out;
}

// Spawn-and-collect with a hard timeout. Used by whichPython.
function runCommand(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(command, args, { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
  });
}

async function whichPython(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const homes: string[] = [];
  for (const probe of ['python3', 'python']) {
    try {
      const out = await runCommand(cmd, [probe], 1500);
      if (!out) continue;
      const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const bin of lines) {
        let real: string;
        try { real = await fs.promises.realpath(bin); }
        catch { real = bin; }
        const home = pythonHomeFromBin(real);
        if (home) homes.push(home);
      }
    } catch (e) {
      log.debug(`whichPython(${probe}) failed: ${(e as Error).message}`);
    }
  }
  return homes;
}

async function scanVersionManagerDirs(): Promise<string[]> {
  const home = os.homedir();
  const out: string[] = [];

  // pyenv: ~/.pyenv/versions/<v>
  for (const p of await listChildDirs(path.join(home, '.pyenv', 'versions'))) out.push(p);

  // asdf: ~/.asdf/installs/python/<v>
  for (const p of await listChildDirs(path.join(home, '.asdf', 'installs', 'python'))) out.push(p);

  // rye: ~/.rye/py/<v>/install AND ~/.local/share/rye/py/<v>/install
  for (const v of await listChildDirs(path.join(home, '.rye', 'py'))) {
    out.push(path.join(v, 'install'));
  }
  for (const v of await listChildDirs(path.join(home, '.local', 'share', 'rye', 'py'))) {
    out.push(path.join(v, 'install'));
  }

  // uv: ~/.local/share/uv/python/<v>
  for (const p of await listChildDirs(path.join(home, '.local', 'share', 'uv', 'python'))) {
    out.push(p);
  }

  // mise: ~/.local/share/mise/installs/python/<v>
  for (const p of await listChildDirs(path.join(home, '.local', 'share', 'mise', 'installs', 'python'))) {
    out.push(p);
  }

  // conda envs.
  for (const root of [
    path.join(home, '.conda', 'envs'),
    path.join(home, 'miniconda3', 'envs'),
    path.join(home, 'anaconda3', 'envs'),
  ]) {
    for (const p of await listChildDirs(root)) out.push(p);
  }

  return out;
}

async function scanFixedRoots(): Promise<string[]> {
  const out: string[] = [];
  // POSIX system locations — push the install DIR, not the bin path.
  // /usr is the dir containing bin/python3, /usr/local same.
  out.push('/usr', '/usr/local');

  // Homebrew (macOS)
  for (const p of await listChildDirs('/opt/homebrew/opt')) {
    if (path.basename(p).toLowerCase().startsWith('python')) {
      // The dir containing bin/python3.
      out.push(p);
    }
  }
  for (const p of await listChildDirs('/usr/local/opt')) {
    if (path.basename(p).toLowerCase().startsWith('python')) out.push(p);
  }

  // macOS Frameworks: /Library/Frameworks/Python.framework/Versions/<v>/
  for (const p of await listChildDirs('/Library/Frameworks/Python.framework/Versions')) {
    out.push(p);
  }

  // Windows.
  for (const root of [
    'C:\\Python', // Python313/, etc — handled via prefix scan below
  ]) void root;
  for (const root of [
    'C:\\',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ]) {
    for (const p of await listChildDirs(root)) {
      const base = path.basename(p).toLowerCase();
      if (base.startsWith('python')) out.push(p);
    }
  }
  // Windows per-user installs.
  if (process.env.LOCALAPPDATA) {
    for (const p of await listChildDirs(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'))) {
      out.push(p);
    }
  }

  return out;
}

async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Walk upward from a python binary path to its install home. POSIX:
// `<home>/bin/python` → `<home>`. Windows: `<home>/python.exe` → `<home>`.
function pythonHomeFromBin(pythonBin: string): string | null {
  const dir = path.dirname(pythonBin);
  if (process.platform === 'win32') {
    const base = path.basename(pythonBin).toLowerCase();
    if (base === 'python.exe' || base === 'python3.exe') return dir;
    return null;
  }
  if (path.basename(dir).toLowerCase() === 'bin') return path.dirname(dir);
  return null;
}

async function dedupeRealPythons(paths: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    // Validate: must have at least one python binary.
    const candidates = process.platform === 'win32'
      ? [path.join(p, 'python.exe'), path.join(p, 'python3.exe')]
      : [path.join(p, 'bin', 'python'), path.join(p, 'bin', 'python3')];
    let exists = false;
    for (const c of candidates) {
      try {
        const stat = await fs.promises.stat(c);
        if (stat.isFile()) { exists = true; break; }
      } catch { /* nope */ }
    }
    if (!exists) continue;

    let real: string;
    try { real = await fs.promises.realpath(p); }
    catch { real = p; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectPythons 2>&1 | tail -10`
Expected: 4 tests pass.

- [ ] **Step 5: Verify typecheck**

Run: `cd /git/run-config-manager && npx tsc --noEmit src/adapters/python/detectPythons.ts 2>&1 | tail -10`
Expected: zero errors (the file imports `vscode` so the project's full TypeScript config is needed — running `npx tsc` on a single file might warn about modules; that's fine for spot-checking. The full `npm run typecheck` runs in Task 11.)

DO NOT COMMIT.

---

## Task 3: probePythonVersion — version probe

**Files:**
- Create: `src/adapters/python/probePythonVersion.ts`
- Create: `test/probePythonVersion.test.ts`

- [ ] **Step 1: Write the tests**

Create `test/probePythonVersion.test.ts`:

```ts
import { parsePythonVersion } from '../src/adapters/python/probePythonVersion';

describe('parsePythonVersion', () => {
  test('strips Python prefix', () => {
    expect(parsePythonVersion('Python 3.12.1\n')).toBe('3.12.1');
  });
  test('handles trailing whitespace', () => {
    expect(parsePythonVersion('  Python 3.11.7  ')).toBe('3.11.7');
  });
  test('returns undefined for non-version output', () => {
    expect(parsePythonVersion('')).toBeUndefined();
    expect(parsePythonVersion('hello world')).toBeUndefined();
  });
  test('handles version with patch and prerelease', () => {
    expect(parsePythonVersion('Python 3.13.0a3')).toBe('3.13.0a3');
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern probePythonVersion 2>&1 | tail -10`
Expected: import error.

- [ ] **Step 3: Implement**

Create `src/adapters/python/probePythonVersion.ts`:

```ts
import * as path from 'path';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

export async function probePythonVersion(pythonHome: string): Promise<{ version?: string }> {
  try {
    const bin = pythonBinPath(pythonHome);
    const out = await runOnce(bin, ['--version'], 2000);
    if (!out) return {};
    const v = parsePythonVersion(out);
    return v ? { version: v } : {};
  } catch (e) {
    log.debug(`probePythonVersion(${pythonHome}) failed: ${(e as Error).message}`);
    return {};
  }
}

// Python --version output has been stable for years: `Python 3.12.1`.
// Pre-3.4 it wrote to stderr; 3.4+ writes to stdout. We capture both.
export function parsePythonVersion(text: string): string | undefined {
  const m = text.match(/Python\s+(\d+\.\d+\.\d+(?:[a-z]\d+)?)/);
  return m ? m[1] : undefined;
}

function pythonBinPath(home: string): string {
  if (process.platform === 'win32') return path.join(home, 'python.exe');
  return path.join(home, 'bin', 'python3');
}

function runOnce(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(command, args, { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern probePythonVersion 2>&1 | tail -10`
Expected: 4 tests pass.

DO NOT COMMIT.

---

## Task 4: probePythonsStreaming — two-phase emit

**Files:**
- Create: `src/adapters/python/probePythonsStreaming.ts`

This module is a near-copy of `src/adapters/spring-boot/probeJdksStreaming.ts` with `Python` substituted for `Jdk`. It has no new tests of its own — its behavior is exercised by the adapter integration tests (Task 9).

- [ ] **Step 1: Implement**

Create `src/adapters/python/probePythonsStreaming.ts`:

```ts
import * as vscode from 'vscode';
import type { StreamingPatch } from '../RuntimeAdapter';
import { detectPythons, type PythonInfo } from './detectPythons';
import { probePythonVersion } from './probePythonVersion';
import { log } from '../../utils/logger';

// Two-phase Python detection used by PythonAdapter.detectStreaming.
// Mirrors probeJdksStreaming / probeNodesStreaming.
// Two emits:
//   1. After detectPythons(): contextPatch = { pythons: PythonInfo[] }
//      with paths only. Default seeded to first path. `resolved` omitted
//      so the field's spinner stays up while versions stream in.
//   2. After version probes settle: contextPatch with enriched PythonInfo[];
//      resolved = ['typeOptions.pythonPath'] to clear the spinner.
export async function probePythonsStreaming(
  projectUri: vscode.Uri,
  emit: (p: StreamingPatch) => void,
  defaultsPatchKey: string,
): Promise<void> {
  const paths = await detectPythons(projectUri);
  log.debug(`probePythonsStreaming: detected ${paths.length} Python path(s)`);

  const initial: PythonInfo[] = paths.map(p => ({ path: p }));
  emit({
    contextPatch: { pythons: initial },
    ...(paths[0]
      ? { defaultsPatch: buildDefaultsPatch(defaultsPatchKey, paths[0]) }
      : {}),
  });

  if (paths.length === 0) {
    emit({ contextPatch: {}, resolved: ['typeOptions.pythonPath'] });
    return;
  }

  const enriched: PythonInfo[] = await Promise.all(
    paths.map(async p => {
      try {
        const info = await probePythonVersion(p);
        return { path: p, ...info };
      } catch { return { path: p }; }
    }),
  );
  log.debug(
    `probePythonsStreaming: enriched ${enriched.filter(p => p.version).length}/` +
    `${enriched.length} with version info`,
  );
  emit({
    contextPatch: { pythons: enriched },
    resolved: ['typeOptions.pythonPath'],
  });
}

function buildDefaultsPatch(key: string, pythonPath: string) {
  log.debug(`probePythonsStreaming: defaulting ${key}.typeOptions.pythonPath to ${pythonPath}`);
  return { typeOptions: { pythonPath } } as any;
}

export function readPythons(value: unknown): PythonInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => {
    if (typeof v === 'string') return { path: v };
    if (v && typeof v === 'object' && typeof (v as PythonInfo).path === 'string') {
      return v as PythonInfo;
    }
    return null;
  }).filter((v): v is PythonInfo => v !== null);
}

export function pythonOption(p: PythonInfo): { value: string; label: string } {
  let label = p.path;
  if (p.version) label = `${p.path} — Python ${p.version}`;
  return { value: p.path, label };
}
```

DO NOT COMMIT.

---

## Task 5: findEntryPoints — script + module discovery

**Files:**
- Create: `src/adapters/python/findEntryPoints.ts`
- Create: `test/findEntryPoints.test.ts`

- [ ] **Step 1: Write tests**

Create `test/findEntryPoints.test.ts`:

```ts
import { isMainGuardLine, splitDottedFromPath } from '../src/adapters/python/findEntryPoints';

describe('isMainGuardLine', () => {
  test('matches the canonical __main__ guard', () => {
    expect(isMainGuardLine('if __name__ == "__main__":')).toBe(true);
    expect(isMainGuardLine("if __name__ == '__main__':")).toBe(true);
  });
  test('matches with leading whitespace', () => {
    expect(isMainGuardLine('    if __name__ == "__main__":')).toBe(true);
  });
  test('does not match other lines', () => {
    expect(isMainGuardLine('print("__main__")')).toBe(false);
    expect(isMainGuardLine('# if __name__ == "__main__":')).toBe(false);
    expect(isMainGuardLine('')).toBe(false);
  });
});

describe('splitDottedFromPath', () => {
  test('converts a relative file path under projectPath into a dotted module name', () => {
    expect(splitDottedFromPath('src/mypkg/cli.py', 'src')).toBe('mypkg.cli');
    expect(splitDottedFromPath('mypkg/sub/cli.py', '')).toBe('mypkg.sub.cli');
  });
  test('handles __main__.py specially (returns the package name)', () => {
    expect(splitDottedFromPath('mypkg/__main__.py', '')).toBe('mypkg');
    expect(splitDottedFromPath('src/mypkg/__main__.py', 'src')).toBe('mypkg');
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern findEntryPoints 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/adapters/python/findEntryPoints.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../../utils/logger';

export interface ScriptEntryPoint {
  // Path relative to the project root, with forward slashes.
  relativePath: string;
}

export interface ModuleEntryPoint {
  // Dotted module name (e.g. 'mypkg.cli').
  dotted: string;
}

// Walks the project for scripts containing `if __name__ == "__main__":` and
// modules with a `__main__.py`. Skips conventional non-source folders so
// large projects don't take seconds to scan.
//
// Returns at most 50 of each — covers every realistic project size and
// caps the cost on monorepos.
export async function findEntryPoints(projectUri: vscode.Uri): Promise<{
  scripts: ScriptEntryPoint[];
  modules: ModuleEntryPoint[];
}> {
  const root = projectUri.fsPath;
  const scripts: ScriptEntryPoint[] = [];
  const modules: ModuleEntryPoint[] = [];
  const skipDirs = new Set([
    '.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.tox',
    '.nox', '.eggs', 'site-packages',
  ]);

  // Try common source-prefix dirs in order of likelihood.
  const candidatePrefixes = await detectSourcePrefix(root);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return; // bound the recursion
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (scripts.length >= 50 && modules.length >= 50) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.py')) continue;

      // __main__.py → module entry.
      if (entry.name === '__main__.py') {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const prefix = matchPrefix(rel, candidatePrefixes);
        const dotted = splitDottedFromPath(rel, prefix);
        if (dotted && modules.length < 50) modules.push({ dotted });
        continue;
      }

      // Otherwise check for the __main__ guard.
      try {
        const text = await fs.promises.readFile(full, 'utf8');
        if (text.split('\n').some(isMainGuardLine)) {
          if (scripts.length < 50) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            scripts.push({ relativePath: rel });
          }
        }
      } catch (e) {
        log.debug(`findEntryPoints: read ${full} failed: ${(e as Error).message}`);
      }
    }
  }

  await walk(root, 0);
  return { scripts, modules };
}

// Matches `if __name__ == "__main__":` (single or double quotes, optional
// leading whitespace, no comments, no other content on the line).
export function isMainGuardLine(line: string): boolean {
  return /^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:\s*$/.test(line);
}

// Convert a relative path like "src/mypkg/cli.py" into a dotted module
// name "mypkg.cli", honoring an optional source-prefix dir (e.g. "src").
// `__main__.py` collapses to the parent package name.
export function splitDottedFromPath(relativePath: string, sourcePrefix: string): string {
  let rel = relativePath.replace(/\\/g, '/');
  if (sourcePrefix && rel.startsWith(sourcePrefix + '/')) {
    rel = rel.slice(sourcePrefix.length + 1);
  }
  if (rel.endsWith('/__main__.py')) rel = rel.slice(0, -'/__main__.py'.length);
  else if (rel.endsWith('.py')) rel = rel.slice(0, -3);
  else return '';
  return rel.split('/').filter(Boolean).join('.');
}

async function detectSourcePrefix(root: string): Promise<string[]> {
  // Prefer common source-prefix dirs if they exist.
  const candidates = ['src'];
  const out: string[] = [];
  for (const c of candidates) {
    try {
      const stat = await fs.promises.stat(path.join(root, c));
      if (stat.isDirectory()) out.push(c);
    } catch { /* not present */ }
  }
  out.push(''); // also try root-as-prefix.
  return out;
}

function matchPrefix(rel: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (!p) continue;
    if (rel.startsWith(p + '/')) return p;
  }
  return '';
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern findEntryPoints 2>&1 | tail -10`
Expected: 5 tests pass (3 isMainGuard + 2 splitDotted).

DO NOT COMMIT.

---

## Task 6: detectFrameworks — pyproject / requirements parsing

**Files:**
- Create: `src/adapters/python/detectFrameworks.ts`
- Create: `test/detectFrameworks.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/detectFrameworks.test.ts`:

```ts
import {
  parsePyprojectDependencies,
  parseRequirementsTxt,
  parsePoetryDependencies,
  knownFrameworksFromPackages,
} from '../src/adapters/python/detectFrameworks';

describe('parsePyprojectDependencies (PEP 621)', () => {
  test('extracts dependencies array', () => {
    const toml = `
[project]
name = "x"
dependencies = [
  "django>=4.2",
  "requests",
  "fastapi>=0.100",
]
`;
    const out = parsePyprojectDependencies(toml);
    expect(out).toEqual(expect.arrayContaining(['django', 'requests', 'fastapi']));
  });
  test('returns [] when [project] section absent', () => {
    expect(parsePyprojectDependencies('# empty')).toEqual([]);
  });
  test('strips version specifiers and extras', () => {
    const toml = `[project]
dependencies = ["uvicorn[standard]>=0.27", "celery[redis]==5.3.0"]`;
    const out = parsePyprojectDependencies(toml);
    expect(out).toEqual(expect.arrayContaining(['uvicorn', 'celery']));
  });
});

describe('parsePoetryDependencies', () => {
  test('extracts [tool.poetry.dependencies] keys', () => {
    const toml = `
[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
gunicorn = "21.2.0"
`;
    const out = parsePoetryDependencies(toml);
    expect(out).toEqual(expect.arrayContaining(['flask', 'gunicorn']));
    expect(out).not.toContain('python'); // ignored
  });
});

describe('parseRequirementsTxt', () => {
  test('strips version pins, extras, comments, blank lines', () => {
    const text = `
django>=4.2.0  # web framework
fastapi[standard]==0.105.0
celery
# comment line
-r other.txt
`;
    expect(parseRequirementsTxt(text)).toEqual(
      expect.arrayContaining(['django', 'fastapi', 'celery']),
    );
  });
  test('handles pip URL hashes', () => {
    const text = `numpy==1.26.0 \\\n  --hash=sha256:abc`;
    expect(parseRequirementsTxt(text)).toEqual(['numpy']);
  });
});

describe('knownFrameworksFromPackages', () => {
  test('maps known package names to PythonFramework values', () => {
    expect(knownFrameworksFromPackages(['django', 'requests'])).toEqual(['django']);
    expect(knownFrameworksFromPackages(['fastapi', 'uvicorn'])).toEqual(
      expect.arrayContaining(['fastapi', 'uvicorn']),
    );
  });
  test('ignores unknown packages', () => {
    expect(knownFrameworksFromPackages(['numpy', 'pytz'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectFrameworks 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/adapters/python/detectFrameworks.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PythonFramework } from '../../shared/types';
import { log } from '../../utils/logger';

export interface FrameworkHit {
  name: PythonFramework;
  source: string; // relative path of the file the dependency was found in
}

// pyproject is parsed with a tiny line-oriented scanner — we don't pull
// in a real TOML parser. The relevant subset (dependencies arrays and
// [tool.poetry.dependencies] tables) is well-bounded and easy to read
// off without a lexer.
export async function detectFrameworks(projectUri: vscode.Uri): Promise<FrameworkHit[]> {
  const root = projectUri.fsPath;
  const seen = new Map<PythonFramework, string>();

  // 1. pyproject.toml — both PEP 621 and poetry sections.
  const pyproject = await readFile(path.join(root, 'pyproject.toml'));
  if (pyproject) {
    const pep621 = knownFrameworksFromPackages(parsePyprojectDependencies(pyproject));
    for (const f of pep621) if (!seen.has(f)) seen.set(f, 'pyproject.toml');
    const poetry = knownFrameworksFromPackages(parsePoetryDependencies(pyproject));
    for (const f of poetry) if (!seen.has(f)) seen.set(f, 'pyproject.toml');
  }

  // 2. requirements*.txt files.
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { entries = []; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/^requirements.*\.txt$/i.test(e.name)) continue;
    const text = await readFile(path.join(root, e.name));
    if (!text) continue;
    const hits = knownFrameworksFromPackages(parseRequirementsTxt(text));
    for (const f of hits) if (!seen.has(f)) seen.set(f, e.name);
  }

  // 3. setup.cfg.
  const setupCfg = await readFile(path.join(root, 'setup.cfg'));
  if (setupCfg) {
    const hits = knownFrameworksFromPackages(parseSetupCfgInstallRequires(setupCfg));
    for (const f of hits) if (!seen.has(f)) seen.set(f, 'setup.cfg');
  }

  return [...seen].map(([name, source]) => ({ name, source }));
}

// PEP 621: [project] dependencies = ["foo", "bar>=1.0", ...]
export function parsePyprojectDependencies(toml: string): string[] {
  const projectSection = sliceSection(toml, '[project]');
  if (!projectSection) return [];
  const dependenciesIdx = projectSection.indexOf('dependencies');
  if (dependenciesIdx < 0) return [];
  const arrayStart = projectSection.indexOf('[', dependenciesIdx);
  const arrayEnd = projectSection.indexOf(']', arrayStart);
  if (arrayStart < 0 || arrayEnd < 0) return [];
  const body = projectSection.slice(arrayStart + 1, arrayEnd);
  return body
    .split(/[,\n]/)
    .map(s => s.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(s => s.replace(/^["']|["']$/g, ''))
    .map(stripVersionAndExtras)
    .filter(Boolean);
}

// Poetry: [tool.poetry.dependencies] foo = "..."  (table of key=value).
export function parsePoetryDependencies(toml: string): string[] {
  const section = sliceSection(toml, '[tool.poetry.dependencies]');
  if (!section) return [];
  const out: string[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === 'python' || !key) continue;
    out.push(key);
  }
  return out;
}

// requirements.txt — strip version pins, extras, comments, hash markers.
export function parseRequirementsTxt(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-')) continue; // -r, -e, etc.
    // Drop continuation backslashes.
    line = line.replace(/\s*\\\s*$/, '');
    const pkg = stripVersionAndExtras(line);
    if (pkg) out.push(pkg);
  }
  return out;
}

// setup.cfg [options] install_requires = django\n  fastapi
export function parseSetupCfgInstallRequires(cfg: string): string[] {
  const section = sliceSection(cfg, '[options]');
  if (!section) return [];
  const idx = section.indexOf('install_requires');
  if (idx < 0) return [];
  const body = section.slice(idx).split('\n').slice(1)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('['));
  const items: string[] = [];
  for (const l of body) {
    if (l.includes('=')) break; // hit the next key
    items.push(stripVersionAndExtras(l));
  }
  return items.filter(Boolean);
}

const KNOWN_FRAMEWORKS: Record<string, PythonFramework> = {
  django: 'django',
  fastapi: 'fastapi',
  flask: 'flask',
  uvicorn: 'uvicorn',
  gunicorn: 'gunicorn',
  celery: 'celery',
  typer: 'typer',
  starlette: 'starlette',
  click: 'click',
};

export function knownFrameworksFromPackages(packages: string[]): PythonFramework[] {
  const out: PythonFramework[] = [];
  const seen = new Set<PythonFramework>();
  for (const p of packages) {
    const normalized = p.toLowerCase().replace(/_/g, '-');
    const fw = KNOWN_FRAMEWORKS[normalized];
    if (fw && !seen.has(fw)) { seen.add(fw); out.push(fw); }
  }
  return out;
}

function stripVersionAndExtras(s: string): string {
  // Strip [extras], version specifiers (>=, ==, ~, <), and trailing whitespace.
  return s.replace(/\[.*?\]/, '').replace(/[<>=!~].*$/, '').trim();
}

function sliceSection(toml: string, header: string): string | null {
  const start = toml.indexOf(header);
  if (start < 0) return null;
  const after = toml.indexOf('\n', start) + 1;
  const next = toml.slice(after).search(/^\[/m);
  return next < 0 ? toml.slice(after) : toml.slice(after, after + next);
}

async function readFile(p: string): Promise<string | null> {
  try { return await fs.promises.readFile(p, 'utf8'); }
  catch (e) {
    log.debug(`detectFrameworks: read ${p} failed: ${(e as Error).message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectFrameworks 2>&1 | tail -10`
Expected: 8 tests pass.

DO NOT COMMIT.

---

## Task 7: detectPythonPort + frameworkCommands

**Files:**
- Create: `src/adapters/python/frameworkCommands.ts`
- Create: `src/adapters/python/detectPythonPort.ts`
- Create: `test/detectPythonPort.test.ts`

- [ ] **Step 1: Implement `frameworkCommands.ts`**

Create `src/adapters/python/frameworkCommands.ts`:

```ts
import type { PythonFramework } from '../../shared/types';

export interface FrameworkCommandSpec {
  // Default port (null when not a server framework).
  defaultPort: number | null;
  // Suggested commands shown in the framework-command dropdown when this
  // framework is selected. The first entry is the default.
  commands: string[];
}

export const FRAMEWORK_COMMANDS: Record<PythonFramework, FrameworkCommandSpec> = {
  '': { defaultPort: null, commands: [] },
  django: {
    defaultPort: 8000,
    commands: [
      'runserver',
      'runserver 0.0.0.0:8000',
      'migrate',
      'makemigrations',
      'shell',
      'createsuperuser',
      'test',
      'collectstatic',
    ],
  },
  fastapi: {
    defaultPort: 8000,
    commands: ['app:main --reload'],
  },
  flask: {
    defaultPort: 5000,
    commands: ['--app app run', '--app app run --debug'],
  },
  uvicorn: {
    defaultPort: 8000,
    commands: ['app:main', 'app:main --reload'],
  },
  gunicorn: {
    defaultPort: 8000,
    commands: ['app:app -b 0.0.0.0:8000', 'app:app -w 4 -b 0.0.0.0:8000'],
  },
  celery: {
    defaultPort: null,
    commands: ['-A celery_app worker --loglevel=info', '-A celery_app beat'],
  },
  typer: { defaultPort: null, commands: [] },
  starlette: { defaultPort: 8000, commands: ['app:main'] },
  click: { defaultPort: null, commands: [] },
};
```

- [ ] **Step 2: Write the port-detect tests**

Create `test/detectPythonPort.test.ts`:

```ts
import { parseProcfilePort, defaultPortForFramework } from '../src/adapters/python/detectPythonPort';

describe('parseProcfilePort', () => {
  test('extracts --port from a uvicorn line', () => {
    expect(parseProcfilePort('web: uvicorn app:main --port 9000')).toBe(9000);
  });
  test('extracts -p from a flask line', () => {
    expect(parseProcfilePort('web: flask run -p 7000')).toBe(7000);
  });
  test('extracts port from gunicorn -b 0.0.0.0:N', () => {
    expect(parseProcfilePort('web: gunicorn app:app -b 0.0.0.0:8500')).toBe(8500);
  });
  test('returns undefined when no port is present', () => {
    expect(parseProcfilePort('web: celery worker')).toBeUndefined();
    expect(parseProcfilePort('')).toBeUndefined();
  });
});

describe('defaultPortForFramework', () => {
  test('django defaults to 8000', () => {
    expect(defaultPortForFramework('django')).toBe(8000);
  });
  test('flask defaults to 5000', () => {
    expect(defaultPortForFramework('flask')).toBe(5000);
  });
  test('celery has no port', () => {
    expect(defaultPortForFramework('celery')).toBeUndefined();
  });
  test('empty framework has no port', () => {
    expect(defaultPortForFramework('')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectPythonPort 2>&1 | tail -10`

- [ ] **Step 4: Implement `detectPythonPort.ts`**

Create `src/adapters/python/detectPythonPort.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PythonFramework } from '../../shared/types';
import { FRAMEWORK_COMMANDS } from './frameworkCommands';
import { log } from '../../utils/logger';

// Best-effort port detection. Order, first hit wins:
//   1. Procfile parsing.
//   2. Framework convention default.
// Returns undefined when no port can be determined.
export async function detectPythonPort(
  projectUri: vscode.Uri,
  framework: PythonFramework,
): Promise<number | undefined> {
  const root = projectUri.fsPath;

  // 1. Procfile.
  try {
    const text = await fs.promises.readFile(path.join(root, 'Procfile'), 'utf8');
    for (const line of text.split('\n')) {
      const port = parseProcfilePort(line);
      if (port !== undefined) return port;
    }
  } catch (e) {
    log.debug(`detectPythonPort: no Procfile or unreadable: ${(e as Error).message}`);
  }

  // 2. Framework default.
  return defaultPortForFramework(framework);
}

// Parses a Procfile line for an explicit port. Recognises:
//   --port <n>, -p <n>, :<n> (in -b host:port style bind args).
// Returns undefined when no port appears in the line.
export function parseProcfilePort(line: string): number | undefined {
  const portFlag = line.match(/(?:--port|-p)\s+(\d+)/);
  if (portFlag) return Number(portFlag[1]);
  const bindFlag = line.match(/[:](\d{2,5})\b/);
  if (bindFlag) return Number(bindFlag[1]);
  return undefined;
}

export function defaultPortForFramework(framework: PythonFramework): number | undefined {
  const spec = FRAMEWORK_COMMANDS[framework];
  return spec?.defaultPort ?? undefined;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectPythonPort 2>&1 | tail -10`
Expected: 8 tests pass.

DO NOT COMMIT.

---

## Task 8: detectPipProxy

**Files:**
- Create: `src/adapters/python/detectPipProxy.ts`
- Create: `test/detectPipProxy.test.ts`

- [ ] **Step 1: Write tests**

Create `test/detectPipProxy.test.ts`:

```ts
import { parsePipConfigOutput, mergePipProxy } from '../src/adapters/python/detectPipProxy';

describe('parsePipConfigOutput', () => {
  test('parses single-quoted values', () => {
    const text = "global.proxy='http://corp:8080'\nglobal.index-url='https://nexus.local/simple'";
    expect(parsePipConfigOutput(text)).toEqual({
      proxy: 'http://corp:8080',
      indexUrl: 'https://nexus.local/simple',
      noProxy: null,
    });
  });
  test('parses double-quoted values', () => {
    const text = 'global.proxy="http://corp:8080"';
    expect(parsePipConfigOutput(text)).toEqual({
      proxy: 'http://corp:8080',
      indexUrl: null,
      noProxy: null,
    });
  });
  test('parses unquoted values', () => {
    const text = 'global.proxy=http://corp:8080';
    expect(parsePipConfigOutput(text).proxy).toBe('http://corp:8080');
  });
  test('returns nulls when no proxy keys present', () => {
    expect(parsePipConfigOutput('')).toEqual({ proxy: null, indexUrl: null, noProxy: null });
  });
});

describe('mergePipProxy', () => {
  const base = { proxy: null, indexUrl: null, noProxy: null };
  test('source = none when nothing set', () => {
    const r = mergePipProxy(base, {});
    expect(r.source).toBe('none');
  });
  test('source = pip when only pip config has values', () => {
    const r = mergePipProxy({ proxy: 'http://a', indexUrl: null, noProxy: null }, {});
    expect(r.source).toBe('pip');
    expect(r.proxyUrl).toBe('http://a');
  });
  test('source = env when only env vars set', () => {
    const r = mergePipProxy(base, { HTTPS_PROXY: 'http://b' });
    expect(r.source).toBe('env');
    expect(r.proxyUrl).toBe('http://b');
  });
  test('source = mixed when both set, pip wins', () => {
    const r = mergePipProxy({ proxy: 'http://pip', indexUrl: null, noProxy: null }, { HTTPS_PROXY: 'http://env' });
    expect(r.source).toBe('mixed');
    expect(r.proxyUrl).toBe('http://pip');
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectPipProxy 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/adapters/python/detectPipProxy.ts`:

```ts
import * as path from 'path';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

export interface PipProxyInfo {
  proxyUrl: string | null;
  indexUrl: string | null;
  noProxy: string | null;
  source: 'pip' | 'env' | 'mixed' | 'none';
}

interface PipConfigBag {
  proxy: string | null;
  indexUrl: string | null;
  noProxy: string | null;
}

// Probes pip's effective configuration for the chosen interpreter, then
// merges with HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars. Pip values
// take precedence; env fills in any blanks.
export async function detectPipProxy(pythonHome: string | undefined): Promise<PipProxyInfo> {
  const fromPip = pythonHome
    ? parsePipConfigOutput(await runPipConfigList(pythonHome) ?? '')
    : { proxy: null, indexUrl: null, noProxy: null };
  return mergePipProxy(fromPip, {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  });
}

// Parses `pip config list` output. Each line is either `<scope>.<key>=<val>`
// (unquoted) or `<scope>.<key>='<val>'` (quoted). We only look at the keys
// that matter for proxy display.
export function parsePipConfigOutput(text: string): PipConfigBag {
  const bag: PipConfigBag = { proxy: null, indexUrl: null, noProxy: null };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^['"]|['"]$/g, '').trim();
    if (key.endsWith('proxy')) bag.proxy = val;
    else if (key.endsWith('index-url') || key.endsWith('index_url')) bag.indexUrl = val;
    else if (key.endsWith('no-proxy') || key.endsWith('no_proxy')) bag.noProxy = val;
  }
  return bag;
}

export function mergePipProxy(
  pip: PipConfigBag,
  env: { HTTP_PROXY?: string; HTTPS_PROXY?: string; NO_PROXY?: string },
): PipProxyInfo {
  const envProxy = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? null;
  const proxyUrl = pip.proxy ?? envProxy ?? null;
  const indexUrl = pip.indexUrl ?? null;
  const noProxy = pip.noProxy ?? env.NO_PROXY ?? null;

  const pipHasAny = !!(pip.proxy || pip.indexUrl || pip.noProxy);
  const envHasAny = !!envProxy || !!env.NO_PROXY;
  let source: PipProxyInfo['source'];
  if (pipHasAny && envHasAny) source = 'mixed';
  else if (pipHasAny) source = 'pip';
  else if (envHasAny) source = 'env';
  else source = 'none';

  return { proxyUrl, indexUrl, noProxy, source };
}

async function runPipConfigList(pythonHome: string): Promise<string | undefined> {
  const bin = process.platform === 'win32'
    ? path.join(pythonHome, 'python.exe')
    : path.join(pythonHome, 'bin', 'python3');
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(bin, ['-m', 'pip', 'config', 'list'], { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, 2000);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectPipProxy 2>&1 | tail -10`
Expected: 8 tests pass.

DO NOT COMMIT.

---

## Task 9: buildPythonCommand

**Files:**
- Create: `src/adapters/python/buildPythonCommand.ts`
- Create: `test/buildPythonCommand.test.ts`

- [ ] **Step 1: Write tests**

Create `test/buildPythonCommand.test.ts`:

```ts
import { buildPythonCommand } from '../src/adapters/python/buildPythonCommand';
import type { RunConfig } from '../src/shared/types';

const base: any = {
  id: 'i', name: 'x', projectPath: '', workspaceFolder: '',
  env: {}, programArgs: '', vmArgs: '',
};

function cfg(overrides: any): RunConfig {
  return {
    ...base,
    type: 'python',
    typeOptions: {
      launchMode: 'script',
      pythonPath: '/opt/py-3.12',
      scriptPath: 'main.py',
      moduleName: '',
      framework: '',
      frameworkCommand: '',
      pytestArgs: '',
      customArgs: '',
      buildRoot: '',
      ...overrides,
    },
  } as RunConfig;
}

describe('buildPythonCommand', () => {
  test('script mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'script', scriptPath: 'app.py' }));
    expect(out.command.endsWith('python3') || out.command.endsWith('python.exe')).toBe(true);
    expect(out.args).toEqual(['app.py']);
  });
  test('script mode with programArgs', () => {
    const c = cfg({ launchMode: 'script', scriptPath: 'app.py' });
    (c as any).programArgs = '--port 9000 --debug';
    const out = buildPythonCommand(c);
    expect(out.args).toEqual(['app.py', '--port', '9000', '--debug']);
  });
  test('module mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'module', moduleName: 'mypkg.cli' }));
    expect(out.args).toEqual(['-m', 'mypkg.cli']);
  });
  test('framework: django', () => {
    const out = buildPythonCommand(cfg({
      launchMode: 'framework', framework: 'django', frameworkCommand: 'runserver',
    }));
    expect(out.args).toEqual(['-m', 'django', 'runserver']);
  });
  test('framework: uvicorn', () => {
    const out = buildPythonCommand(cfg({
      launchMode: 'framework', framework: 'uvicorn', frameworkCommand: 'app:main --reload',
    }));
    expect(out.args).toEqual(['-m', 'uvicorn', 'app:main', '--reload']);
  });
  test('framework: gunicorn', () => {
    const out = buildPythonCommand(cfg({
      launchMode: 'framework', framework: 'gunicorn', frameworkCommand: 'app:app -b 0.0.0.0:8000',
    }));
    expect(out.args).toEqual(['-m', 'gunicorn', 'app:app', '-b', '0.0.0.0:8000']);
  });
  test('pytest mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'pytest', pytestArgs: 'tests/foo.py -k smoke' }));
    expect(out.args).toEqual(['-m', 'pytest', 'tests/foo.py', '-k', 'smoke']);
  });
  test('custom mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'custom', customArgs: '-c "print(1)"' }));
    expect(out.args).toEqual(['-c', 'print(1)']);
  });
  test('falls back to python3 on PATH when pythonPath is empty', () => {
    const out = buildPythonCommand(cfg({ pythonPath: '', scriptPath: 'app.py' }));
    expect(out.command).toBe('python3');
  });
  test('vmArgs (interpreter args) come BEFORE script', () => {
    const c = cfg({ launchMode: 'script', scriptPath: 'app.py' });
    (c as any).vmArgs = '-O -W default';
    const out = buildPythonCommand(c);
    expect(out.args).toEqual(['-O', '-W', 'default', 'app.py']);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern buildPythonCommand 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/adapters/python/buildPythonCommand.ts`:

```ts
import * as path from 'path';
import type { RunConfig } from '../../shared/types';
import { splitArgs } from '../npm/splitArgs';

export function buildPythonCommand(cfg: RunConfig): { command: string; args: string[] } {
  if (cfg.type !== 'python') throw new Error('PythonAdapter received non-python config');
  const to = cfg.typeOptions;

  const command = pythonBin(to.pythonPath);
  const interpreterArgs = splitArgs(cfg.vmArgs ?? '');
  const programArgs = splitArgs(cfg.programArgs ?? '');

  switch (to.launchMode) {
    case 'script':
      return { command, args: [...interpreterArgs, to.scriptPath, ...programArgs] };
    case 'module':
      return { command, args: [...interpreterArgs, '-m', to.moduleName, ...programArgs] };
    case 'framework':
      return {
        command,
        args: [...interpreterArgs, ...frameworkInvocation(to.framework, to.frameworkCommand), ...programArgs],
      };
    case 'pytest':
      return { command, args: [...interpreterArgs, '-m', 'pytest', ...splitArgs(to.pytestArgs)] };
    case 'custom':
      return { command, args: [...interpreterArgs, ...splitArgs(to.customArgs)] };
  }
}

function pythonBin(pythonHome: string): string {
  if (!pythonHome) return 'python3';
  if (process.platform === 'win32') return path.join(pythonHome, 'python.exe');
  return path.join(pythonHome, 'bin', 'python3');
}

// Maps framework + command into a -m invocation. 'django' / 'uvicorn' /
// 'gunicorn' / 'celery' / 'flask' all support `-m`. fastapi / starlette /
// typer / click are libraries; the user is expected to use script or
// module mode for those, so we treat them as a pass-through to -m as well.
function frameworkInvocation(framework: string, command: string): string[] {
  const cmdArgs = splitArgs(command);
  if (!framework) return cmdArgs;
  return ['-m', framework, ...cmdArgs];
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern buildPythonCommand 2>&1 | tail -10`
Expected: 10 tests pass.

DO NOT COMMIT.

---

## Task 10: PythonAdapter — main adapter class

**Files:**
- Create: `src/adapters/python/PythonAdapter.ts`
- Create: `test/PythonAdapter.detect.test.ts`
- Create: `test/PythonAdapter.build.test.ts`

This task is the largest in the plan: it composes everything from Tasks 2-9 into a `RuntimeAdapter` implementation and adds the launchMode-driven form schema.

- [ ] **Step 1: Write the detect test**

Create `test/PythonAdapter.detect.test.ts`:

```ts
import { PythonAdapter } from '../src/adapters/python/PythonAdapter';

describe('PythonAdapter.getFormSchema', () => {
  const adapter = new PythonAdapter();

  test('typeSpecific includes python runtime, launchMode, mode-specific fields', () => {
    const schema = adapter.getFormSchema({
      pythons: [{ path: '/opt/py-3.12', version: '3.12.1' }],
      entryPoints: { scripts: [{ relativePath: 'app.py' }], modules: [{ dotted: 'pkg.cli' }] },
      frameworks: [{ name: 'django', source: 'pyproject.toml' }],
    });
    const keys = schema.typeSpecific.map(f => f.key);
    expect(keys).toContain('typeOptions.pythonPath');
    expect(keys).toContain('typeOptions.launchMode');
    expect(keys).toContain('typeOptions.scriptPath');
    expect(keys).toContain('typeOptions.moduleName');
    expect(keys).toContain('typeOptions.framework');
    expect(keys).toContain('typeOptions.frameworkCommand');
    expect(keys).toContain('typeOptions.pytestArgs');
    expect(keys).toContain('typeOptions.customArgs');
    expect(keys).toContain('port');
  });

  test('framework field options come from detected frameworks', () => {
    const schema = adapter.getFormSchema({
      pythons: [], entryPoints: { scripts: [], modules: [] },
      frameworks: [{ name: 'django', source: '...' }, { name: 'celery', source: '...' }],
    });
    const fwField = schema.typeSpecific.find(f => f.key === 'typeOptions.framework');
    const opts = (fwField as any).options as Array<{ value: string }>;
    expect(opts.map(o => o.value)).toContain('django');
    expect(opts.map(o => o.value)).toContain('celery');
  });

  test('script field options come from detected entry points', () => {
    const schema = adapter.getFormSchema({
      pythons: [], entryPoints: { scripts: [{ relativePath: 'main.py' }, { relativePath: 'src/cli.py' }], modules: [] },
      frameworks: [],
    });
    const f = schema.typeSpecific.find(field => field.key === 'typeOptions.scriptPath');
    const opts = (f as any).options as Array<{ value: string }>;
    expect(opts.map(o => o.value)).toEqual(['main.py', 'src/cli.py']);
  });

  test('module field options come from detected modules', () => {
    const schema = adapter.getFormSchema({
      pythons: [], entryPoints: { scripts: [], modules: [{ dotted: 'pkg.cli' }, { dotted: 'pkg.web' }] },
      frameworks: [],
    });
    const f = schema.typeSpecific.find(field => field.key === 'typeOptions.moduleName');
    const opts = (f as any).options as Array<{ value: string }>;
    expect(opts.map(o => o.value)).toEqual(['pkg.cli', 'pkg.web']);
  });
});

describe('PythonAdapter.detect', () => {
  test('returns default RunConfig shape with launchMode=script', async () => {
    // Detect runs the lightweight (sync) detection path. The streaming
    // detector populates pythons/entryPoints/frameworks asynchronously.
    const adapter = new PythonAdapter();
    const result = await adapter.detect(require('vscode').Uri.file('/tmp/nonexistent'));
    if (result === null) return;
    expect(result.defaults.type).toBe('python');
    expect((result.defaults.typeOptions as any).launchMode).toBe('script');
  });
});
```

- [ ] **Step 2: Write the build test**

Create `test/PythonAdapter.build.test.ts`:

```ts
import { PythonAdapter } from '../src/adapters/python/PythonAdapter';
import type { RunConfig } from '../src/shared/types';

const base: any = {
  id: 'i', name: 'x', projectPath: '', workspaceFolder: '',
  env: {}, programArgs: '', vmArgs: '',
};

function cfg(overrides: any): RunConfig {
  return {
    ...base, type: 'python',
    typeOptions: {
      launchMode: 'script',
      pythonPath: '/opt/py',
      scriptPath: 'app.py',
      moduleName: '', framework: '', frameworkCommand: '',
      pytestArgs: '', customArgs: '', buildRoot: '',
      ...overrides,
    },
  } as RunConfig;
}

describe('PythonAdapter.buildCommand', () => {
  const adapter = new PythonAdapter();
  test('script mode', () => {
    const out = adapter.buildCommand(cfg({}));
    expect(out.args).toEqual(['app.py']);
  });
  test('module mode', () => {
    const out = adapter.buildCommand(cfg({ launchMode: 'module', moduleName: 'pkg.cli' }));
    expect(out.args).toEqual(['-m', 'pkg.cli']);
  });
});

describe('PythonAdapter.getDebugConfig', () => {
  const adapter = new PythonAdapter();
  const folder = { uri: require('vscode').Uri.file('/proj'), name: 'proj', index: 0 } as any;
  test('returns a debugpy attach configuration', () => {
    const dc = adapter.getDebugConfig(cfg({}), folder);
    expect(dc.type).toBe('debugpy');
    expect(dc.request).toBe('attach');
    expect(dc.connect).toBeDefined();
  });
});
```

- [ ] **Step 3: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern PythonAdapter 2>&1 | tail -10`

- [ ] **Step 4: Implement `PythonAdapter.ts`**

Create `src/adapters/python/PythonAdapter.ts`:

```ts
import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch, PrepareContext, PrepareResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { detectPythons } from './detectPythons';
import { probePythonsStreaming, readPythons, pythonOption } from './probePythonsStreaming';
import { findEntryPoints, type ScriptEntryPoint, type ModuleEntryPoint } from './findEntryPoints';
import { detectFrameworks, type FrameworkHit } from './detectFrameworks';
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
    const [entryPoints, frameworks] = await Promise.all([
      findEntryPoints(folder),
      detectFrameworks(folder),
    ]);
    const primaryFramework = frameworks[0]?.name ?? '';
    const port = await detectPythonPort(folder, primaryFramework);
    emit({
      contextPatch: {
        entryPoints,
        frameworks,
        ...(port !== undefined ? { detectedPort: port } : {}),
      },
      ...(port !== undefined ? { defaultsPatch: { port } as any } : {}),
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

    const fwOptions = frameworks.map(f => ({ value: f.name, label: f.name }));
    if (fwOptions.length === 0) fwOptions.push({ value: '', label: '(none detected)' });

    const fwBadge = frameworks.length
      ? `**Detected frameworks:** ${frameworks.map(f => `\`${f.name}\``).join(', ')}\n\n`
      : '';

    const proxyInfo: FormField | null = pipProxy && pipProxy.source !== 'none' ? {
      kind: 'info',
      key: 'pipProxyInfo',
      label: 'Effective pip proxy',
      content: {
        rows: [
          { label: 'Proxy', value: pipProxy.proxyUrl ?? '(none)' },
          { label: 'Index URL', value: pipProxy.indexUrl ?? '(default)' },
          { label: 'No-proxy', value: pipProxy.noProxy ?? '(none)' },
          { label: 'Source', value: pipProxy.source },
        ],
      },
    } : null;

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
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.frameworkCommand',
          label: 'Framework command',
          options: buildFrameworkCommandOptions(frameworks),
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
        ...(proxyInfo ? [proxyInfo] : []),
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
    return {
      extraArgs: ['-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--wait-for-client'],
    };
  }

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    return {
      type: 'debugpy',
      request: 'attach',
      name: cfg.name,
      connect: { host: '127.0.0.1', port: 5678 },
      pathMappings: [{ localRoot: folder.uri.fsPath, remoteRoot: '.' }],
      justMyCode: true,
    };
  }
}

function buildFrameworkCommandOptions(frameworks: FrameworkHit[]): Array<{ value: string; label: string; group?: string }> {
  const out: Array<{ value: string; label: string; group?: string }> = [];
  for (const f of frameworks) {
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
  const path = await import('path');
  const cp = await import('child_process');
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
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      resolve(code === 0);
    });
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern PythonAdapter 2>&1 | tail -10`
Expected: 7 tests pass (5 detect + 2 build + 1 debug = 8; counts may differ as the test file is finalized — they should all pass).

DO NOT COMMIT.

---

## Task 11: Wire Python adapter into the rest of the system

**Files:**
- Modify: `src/extension.ts` (register the adapter, extend pending-fields)
- Modify: `src/ui/EditorPanel.ts` (sanitizeConfig branch for Python)
- Modify: `src/ui/RunConfigTreeProvider.ts` (label + brand icon)
- Modify: `src/ui/iconForConfig.ts` (icon resolution)

- [ ] **Step 1: Register the adapter**

In `src/extension.ts`, locate the registry block (around line 53-63). Add immediately after the `JavaAdapter` registration:

```ts
  registry.register(new PythonAdapter());
```

And add the import near the top of the file, alongside the other adapter imports:

```ts
import { PythonAdapter } from './adapters/python/PythonAdapter';
```

- [ ] **Step 2: Extend STREAMING_PENDING_FIELDS**

In `src/extension.ts`, locate `STREAMING_PENDING_FIELDS` (added in earlier work; search for the constant). Add Python's pending field at the bottom of the list:

```ts
  // python
  'typeOptions.pythonPath',
```

- [ ] **Step 3: Add sanitize branch in EditorPanel.ts**

In `src/ui/EditorPanel.ts`, locate `sanitizeConfig` and the existing `if/case` ladder per type. Add a new branch:

```ts
} else if (type === 'python') {
  const to = (sanitized.typeOptions ?? {}) as Record<string, unknown>;
  sanitized.typeOptions = {
    launchMode: typeof to.launchMode === 'string' ? to.launchMode : 'script',
    pythonPath: typeof to.pythonPath === 'string' ? to.pythonPath : '',
    scriptPath: typeof to.scriptPath === 'string' ? to.scriptPath : '',
    moduleName: typeof to.moduleName === 'string' ? to.moduleName : '',
    framework: typeof to.framework === 'string' ? to.framework : '',
    frameworkCommand: typeof to.frameworkCommand === 'string' ? to.frameworkCommand : '',
    pytestArgs: typeof to.pytestArgs === 'string' ? to.pytestArgs : '',
    customArgs: typeof to.customArgs === 'string' ? to.customArgs : '',
    buildRoot: typeof to.buildRoot === 'string' ? to.buildRoot : '',
  };
}
```

(Insert it next to the existing branches; match the surrounding style. The `type` variable comes from `sanitized.type`. If the existing code uses a `switch (type)` instead of an if-ladder, add a `case 'python':` to that.)

- [ ] **Step 4: Add label + icon in `RunConfigTreeProvider.ts`**

In `src/ui/RunConfigTreeProvider.ts`, find the `case 'java': return 'Java Application';` line. Add after it:

```ts
    case 'python':       return 'Python';
```

In the same file, find `case 'java': return 'java';` (in the icon-name resolver). Add after it:

```ts
    case 'python':       return 'python';
```

- [ ] **Step 5: Add icon in `iconForConfig.ts`**

In `src/ui/iconForConfig.ts`, find `case 'java': return 'java';`. Add after it:

```ts
    case 'python':      return 'python';
```

- [ ] **Step 6: Add icon assets**

Create simple SVG icons at `media/icons/python.svg` and `media/icons/python-light.svg`. These must follow the same shape as the existing `java.svg` etc. Use the official Python language logo (two intertwined snakes) — pre-existing public assets work.

For minimal-effort placeholder icons, use a circle with the letters "Py" (we can refine later):

```svg
<!-- media/icons/python.svg (dark theme) -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#3776AB">
  <circle cx="8" cy="8" r="7"/>
  <text x="8" y="11" font-family="sans-serif" font-size="8" fill="#FFD43B" text-anchor="middle">Py</text>
</svg>
```

```svg
<!-- media/icons/python-light.svg (light theme) -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#3776AB">
  <circle cx="8" cy="8" r="7"/>
  <text x="8" y="11" font-family="sans-serif" font-size="8" fill="#FFD43B" text-anchor="middle">Py</text>
</svg>
```

(If the user prefers the official logo, we can drop in a proper SVG later. Placeholder is fine for v1.)

- [ ] **Step 7: Verify everything**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green (target ~840+ tests now: 768 prior + ~70 new from Python tasks).

Run: `cd /git/run-config-manager && npm run build 2>&1 | tail -10`
Expected: clean Vite + esbuild build.

DO NOT COMMIT.

---

## Task 12: Final integration verification

**Files:** none (verification-only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -8`
Expected: all tests pass.

- [ ] **Step 2: Both typechecks**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

- [ ] **Step 3: Production build**

Run: `cd /git/run-config-manager && npm run build 2>&1 | tail -10`
Expected: clean Vite + esbuild build.

- [ ] **Step 4: Manual smoke check (recommended)**

```bash
code --extensionDevelopmentPath="$(pwd)" /tmp/scratch
```

In the host VS Code:
1. Create or open a folder with a Python project (a `pyproject.toml` declaring `django` is a good test case).
2. Open the Run Configurations sidebar; create a new config of type `Python`.
3. Verify:
   - The Python runtime dropdown lists detected interpreters (your `.venv`, system pythons, pyenv versions).
   - The launchMode dropdown has all five entries.
   - With `launchMode = script`, the Script field shows detected `if __name__ == "__main__":` files.
   - Switch to `launchMode = framework`. Framework dropdown should default to the detected framework (e.g. `django`), and the framework-command dropdown should list django commands.
   - With `launchMode = framework` + `framework = django` + `command = runserver`, the live command preview reads something like `<py>/bin/python3 -m django runserver`.
   - Save the config.
4. Click Run. Verify the script starts in the integrated terminal.
5. Click Debug. If `debugpy` isn't installed, confirm the error toast surfaces with a Fix path.
6. With `debugpy` installed, click Debug again. Verify VS Code's debugger attaches and breakpoints work.
7. Open the saved config in edit mode. Verify the Python runtime dropdown still lists installs (proves the streaming-detect-on-edit fix from earlier work flows through here too).

DO NOT COMMIT.

---

## Self-review

**Spec coverage:**
- New `python` config type → Tasks 1, 10.
- Interpreter detection (system + venvs + version managers) → Task 2.
- Entry-point + module discovery → Task 5.
- Framework detection (django/fastapi/flask/uvicorn/gunicorn/celery/typer/click/starlette) → Task 6.
- Port detection (Procfile, framework default) → Task 7.
- Pip proxy info bubble → Task 8 + Task 10 form schema.
- Debug via debugpy → Task 10 (`prepareLaunch`, `getDebugConfig`).
- Command preview → Task 9.
- Adapter registration / icons / labels → Task 11.
- Tests → distributed across Tasks 2-10.

All spec sections have a backing task.

**Placeholder scan:** none of the disallowed phrases ("TBD", "TODO", "implement later", "similar to Task N") appear. Task 11 step 3 shows the actual sanitize branch code; step 4-5 show actual case-statement additions; step 6 shows actual SVG content.

**Type consistency:**
- `PythonInfo { path; version? }` defined in Task 2, consumed in Tasks 4, 10.
- `PythonLaunchMode` defined in Task 1, used in Tasks 9 and 10.
- `PythonFramework` defined in Task 1, used in Tasks 6, 7, 9, 10.
- `FrameworkHit { name; source }` defined in Task 6, consumed in Task 10.
- `PipProxyInfo` defined in Task 8, consumed in Task 10.
- `ScriptEntryPoint`, `ModuleEntryPoint` defined in Task 5, consumed in Task 10.

**Numbers cross-check:**
- Test counts: detectPythons (4) + probePythonVersion (4) + findEntryPoints (5) + detectFrameworks (8) + detectPythonPort (8) + detectPipProxy (8) + buildPythonCommand (10) + PythonAdapter.detect (5) + PythonAdapter.build (3) = 55 new test cases. Final suite: ~768 + 55 = ~823 tests at end of Task 11.

Plan complete.
