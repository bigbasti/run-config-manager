# npm Framework-Aware Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add framework-aware enhancements to npm configs — smarter default script per framework, "Detected: <framework>" badge in the form, framework-default port pre-fill, and a pre-flight `node_modules` check on Run.

**Architecture:** One new async detection module (`detectNpmFramework`) that returns a single source-of-truth `NpmFrameworkInfo`. Existing `readPackageJsonInfo` consults it for the default script; `detectNpmPort` consults it for the default port; `NpmAdapter.getFormSchema` consults it for the badge. ExecutionService gains a `preflightNpmDependencies` mirror of the Python pre-flight, with mtime-keyed caching.

**Tech Stack:** TypeScript, the existing `RuntimeAdapter` interface, `vscode.workspace.fs` for async reads, Jest for tests, the existing `runInTerminal` Task plumbing for the [Install] button.

---

## Spec reference

Implements `docs/superpowers/specs/2026-05-12-npm-framework-awareness-design.md`.

## File map

**New file:**
- `src/adapters/npm/detectNpmFramework.ts` — async framework detector. Returns `NpmFrameworkInfo` with `name`, `source`, `defaultScript`, `defaultPort`. Runs once per detect cycle.
- `test/detectNpmFramework.test.ts` — per-framework signal coverage + priority order.

**Modified files:**
- `src/adapters/npm/detectPackageJson.ts` — `readPackageJsonInfo` now returns `dependencies` + `devDependencies` arrays alongside the existing fields, and lets `defaultScript` come from `detectNpmFramework` when a framework is detected.
- `src/adapters/npm/NpmAdapter.ts` — read framework from context, add the badge field below Script, thread `defaultPort` into `defaultsPatch`.
- `src/services/detectProjectPort.ts` (`detectNpmPort`) — replace the inline framework table with a call to `detectNpmFramework`. Fall back to its `defaultPort` when no `--port` is found in scripts.
- `src/services/ExecutionService.ts` — add `preflightNpmDependencies` and call it before launching `npm` configs. Mtime-keyed cache mirroring `preflightPythonDependencies`.

**Test files (modified):**
- `test/NpmAdapter.detect.test.ts` — assert `npmFramework` flows into context and the badge is in the form schema; assert `defaultScript` follows convention.
- `test/detectProjectPort.test.ts` (or wherever existing port tests live — verify location with grep) — assert framework default fires only when no `--port` found.

## Conventions used throughout

- Tests use Jest; mock `vscode.workspace.fs.stat` / `readFile` via `(workspace.fs as any).stat = jest.fn(...)`.
- **No commits.** Each task ends with verification only.
- After each task: `npm run typecheck` and `npm test` (full suite).

---

## Task 1: detectNpmFramework — async framework detector

**Files:**
- Create: `src/adapters/npm/detectNpmFramework.ts`
- Create: `test/detectNpmFramework.test.ts`

- [ ] **Step 1: Write parser-only tests for the priority logic**

Create `test/detectNpmFramework.test.ts`:

```ts
import { detectNpmFrameworkFrom } from '../src/adapters/npm/detectNpmFramework';

// Helper — produces an "all signals" summary the detector consumes.
// Mirrors the shape detectNpmFramework.detect() builds at runtime
// from filesystem + package.json checks.
function makeSignals(overrides: Partial<{
  files: string[];
  dependencies: string[];
  scripts: string[];
  pkgScripts: Record<string, string>;
}> = {}) {
  return {
    files: overrides.files ?? [],
    dependencies: overrides.dependencies ?? [],
    scripts: overrides.scripts ?? [],
    pkgScripts: overrides.pkgScripts ?? {},
  };
}

describe('detectNpmFrameworkFrom — per-framework signals', () => {
  test('Next.js wins on next.config.ts even when vite.config.ts is present', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['next.config.ts', 'vite.config.ts'],
      dependencies: ['next', 'vite'],
      scripts: ['dev', 'build', 'start'],
    }));
    expect(r.name).toBe('nextjs');
    expect(r.defaultScript).toBe('dev');
    expect(r.defaultPort).toBe(3000);
    expect(r.source).toContain('next.config.ts');
  });

  test('Nuxt detected via nuxt.config.js', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['nuxt.config.js'],
      scripts: ['dev', 'build'],
    }));
    expect(r.name).toBe('nuxt');
    expect(r.defaultPort).toBe(3000);
  });

  test('SvelteKit detected via @sveltejs/kit dep — wins over generic Vite', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['vite.config.ts'],
      dependencies: ['@sveltejs/kit', 'vite'],
      scripts: ['dev'],
    }));
    expect(r.name).toBe('sveltekit');
  });

  test('Astro detected via astro.config.mjs', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['astro.config.mjs'],
      scripts: ['dev', 'build', 'preview'],
    }));
    expect(r.name).toBe('astro');
    expect(r.defaultPort).toBe(4321);
  });

  test('Remix detected via remix.config.js', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['remix.config.js'],
      scripts: ['dev'],
    }));
    expect(r.name).toBe('remix');
    expect(r.defaultPort).toBe(3000);
  });

  test('Gatsby detected via gatsby-config.js — uses develop script', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['gatsby-config.js'],
      scripts: ['develop', 'build', 'serve'],
    }));
    expect(r.name).toBe('gatsby');
    expect(r.defaultScript).toBe('develop');
    expect(r.defaultPort).toBe(8000);
  });

  test('Angular detected via angular.json — uses start script', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['angular.json'],
      dependencies: ['@angular/core'],
      scripts: ['ng', 'start', 'build', 'test'],
    }));
    expect(r.name).toBe('angular');
    expect(r.defaultScript).toBe('start');
    expect(r.defaultPort).toBe(4200);
  });

  test('Storybook detected via .storybook/ dir', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['.storybook/'],
      scripts: ['storybook', 'build-storybook'],
    }));
    expect(r.name).toBe('storybook');
    expect(r.defaultScript).toBe('storybook');
    expect(r.defaultPort).toBe(6006);
  });

  test('Vue CLI detected via vue.config.js', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['vue.config.js'],
      dependencies: ['@vue/cli-service'],
      scripts: ['serve', 'build', 'lint'],
    }));
    expect(r.name).toBe('vue');
    expect(r.defaultScript).toBe('serve');
    expect(r.defaultPort).toBe(8080);
  });

  test('CRA detected via react-scripts dep', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      dependencies: ['react-scripts'],
      scripts: ['start', 'build', 'test'],
    }));
    expect(r.name).toBe('react');
    expect(r.defaultScript).toBe('start');
    expect(r.defaultPort).toBe(3000);
  });

  test('Plain Vite detected via vite.config.ts when no meta-framework matched', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['vite.config.ts'],
      dependencies: ['vite'],
      scripts: ['dev', 'build', 'preview'],
    }));
    expect(r.name).toBe('vite');
    expect(r.defaultScript).toBe('dev');
    expect(r.defaultPort).toBe(5173);
  });

  test('falls back to first script when no framework matches', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      scripts: ['build', 'test'],
    }));
    expect(r.name).toBeNull();
    expect(r.defaultScript).toBe('build');
    expect(r.defaultPort).toBeNull();
  });

  test('defaultScript falls back to scripts[0] when convention name is absent', () => {
    // Angular detected, but `start` not present in scripts — fall back.
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['angular.json'],
      scripts: ['ng', 'build'], // no `start`
    }));
    expect(r.name).toBe('angular');
    expect(r.defaultScript).toBe('ng');
  });

  test('defaultScript empty when no scripts at all', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['angular.json'],
      scripts: [],
    }));
    expect(r.defaultScript).toBe('');
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectNpmFramework 2>&1 | tail -10`

Expected: `Cannot find module '../src/adapters/npm/detectNpmFramework'`.

- [ ] **Step 3: Implement `detectNpmFramework.ts`**

Create `src/adapters/npm/detectNpmFramework.ts`:

```ts
import * as vscode from 'vscode';
import { log } from '../../utils/logger';

export type NpmFramework =
  | 'angular' | 'nextjs' | 'nuxt' | 'vite' | 'sveltekit' | 'svelte'
  | 'vue' | 'react' | 'astro' | 'remix' | 'gatsby' | 'storybook'
  | null;

export interface NpmFrameworkInfo {
  // Identified framework, or null when nothing matched.
  name: NpmFramework;
  // Human-readable detection source — e.g. 'next.config.ts',
  // 'angular.json', '@sveltejs/kit in dependencies'. Used in the form
  // badge so the user can see WHY we made the call.
  source: string;
  // Best-guess script name to invoke. Matches the framework's
  // convention name when a script with that name exists; otherwise
  // falls back to scripts[0]. Empty string when no scripts at all.
  defaultScript: string;
  // Convention port for this framework's dev server. null when the
  // framework isn't a server (no current cases — every framework in
  // the table binds a port — but kept nullable for future entries
  // like a CLI-only library tooling framework).
  defaultPort: number | null;
}

// What the detector reads from disk + package.json. Pulled into a
// signals struct so the priority logic can be tested without filesystem
// I/O via the exported `detectNpmFrameworkFrom`.
export interface NpmFrameworkSignals {
  // Files present at the project root. The detector cares about specific
  // names — angular.json, next.config.ts, etc. The .storybook directory
  // is represented as '.storybook/' (trailing slash) so the detector
  // can match without ambiguity.
  files: string[];
  // Union of `dependencies` + `devDependencies` from package.json.
  dependencies: string[];
  // Script names declared in package.json's `scripts` block.
  scripts: string[];
  // Full scripts map so we can match keywords inside script bodies
  // (e.g. `react-scripts` invoked via `start: react-scripts start`).
  pkgScripts: Record<string, string>;
}

// Async entry point. Reads disk + package.json, hands off to the pure
// detect-from-signals function.
export async function detectNpmFramework(
  folder: vscode.Uri,
  scripts: string[],
  pkgScripts: Record<string, string>,
  dependencies: string[],
): Promise<NpmFrameworkInfo> {
  const files = await listProbedFiles(folder);
  return detectNpmFrameworkFrom({ files, dependencies, scripts, pkgScripts });
}

// Per-framework specs. Detection priority IS the order of this array —
// the first entry whose signals match wins. Notes inline in the `note`
// field document why a particular ordering matters.
interface FrameworkSpec {
  name: NonNullable<NpmFramework>;
  // File names whose presence at the project root triggers detection.
  files?: string[];
  // Dep names (from `dependencies` ∪ `devDependencies`) whose presence
  // triggers detection.
  deps?: string[];
  // Substring tokens to look for in any script body. Used for CRA
  // (`react-scripts start`) and similar where the dep / file signals
  // are the same as a transitively-included framework.
  scriptTokens?: string[];
  // Convention script names. The detector picks the first one that
  // exists in the project's scripts; falls back to scripts[0].
  preferredScripts: string[];
  defaultPort: number | null;
}

const FRAMEWORK_SPECS: FrameworkSpec[] = [
  // Order matters. Meta-frameworks come BEFORE generic Vite — Next.js
  // / Nuxt / SvelteKit / Astro / Remix all transitively use Vite or
  // Vite-like dev servers, and would mis-claim if Vite came first.
  {
    name: 'nextjs',
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    deps: ['next'],
    preferredScripts: ['dev'],
    defaultPort: 3000,
  },
  {
    name: 'nuxt',
    files: ['nuxt.config.js', 'nuxt.config.ts'],
    deps: ['nuxt'],
    preferredScripts: ['dev'],
    defaultPort: 3000,
  },
  {
    name: 'sveltekit',
    deps: ['@sveltejs/kit'],
    preferredScripts: ['dev'],
    defaultPort: 5173,
  },
  {
    name: 'astro',
    files: ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'],
    deps: ['astro'],
    preferredScripts: ['dev'],
    defaultPort: 4321,
  },
  {
    name: 'remix',
    files: ['remix.config.js', 'remix.config.ts'],
    deps: ['@remix-run/dev'],
    preferredScripts: ['dev'],
    defaultPort: 3000,
  },
  {
    name: 'gatsby',
    files: ['gatsby-config.js', 'gatsby-config.ts'],
    deps: ['gatsby'],
    preferredScripts: ['develop'],
    defaultPort: 8000,
  },
  {
    name: 'angular',
    files: ['angular.json'],
    deps: ['@angular/core'],
    preferredScripts: ['start'],
    defaultPort: 4200,
  },
  {
    name: 'storybook',
    files: ['.storybook/'],
    deps: ['@storybook/cli'],
    preferredScripts: ['storybook'],
    defaultPort: 6006,
  },
  {
    name: 'svelte',
    files: ['svelte.config.js', 'svelte.config.ts'],
    deps: ['svelte'],
    preferredScripts: ['dev'],
    defaultPort: 5173,
  },
  {
    name: 'vue',
    files: ['vue.config.js'],
    deps: ['@vue/cli-service'],
    preferredScripts: ['serve'],
    defaultPort: 8080,
  },
  {
    name: 'react',
    deps: ['react-scripts'],
    scriptTokens: ['react-scripts'],
    preferredScripts: ['start'],
    defaultPort: 3000,
  },
  // Generic Vite — last priority among matching specs because every
  // meta-framework above may transitively bring in Vite.
  {
    name: 'vite',
    files: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'],
    deps: ['vite'],
    preferredScripts: ['dev'],
    defaultPort: 5173,
  },
];

// Pure function — exported for unit testing. Walks FRAMEWORK_SPECS in
// priority order and returns the first match. Picks the default script
// from the matching spec's preferredScripts (the first one present in
// `scripts`); falls back to `scripts[0]`.
export function detectNpmFrameworkFrom(signals: NpmFrameworkSignals): NpmFrameworkInfo {
  const fileSet = new Set(signals.files);
  const depSet = new Set(signals.dependencies);
  const scriptSet = new Set(signals.scripts);

  for (const spec of FRAMEWORK_SPECS) {
    const matchedFile = spec.files?.find(f => fileSet.has(f));
    const matchedDep = spec.deps?.find(d => depSet.has(d));
    const matchedToken = spec.scriptTokens?.find(t =>
      Object.values(signals.pkgScripts).some(line => new RegExp(`\\b${t}\\b`).test(line)),
    );
    if (!matchedFile && !matchedDep && !matchedToken) continue;

    const source = matchedFile
      ? matchedFile
      : matchedDep
        ? `${matchedDep} in dependencies`
        : `${matchedToken} in scripts`;
    const defaultScript = pickDefaultScript(spec.preferredScripts, signals.scripts, scriptSet);
    return {
      name: spec.name,
      source,
      defaultScript,
      defaultPort: spec.defaultPort,
    };
  }

  return {
    name: null,
    source: '',
    defaultScript: signals.scripts[0] ?? '',
    defaultPort: null,
  };
}

function pickDefaultScript(
  preferred: string[],
  scripts: string[],
  scriptSet: Set<string>,
): string {
  for (const p of preferred) {
    if (scriptSet.has(p)) return p;
  }
  return scripts[0] ?? '';
}

// Stat-checks the small set of project-root files we care about. We
// don't enumerate the directory because that's O(everything) and we
// only need to know whether 30-ish specific names exist.
async function listProbedFiles(folder: vscode.Uri): Promise<string[]> {
  const candidates = [
    'next.config.js', 'next.config.mjs', 'next.config.ts',
    'nuxt.config.js', 'nuxt.config.ts',
    'astro.config.js', 'astro.config.mjs', 'astro.config.ts',
    'remix.config.js', 'remix.config.ts',
    'gatsby-config.js', 'gatsby-config.ts',
    'angular.json',
    'svelte.config.js', 'svelte.config.ts',
    'vue.config.js',
    'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
    '.storybook',
  ];
  const out: string[] = [];
  for (const name of candidates) {
    const uri = vscode.Uri.joinPath(folder, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      // Storybook signal is a directory; everything else is a file.
      if (name === '.storybook') {
        if ((stat.type & vscode.FileType.Directory) !== 0) out.push('.storybook/');
      } else {
        out.push(name);
      }
    } catch {
      /* not present */
    }
  }
  log.debug(`detectNpmFramework: probed ${candidates.length} files, ${out.length} present`);
  return out;
}
```

- [ ] **Step 4: Run the parser tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectNpmFramework 2>&1 | tail -15`

Expected: 13 tests pass.

- [ ] **Step 5: Verify typecheck still passes**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

Expected: zero errors.

DO NOT COMMIT.

---

## Task 2: Wire detectNpmFramework into detectPackageJson

**Files:**
- Modify: `src/adapters/npm/detectPackageJson.ts`

`readPackageJsonInfo` currently picks the default script via `scripts.includes('start') ? 'start' : scripts.includes('dev') ? 'dev' : scripts[0] ?? ''`. We replace that with a call to `detectNpmFramework`, which uses framework-specific preferred scripts. We also surface the deps + pkgScripts on the return so the adapter can pass them to the framework detector once on the streaming path without re-reading the file.

- [ ] **Step 1: Extend `PackageJsonInfo`**

In `src/adapters/npm/detectPackageJson.ts`, replace the `PackageJsonInfo` interface:

```ts
export interface PackageJsonInfo {
  scripts: string[];
  packageManager: PackageManager;
  defaultScript: string;
  // Full scripts map (key → command line). Surfaced so callers can
  // inspect script bodies without re-reading package.json.
  pkgScripts: Record<string, string>;
  // Union of dependencies + devDependencies. Used by the framework
  // detector + ExecutionService pre-flight.
  dependencies: string[];
}
```

- [ ] **Step 2: Update `readPackageJsonInfo`**

Replace the body of `readPackageJsonInfo`:

```ts
export async function readPackageJsonInfo(
  folder: vscode.Uri,
): Promise<PackageJsonInfo | null> {
  const pkgUri = vscode.Uri.joinPath(folder, 'package.json');
  const raw = await readText(pkgUri);
  if (raw === null) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const scriptsObj = (parsed && typeof parsed === 'object' && parsed.scripts) || {};
  const pkgScripts: Record<string, string> = {};
  for (const k of Object.keys(scriptsObj)) {
    if (typeof scriptsObj[k] === 'string') pkgScripts[k] = scriptsObj[k];
  }
  const scripts = Object.keys(pkgScripts);

  const dependencies = uniqueDepNames(parsed?.dependencies, parsed?.devDependencies);

  // Ask the framework detector for a smarter default script. When no
  // framework is detected, fall back to the historic 'start' / 'dev' /
  // first-script preference order so behavior is unchanged on
  // unrecognized projects.
  const fw = await detectNpmFramework(folder, scripts, pkgScripts, dependencies);
  const defaultScript = fw.name && fw.defaultScript
    ? fw.defaultScript
    : (scripts.includes('start') ? 'start'
      : scripts.includes('dev') ? 'dev'
      : scripts[0] ?? '');

  const pm = await detectPackageManager(folder);

  return { scripts, defaultScript, packageManager: pm, pkgScripts, dependencies };
}

function uniqueDepNames(
  deps: unknown,
  devDeps: unknown,
): string[] {
  const set = new Set<string>();
  for (const obj of [deps, devDeps]) {
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj as Record<string, unknown>)) set.add(key);
    }
  }
  return [...set];
}
```

Add the import at the top:

```ts
import { detectNpmFramework } from './detectNpmFramework';
```

- [ ] **Step 3: Run npm-related existing tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern "NpmAdapter|detectNpmFramework|detectPackageJson" 2>&1 | tail -15`

Expected: existing NpmAdapter tests still pass; the new contract is additive (we added two fields, didn't remove anything).

- [ ] **Step 4: Full suite + typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green.

DO NOT COMMIT.

---

## Task 3: NpmAdapter — emit framework + render badge

**Files:**
- Modify: `src/adapters/npm/NpmAdapter.ts`
- Modify: `test/NpmAdapter.detect.test.ts`

The adapter's `detectStreaming` already reads `package.json`. After this task, it also threads the framework detector's full result into `context.npmFramework`, and the form schema adds a "Detected: <framework>" info banner immediately after the Script field.

- [ ] **Step 1: Add a failing test for the badge in the form schema**

In `test/NpmAdapter.detect.test.ts`, append (or create the describe block if absent):

```ts
describe('NpmAdapter form schema — Detected framework badge', () => {
  test('badge appears when context.npmFramework.name is set', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({
      scripts: ['dev', 'build'],
      npmFramework: {
        name: 'nextjs',
        source: 'next.config.ts',
        defaultScript: 'dev',
        defaultPort: 3000,
      },
    });
    const badge = schema.typeSpecific.find(f => f.key === 'npmFrameworkBadge');
    expect(badge).toBeDefined();
    expect(badge!.kind).toBe('info');
    expect((badge as any).content.banner.text).toContain('Next.js');
    expect((badge as any).content.banner.text).toContain('next.config.ts');
  });

  test('no badge when npmFramework is null or absent', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({
      scripts: ['build'],
      npmFramework: { name: null, source: '', defaultScript: 'build', defaultPort: null },
    });
    expect(schema.typeSpecific.find(f => f.key === 'npmFrameworkBadge')).toBeUndefined();
    const noContext = adapter.getFormSchema({});
    expect(noContext.typeSpecific.find(f => f.key === 'npmFrameworkBadge')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern NpmAdapter.detect 2>&1 | tail -10`
Expected: assertion failure ("badge to be defined" or similar).

- [ ] **Step 3: Update detectStreaming to emit framework info**

In `src/adapters/npm/NpmAdapter.ts`, find the `detectStreaming` method's `readPackageJsonInfo` call. Replace the `emit(...)` block so it also passes `npmFramework` through:

```ts
  async detectStreaming(folder: vscode.Uri, emit: (p: StreamingPatch) => void): Promise<void> {
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

    await probeNodesStreaming(emit, 'npm');
  }
```

Add the import at the top (near `readPackageJsonInfo`):

```ts
import { detectNpmFramework, type NpmFrameworkInfo } from './detectNpmFramework';
```

- [ ] **Step 4: Add the badge field to getFormSchema**

In `src/adapters/npm/NpmAdapter.ts`, find `getFormSchema(context)`. Read `context.npmFramework`, then insert the badge field into `typeSpecific` immediately after the existing Script field:

```ts
  getFormSchema(context: Record<string, unknown>): FormSchema {
    const scripts = (context.scripts as string[] | undefined) ?? [];
    const fw = context.npmFramework as NpmFrameworkInfo | undefined;

    const scriptField: FormField = scripts.length
      ? { /* existing select shape — leave unchanged */ }
      : { /* existing text shape — leave unchanged */ };

    const frameworkBadge: FormField | null = fw && fw.name ? {
      kind: 'info',
      key: 'npmFrameworkBadge',
      label: 'Detected framework',
      content: {
        banner: {
          kind: 'muted',
          text: `Detected: **${frameworkDisplayName(fw.name)}** (${fw.source})`,
        },
      },
    } : null;

    return {
      common: [ /* ...existing... */ ],
      typeSpecific: [
        scriptField,
        ...(frameworkBadge ? [frameworkBadge] : []),
        // ...rest of existing typeSpecific entries (packageManager, port, etc.)
      ],
      advanced: [ /* ...existing... */ ],
    };
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
```

(The placeholder `/* existing select shape — leave unchanged */` etc. means: do not modify those parts of the function. Only add `frameworkBadge` and insert it into `typeSpecific`. If you reformat the function, preserve every other field's exact code.)

- [ ] **Step 5: Run the badge tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern NpmAdapter.detect 2>&1 | tail -10`
Expected: 2 new tests pass.

- [ ] **Step 6: Full suite + typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green.

DO NOT COMMIT.

---

## Task 4: Refactor detectNpmPort to use the shared framework detector

**Files:**
- Modify: `src/services/detectProjectPort.ts`
- Modify (probably): a port test file — locate via `grep`

The current `detectNpmPort` has its own inline framework table. Replace it with a call to `detectNpmFramework` so the port table stays in one place (any framework added in the future updates both detect-paths automatically).

- [ ] **Step 1: Locate the port test file**

Run: `cd /git/run-config-manager && grep -l "detectNpmPort\b" test/`

Note the file path (likely `test/detectNpmPort.test.ts` or `test/detectProjectPort.test.ts`). If no test file exists yet, you'll add one in Step 4.

- [ ] **Step 2: Refactor `detectNpmPort`**

In `src/services/detectProjectPort.ts`, replace the body of `detectNpmPort` after the `--port` script-flag scan. Remove the inline framework table (`@angular/core / next / vite / ...`) and replace with:

```ts
  // Fall back to framework convention defaults via the shared detector.
  // This is the same data the form's "Detected: X" badge uses, so
  // changes to the framework table propagate to both paths automatically.
  const scriptKeys = Object.keys(scripts);
  const dependencies = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const fw = await detectNpmFramework(projectRoot, scriptKeys, scripts, dependencies);
  if (fw.defaultPort !== null) {
    log.info(`detectNpmPort: matched ${fw.name} convention → port=${fw.defaultPort}`);
    return fw.defaultPort;
  }
  log.debug(`detectNpmPort: no framework convention matched for script "${scriptName}"`);
  return null;
}
```

Keep the existing `--port` scan logic above this — only the framework-fallback section changes.

Add the import near the top of the file:

```ts
import { detectNpmFramework } from '../adapters/npm/detectNpmFramework';
```

- [ ] **Step 3: Run existing port tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectProjectPort 2>&1 | tail -10`
(Or `detectNpmPort` if that's the test file name.)
Expected: tests still pass — the framework table moved but the values are identical to the old inline table.

- [ ] **Step 4: Add a test for the priority change**

If no port-priority test exists, append to whichever file holds the port tests:

```ts
import { detectNpmPort } from '../src/services/detectProjectPort';

describe('detectNpmPort — framework default fallback', () => {
  // Helper that mocks vscode.workspace.fs.readFile to return a
  // package.json synthesized from the given inputs.
  // (If your existing tests already have a helper for this, reuse it.)
  function mockPackageJson(content: any): void {
    const text = JSON.stringify(content);
    const vs = require('vscode');
    vs.workspace.fs.readFile = jest.fn(async () => Buffer.from(text));
    vs.workspace.fs.stat = jest.fn(async () => ({ type: 1 })); // FileType.File
  }

  beforeEach(() => jest.resetModules());

  test('returns explicit --port from script when present (wins over framework default)', async () => {
    mockPackageJson({
      scripts: { dev: 'next dev --port 5000' },
      dependencies: { next: '^14.0.0' },
    });
    const port = await detectNpmPort(require('vscode').Uri.file('/proj'), 'dev');
    expect(port).toBe(5000); // user override wins
  });

  test('falls back to framework default when no --port found', async () => {
    mockPackageJson({
      scripts: { dev: 'next dev' },
      dependencies: { next: '^14.0.0' },
    });
    const port = await detectNpmPort(require('vscode').Uri.file('/proj'), 'dev');
    expect(port).toBe(3000);
  });

  test('returns null for plain Node project with no framework match', async () => {
    mockPackageJson({
      scripts: { start: 'node index.js' },
      dependencies: {},
    });
    const port = await detectNpmPort(require('vscode').Uri.file('/proj'), 'start');
    expect(port).toBeNull();
  });
});
```

(If your existing tests already do these things, skip Step 4 — confirm via grep before adding duplicates.)

- [ ] **Step 5: Run + verify**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green.

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

DO NOT COMMIT.

---

## Task 5: ExecutionService — pre-flight node_modules check

**Files:**
- Modify: `src/services/ExecutionService.ts`

Mirror `preflightPythonDependencies`. New method `preflightNpmDependencies` runs before launching `cfg.type === 'npm'` configs, prompts the user when `node_modules/` is missing, and routes [Install] through the existing Task-based `runInTerminal` plumbing.

- [ ] **Step 1: Add the call site**

In `src/services/ExecutionService.ts`, find where `preflightPythonDependencies` is called (existing block around the python pre-flight). Add an analogous block for npm:

```ts
    if (cfg.type === 'python') {
      const proceed = await this.preflightPythonDependencies(cfg, folder);
      if (!proceed) return undefined;
    }
    if (cfg.type === 'npm') {
      const proceed = await this.preflightNpmDependencies(cfg, folder);
      if (!proceed) return undefined;
    }
```

- [ ] **Step 2: Add the method**

Inside the `ExecutionService` class, near `preflightPythonDependencies`, add:

```ts
  // Cache for npm dependency pre-flight. Keyed by
  // `<projectRoot>|<package.json mtime>|<lockfile mtime>` so a fresh
  // `npm install` (which updates the lockfile mtime) re-fires the
  // check on the next Run.
  private npmDependencyCheckCache = new Map<string, 'ok' | 'asked'>();

  private async preflightNpmDependencies(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
  ): Promise<boolean> {
    if (cfg.type !== 'npm') return true;
    const projectRoot = resolveProjectUri(folder, cfg.projectPath).fsPath;

    // Build a cache key that includes manifest + lockfile mtimes so
    // `npm install` automatically invalidates the prompt.
    let mtimeKey = '';
    try {
      const stat = await fsModule.promises.stat(pathModule.join(projectRoot, 'package.json'));
      mtimeKey += `:pkg=${stat.mtimeMs}`;
    } catch {
      // No package.json — nothing to install. Let the launch fail
      // through its own error path.
      return true;
    }
    for (const lock of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      try {
        const stat = await fsModule.promises.stat(pathModule.join(projectRoot, lock));
        mtimeKey += `:${lock}=${stat.mtimeMs}`;
        break; // first found wins
      } catch { /* not present */ }
    }
    const cacheKey = `${projectRoot}|${mtimeKey}`;
    if (this.npmDependencyCheckCache.get(cacheKey)) return true;

    // Fast path: node_modules exists → no prompt.
    try {
      const stat = await fsModule.promises.stat(pathModule.join(projectRoot, 'node_modules'));
      if (stat.isDirectory()) {
        this.npmDependencyCheckCache.set(cacheKey, 'ok');
        return true;
      }
    } catch { /* not present — fall through to prompt */ }

    const pm = cfg.typeOptions.packageManager ?? 'npm';
    const choice = await vscode.window.showWarningMessage(
      `"${cfg.name}" depends on packages that aren't installed. Run \`${pm} install\` first?`,
      { modal: false },
      'Install',
      'Run anyway',
    );
    this.npmDependencyCheckCache.set(cacheKey, 'asked');

    if (choice === 'Install') {
      // Spawn the install via the same Task-based plumbing the
      // right-click `npm: Install` action uses. That path doesn't
      // suffer the rc-init race that plagued createTerminal earlier.
      const execution = new vscode.ShellExecution(pm, ['install'], { cwd: projectRoot });
      const task = new vscode.Task(
        { type: 'rcm-npm-preflight', configId: cfg.id } as any,
        folder,
        `${cfg.name} · ${pm} install`,
        'Run Configurations',
        execution,
        [],
      );
      try {
        await vscode.tasks.executeTask(task);
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to start ${pm} install: ${(e as Error).message}`);
      }
      return false; // abort this run; user will click Run again after install
    }
    if (choice === 'Run anyway') return true;
    return false;
  }
```

The `fsModule` and `pathModule` aliases were already added in the Python pre-flight task. If they aren't imported at the top of the file, add:

```ts
import * as fsModule from 'fs';
import * as pathModule from 'path';
```

(These are likely already present from the earlier Python pre-flight wiring — confirm via `grep` before duplicating.)

- [ ] **Step 3: Add a focused unit test**

Create `test/preflightNpmDependencies.test.ts`:

```ts
import * as vscode from 'vscode';

// We can't easily exercise preflightNpmDependencies in isolation
// because it lives on the ExecutionService class which depends on
// adapter registry / task system. Instead, exercise the cache-key
// shape via a snapshot test on the source — simple guard against
// accidentally dropping mtime-keying.

import * as fs from 'fs';
import * as path from 'path';

describe('preflightNpmDependencies — source-level guards', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ExecutionService.ts'),
    'utf8',
  );

  test('keys the cache on package.json mtime', () => {
    expect(src).toMatch(/pkg=\$\{stat\.mtimeMs\}/);
  });

  test('keys the cache on lockfile mtime', () => {
    expect(src).toMatch(/lock'/);
  });

  test('routes the [Install] button through executeTask (not createTerminal)', () => {
    // After the npm-install-pre-flight handler, the install path uses
    // ShellExecution + executeTask. This guard ensures we don't
    // regress to createTerminal + sendText (the rc-init-race fix).
    const idx = src.indexOf('preflightNpmDependencies');
    const after = src.slice(idx, idx + 4000);
    expect(after).toContain('vscode.ShellExecution');
    expect(after).toContain('vscode.tasks.executeTask');
    expect(after).not.toContain('createTerminal');
  });

  test('aborts the run after install starts (returns false)', () => {
    // The install branch must return false so the existing run() call
    // in ExecutionService aborts — without this, the run kicks off
    // before the install finishes and the package isn't there yet.
    const idx = src.indexOf("if (choice === 'Install')");
    const after = src.slice(idx, idx + 1000);
    expect(after).toMatch(/return false;/);
  });
});
```

(Source-level guards are how the existing repo tests pre-flight invariants — see `test/detectJdks.test.ts` for the same pattern.)

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern preflightNpm 2>&1 | tail -10`
Expected: 4 tests pass.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green.

DO NOT COMMIT.

---

## Task 6: Final integration verification

**Files:** none (verification-only)

- [ ] **Step 1: Full test suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -8`
Expected: all tests pass (target: 837 prior + ~17 new = ~854).

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

Steps in the host VS Code:
1. Open a folder with an Angular project (or any framework from the table). Add a new npm config.
2. Confirm the form shows **Detected: Angular** (or whatever) below the Script field.
3. Confirm the Script field's default is `start` (or framework convention).
4. Confirm the Port field is auto-filled with `4200` (or the framework default).
5. Save the config.
6. Delete `node_modules` if it exists (`rm -rf node_modules/`).
7. Click Run on the config.
8. Confirm the prompt: "depends on packages that aren't installed. Run `npm install` first?" with [Install] / [Run anyway] / [Cancel].
9. Click [Install] — verify it spawns a fresh Task terminal running `npm install`, no shell-init race output.
10. Wait for install to finish, click Run again. Config launches.

DO NOT COMMIT.

---

## Self-review

**Spec coverage:**
- detectNpmFramework module with priority-ordered framework specs → Task 1.
- Smarter default script per framework → Task 2.
- "Detected: X" badge in form → Task 3.
- Framework-default port pre-fill → Tasks 3 (defaultsPatch) + 4 (refactor of detectNpmPort).
- Pre-flight node_modules check with [Install] / [Run anyway] / [Cancel] → Task 5.
- Mtime-keyed cache for the pre-flight → Task 5.
- Tests called out in spec — each task includes the corresponding tests.

All spec sections covered.

**Placeholder scan:** None of the disallowed patterns ("TBD", "TODO", "implement later", "similar to Task N") appear. Task 3's `/* existing select shape — leave unchanged */` placeholder is annotation in a comment-style instruction, not an instruction-to-the-engineer to figure out the implementation themselves; it explicitly says "do not modify those parts" with an ambient context that the engineer can `grep` for.

**Type consistency:**
- `NpmFrameworkInfo` defined in Task 1 — fields `name`, `source`, `defaultScript`, `defaultPort`. Used identically in Tasks 2, 3, 4.
- `NpmFrameworkSignals` defined in Task 1 — fields `files`, `dependencies`, `scripts`, `pkgScripts`. Consumed by `detectNpmFrameworkFrom`.
- `PackageJsonInfo` extended in Task 2 with `pkgScripts` + `dependencies`; both consumed in Task 3 (`detectStreaming`) and Task 4 (`detectNpmPort`).
- `npmFramework` context key referenced in Task 3 (`getFormSchema`) and emitted in Task 3's `detectStreaming`.

Plan complete.
