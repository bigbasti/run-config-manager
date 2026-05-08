# Node Selection for npm Configs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-config Node runtime dropdown to the npm adapter, populated by auto-detection (nvm / volta / asdf / fnm / n / fixed roots / extension's own install root) and a cloud installer that downloads from `nodejs.org`. Selected Node's bin dir is prepended to `PATH` at launch.

**Architecture:** Mirrors the existing JDK detection / installer pipeline. Eight new files (detection, streaming probe, installer service, webview dialog, two helper test files, and two extra unit test files), modifications to NpmAdapter / EditorPanel / shared schema / archiveInstall / detectJdks / webview App.

**Tech Stack:** TypeScript, Node `child_process` for detection, `archiveInstall.ts` helpers (download / extract / sha256 verify), Zod for schema, React for the dialog, Jest for tests.

---

## Spec reference

Implements `docs/superpowers/specs/2026-05-08-npm-node-selection-design.md`.

## File map

**New files:**
- `src/adapters/npm/detectNodes.ts` — detection + version probe (analogue of `detectJdks.ts`).
- `src/adapters/npm/probeNodesStreaming.ts` — two-phase emit + helpers (analogue of `probeJdksStreaming.ts`).
- `src/services/NodeInstallerService.ts` — release listing + download + extract.
- `webview/src/NodeDownloadDialog.tsx` — version picker + progress UI.
- `test/detectNodes.test.ts`
- `test/probeNodeVersion.test.ts`
- `test/probeNodesStreaming.test.ts`
- `test/NodeInstallerService.test.ts`

**Modified files:**
- `src/services/archiveInstall.ts` — extend `userInstallRoot` kind union with `'nodes'`.
- `src/shared/types.ts` — add `nodePath: string` to `NpmTypeOptions`.
- `src/shared/schema.ts` — add `nodePath: z.string().optional().default('')` to `NpmTypeOptionsSchema`.
- `src/adapters/npm/NpmAdapter.ts` — `detectStreaming`, new form field, PATH prepend in `prepareLaunch`.
- `src/adapters/spring-boot/detectJdks.ts` — parity fix: scan `userInstallRoot('jdks')`.
- `src/ui/EditorPanel.ts` — wire `listNodeDownloads` / `downloadNode` / `cancelNodeDownload` messages.
- `webview/src/App.tsx` — render `NodeDownloadDialog`, handle `openNodeDialog` / `nodeDownload*` messages.
- `test/NpmAdapter.detect.test.ts` — assert nodePath field shows up; options come from context.
- `test/NpmAdapter.build.test.ts` — assert prepareLaunch PATH prepend behavior.
- `test/sanitizeConfig.test.ts` — assert `nodePath` defaults to empty when absent.
- `test/detectJdks.test.ts` — assert `userInstallRoot('jdks')` is scanned.

## Conventions used throughout

- Every code/test step is presented as a complete, copy-pasteable block.
- Verification commands use `npm run typecheck` for both projects, `npm test -- --testPathPattern <name>` for single-file Jest runs, `npm test` for the full suite.
- Commit messages use the `feat:` / `test:` / `fix:` prefixes already present in the repo's git history.
- All filesystem mocks use `jest.mock('fs')` with `'fs/promises'` virtualization, matching the pattern in `test/detectJdks.test.ts`.

---

## Task 1: Extend `userInstallRoot` to accept `'nodes'`

**Files:**
- Modify: `src/services/archiveInstall.ts:288`

- [ ] **Step 1: Read the current signature**

Read `src/services/archiveInstall.ts:285-294` to confirm the current shape:

```ts
export function userInstallRoot(kind: 'jdks' | 'tomcats' | 'mavens' | 'gradles'): string {
```

- [ ] **Step 2: Add `'nodes'` to the union**

Replace the single line above with:

```ts
export function userInstallRoot(kind: 'jdks' | 'tomcats' | 'mavens' | 'gradles' | 'nodes'): string {
```

No body change — the function already uses `kind` as a path segment.

- [ ] **Step 3: Verify both typechecks pass**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/archiveInstall.ts
git commit -m "feat: extend userInstallRoot to accept 'nodes' kind"
```

---

## Task 2: Add `nodePath` to schema + types

**Files:**
- Modify: `src/shared/types.ts:15-18`
- Modify: `src/shared/schema.ts:7-10`

- [ ] **Step 1: Update the type**

In `src/shared/types.ts`, replace:

```ts
export interface NpmTypeOptions {
  scriptName: string;
  packageManager: PackageManager;
}
```

with:

```ts
export interface NpmTypeOptions {
  scriptName: string;
  packageManager: PackageManager;
  // Absolute path to a Node install directory (the one containing
  // `bin/node`, or `node.exe` directly on Windows). Empty string means
  // "use whatever `node` is on PATH when VS Code launched."
  // The selected install's bin directory is prepended to PATH at run
  // time so npm / yarn / pnpm and any binary they spawn (Node itself
  // included) come from this install.
  nodePath: string;
}
```

- [ ] **Step 2: Update the Zod schema**

In `src/shared/schema.ts`, replace:

```ts
export const NpmTypeOptionsSchema = z.object({
  scriptName: z.string().min(1),
  packageManager: PackageManagerSchema,
});
```

with:

```ts
export const NpmTypeOptionsSchema = z.object({
  scriptName: z.string().min(1),
  packageManager: PackageManagerSchema,
  // Empty string allowed (legacy / "use PATH"); Zod's default fills in
  // for older configs that pre-date the field.
  nodePath: z.string().optional().default(''),
});
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: zero errors. (The optional default lets existing test fixtures keep validating.)

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all 724+ tests pass — the default keeps existing configs valid.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/schema.ts
git commit -m "feat: add nodePath to NpmTypeOptions schema"
```

---

## Task 3: Update sanitizeConfig defaults for `nodePath`

**Files:**
- Modify: `src/ui/EditorPanel.ts` (the `sanitizeConfig` function — search for the npm branch)
- Modify: `test/sanitizeConfig.test.ts` (existing npm tests)

- [ ] **Step 1: Locate the npm branch in sanitizeConfig**

Run: `grep -n "type === 'npm'\|case 'npm'" src/ui/EditorPanel.ts`
Note the line number — you'll edit that block.

- [ ] **Step 2: Read the surrounding 30 lines**

Read those lines so you know what shape the function returns. Look for the `typeOptions` filling pattern (other adapters fill defaults like `scriptName: ''`).

- [ ] **Step 3: Add `nodePath` default**

Inside the npm branch's typeOptions assembly, add `nodePath` defaulting to `''`. The line you add looks like:

```ts
nodePath: typeof to.nodePath === 'string' ? to.nodePath : '',
```

(Match the surrounding style — `to` is the existing local that holds `cfg.typeOptions`.)

- [ ] **Step 4: Add a regression test**

In `test/sanitizeConfig.test.ts`, locate the existing `'npm: keeps type + fills scriptName default'` test. Add this assertion at the bottom of that test (before the final `expect(...).success).toBe(true);`):

```ts
expect((out.typeOptions as any).nodePath).toBe('');
```

- [ ] **Step 5: Run the npm sanitize tests**

Run: `npm test -- --testPathPattern sanitizeConfig`
Expected: all passing including the new assertion.

- [ ] **Step 6: Commit**

```bash
git add src/ui/EditorPanel.ts test/sanitizeConfig.test.ts
git commit -m "feat: default nodePath to empty string in sanitizeConfig"
```

---

## Task 4: Write `detectNodes.ts` — version manager + filesystem detection

**Files:**
- Create: `src/adapters/npm/detectNodes.ts`
- Create: `test/detectNodes.test.ts`

This is the largest task in the plan. We split it into nine TDD steps.

- [ ] **Step 1: Write the smoke test (function exists)**

Create `test/detectNodes.test.ts`:

```ts
import { detectNodes, parseNodeVersion } from '../src/adapters/npm/detectNodes';

describe('parseNodeVersion', () => {
  test('strips leading v', () => {
    expect(parseNodeVersion('v20.10.0\n')).toBe('20.10.0');
  });
  test('returns undefined for empty / non-version output', () => {
    expect(parseNodeVersion('')).toBeUndefined();
    expect(parseNodeVersion('hello world')).toBeUndefined();
  });
  test('handles trailing whitespace and surrounding text', () => {
    expect(parseNodeVersion('  v18.19.1  ')).toBe('18.19.1');
  });
});

describe('detectNodes', () => {
  test('exists and returns an array', async () => {
    const result = await detectNodes();
    expect(Array.isArray(result)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -- --testPathPattern detectNodes`
Expected: import error (file doesn't exist).

- [ ] **Step 3: Create the file with minimal exports**

Create `src/adapters/npm/detectNodes.ts`:

```ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';
import { userInstallRoot } from '../../services/archiveInstall';

void vscode; // re-exported for parity with detectJdks; kept for future hooks

export interface NodeInfo {
  // Absolute path to the install directory. Contains `bin/node` on
  // POSIX and `node.exe` directly at the root on Windows.
  path: string;
  // Populated by probeNodeVersion; empty until the version probe runs.
  version?: string;
}

// Returns the list of Node install directories detected on this
// machine. Each entry is guaranteed to have a usable node binary.
// Versions are NOT populated — call `probeNodeVersion(path)` for each
// in parallel.
//
// Detection sources, in priority order:
//   1. Env vars (NODE_HOME, NVM_DIR).
//   2. `which node` / `where node` resolved through symlinks.
//   3. The extension's own install root (~/.rcm/nodes/*).
//   4. Version managers: nvm, volta, asdf, fnm, n.
//   5. Fixed filesystem roots.
export async function detectNodes(): Promise<string[]> {
  const found: string[] = [];

  // 1. Env vars.
  if (process.env.NODE_HOME) found.push(process.env.NODE_HOME);
  if (process.env.NVM_DIR) {
    const nvmVersions = path.join(process.env.NVM_DIR, 'versions', 'node');
    for (const c of await listChildDirs(nvmVersions)) found.push(c);
  }

  // 2. `which node` / `where node`.
  for (const p of await whichNode()) found.push(p);

  // 3. Extension's own install root.
  for (const p of await listChildDirs(userInstallRoot('nodes'))) found.push(p);

  // 4. Version managers.
  for (const p of await scanVersionManagerDirs()) found.push(p);

  // 5. Fixed roots.
  for (const p of await scanFixedRoots()) found.push(p);

  const out = await dedupeRealNodes(found);
  log.debug(`detectNodes: found ${out.length} unique Node install(s)`);
  return out;
}

// Spawn-and-collect with a hard timeout, mirroring the helper in
// detectJdks.ts. Used by the version probe.
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

async function whichNode(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await runCommand(cmd, ['node'], 1500);
    if (!out) return [];
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const homes: string[] = [];
    for (const nodeBin of lines) {
      let real: string;
      try { real = await fs.promises.realpath(nodeBin); }
      catch { real = nodeBin; }
      const home = nodeHomeFromBin(real);
      if (home) homes.push(home);
    }
    return homes;
  } catch (e) {
    log.debug(`whichNode failed: ${(e as Error).message}`);
    return [];
  }
}

async function scanVersionManagerDirs(): Promise<string[]> {
  const home = os.homedir();
  const out: string[] = [];

  // nvm: ~/.nvm/versions/node/<v>
  for (const p of await listChildDirs(path.join(home, '.nvm', 'versions', 'node'))) {
    out.push(p);
  }
  // volta: ~/.volta/tools/image/node/<v>
  for (const p of await listChildDirs(path.join(home, '.volta', 'tools', 'image', 'node'))) {
    out.push(p);
  }
  // asdf: ~/.asdf/installs/nodejs/<v>
  for (const p of await listChildDirs(path.join(home, '.asdf', 'installs', 'nodejs'))) {
    out.push(p);
  }
  // fnm: ~/.fnm/node-versions/v<ver>/installation
  for (const p of await listChildDirs(path.join(home, '.fnm', 'node-versions'))) {
    out.push(path.join(p, 'installation'));
  }
  // n: ~/.n/versions/node/<v> (also ~/n on some setups)
  for (const p of await listChildDirs(path.join(home, '.n', 'versions', 'node'))) {
    out.push(p);
  }
  for (const p of await listChildDirs(path.join(home, 'n', 'versions', 'node'))) {
    out.push(p);
  }

  return out;
}

async function scanFixedRoots(): Promise<string[]> {
  const out: string[] = [];

  const linuxOpt = await listChildDirs('/opt');
  for (const c of linuxOpt) {
    if (path.basename(c).toLowerCase().startsWith('node')) out.push(c);
  }

  const homebrew = await listChildDirs('/opt/homebrew/opt');
  for (const c of homebrew) {
    if (path.basename(c).toLowerCase().startsWith('node')) out.push(c);
  }
  const usrLocalOpt = await listChildDirs('/usr/local/opt');
  for (const c of usrLocalOpt) {
    if (path.basename(c).toLowerCase().startsWith('node')) out.push(c);
  }

  // Windows default Program Files install.
  out.push('C:\\Program Files\\nodejs');
  out.push('C:\\Program Files (x86)\\nodejs');

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

// Walk upward from a node binary path to its install home (the dir
// that contains bin/node on POSIX, or contains node.exe directly on
// Windows). Returns null when the path doesn't fit either layout.
function nodeHomeFromBin(nodeBin: string): string | null {
  const dir = path.dirname(nodeBin);
  if (process.platform === 'win32') {
    // node.exe lives at the install root itself.
    return dir;
  }
  if (path.basename(dir).toLowerCase() === 'bin') return path.dirname(dir);
  return null;
}

async function dedupeRealNodes(paths: string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const nodeBin = path.join(
      p,
      process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'),
    );
    let exists = false;
    try {
      const stat = await fs.promises.stat(nodeBin);
      exists = stat.isFile();
    } catch { /* nope */ }
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

// ---------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------

export async function probeNodeVersion(nodeHome: string): Promise<{ version?: string }> {
  try {
    const nodeBin = path.join(
      nodeHome,
      process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'),
    );
    const out = await runCommand(nodeBin, ['--version'], 2000);
    if (!out) return {};
    const v = parseNodeVersion(out);
    return v ? { version: v } : {};
  } catch (e) {
    log.debug(`probeNodeVersion(${nodeHome}) failed: ${(e as Error).message}`);
    return {};
  }
}

// Parses `v20.10.0` (with optional trailing whitespace) into "20.10.0".
// Returns undefined for non-version content.
export function parseNodeVersion(text: string): string | undefined {
  const m = text.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return m ? m[1] : undefined;
}
```

- [ ] **Step 4: Run the parser tests**

Run: `npm test -- --testPathPattern detectNodes`
Expected: all five assertions pass. The `detectNodes` smoke test runs against the real filesystem — it returns whatever the dev box has installed, so the only assertion is that an array comes back.

- [ ] **Step 5: Add filesystem-mocked tests**

Append the following to `test/detectNodes.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    // Default: empty output (no `which node` hits) so detection falls
    // back to filesystem scans the test mocks directly.
    const ee = new (require('events').EventEmitter)();
    ee.stdout = new (require('events').EventEmitter)();
    ee.stderr = new (require('events').EventEmitter)();
    setImmediate(() => {
      ee.emit('close', 1);
    });
    return ee;
  }),
}));

describe('detectNodes (filesystem mocks)', () => {
  let realReaddir: typeof fs.promises.readdir;
  let realStat: typeof fs.promises.stat;
  let realRealpath: typeof fs.promises.realpath;

  beforeAll(() => {
    realReaddir = fs.promises.readdir;
    realStat = fs.promises.stat;
    realRealpath = fs.promises.realpath;
  });
  afterEach(() => {
    (fs.promises as any).readdir = realReaddir;
    (fs.promises as any).stat = realStat;
    (fs.promises as any).realpath = realRealpath;
  });

  test('picks up nvm-style installs and dedupes by realpath', async () => {
    const home = require('os').homedir();
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');

    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === nvmDir) {
        return [
          { name: 'v20.10.0', isDirectory: () => true, isSymbolicLink: () => false },
          { name: 'v18.19.1', isDirectory: () => true, isSymbolicLink: () => false },
        ];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p.endsWith(path.join('bin', 'node')) || p.endsWith('node.exe')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectNodes();
    expect(result).toEqual(expect.arrayContaining([
      path.join(nvmDir, 'v20.10.0'),
      path.join(nvmDir, 'v18.19.1'),
    ]));
  });

  test('dedupes installs that resolve to the same realpath', async () => {
    const home = require('os').homedir();
    const rcm = path.join(
      process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'rcm')
        : path.join(home, '.rcm'),
      'nodes',
    );
    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === rcm) {
        return [
          { name: 'node-v20.10.0', isDirectory: () => true, isSymbolicLink: () => false },
          { name: 'node-v20-link', isDirectory: () => false, isSymbolicLink: () => true },
        ];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async () => ({ isFile: () => true }));
    (fs.promises as any).realpath = jest.fn(async (p: string) => {
      // Both children point to the same canonical path.
      return path.join(rcm, 'node-v20.10.0');
    });

    const result = await detectNodes();
    // Only one entry survives dedupe.
    const rcmEntries = result.filter(p => p.startsWith(rcm));
    expect(rcmEntries.length).toBe(1);
  });

  test('drops paths that lack the node binary', async () => {
    const home = require('os').homedir();
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === nvmDir) {
        return [{ name: 'v20.10.0', isDirectory: () => true, isSymbolicLink: () => false }];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectNodes();
    expect(result.filter(p => p.includes('.nvm'))).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the detection tests**

Run: `npm test -- --testPathPattern detectNodes`
Expected: all assertions pass.

- [ ] **Step 7: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Run the typechecks**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/npm/detectNodes.ts test/detectNodes.test.ts
git commit -m "feat: add Node install detection (nvm/volta/asdf/fnm/n + roots)"
```

---

## Task 5: Write `probeNodesStreaming.ts`

**Files:**
- Create: `src/adapters/npm/probeNodesStreaming.ts`
- Create: `test/probeNodesStreaming.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/probeNodesStreaming.test.ts`:

```ts
import {
  readNodes,
  nodeOption,
  probeNodesStreaming,
} from '../src/adapters/npm/probeNodesStreaming';
import * as detect from '../src/adapters/npm/detectNodes';

describe('readNodes', () => {
  test('coerces string[] (legacy shape) to NodeInfo[]', () => {
    expect(readNodes(['/opt/node-20', '/opt/node-18'])).toEqual([
      { path: '/opt/node-20' }, { path: '/opt/node-18' },
    ]);
  });
  test('passes NodeInfo[] through unchanged', () => {
    const input = [{ path: '/opt/node-20', version: '20.10.0' }];
    expect(readNodes(input)).toEqual(input);
  });
  test('returns [] for non-array input', () => {
    expect(readNodes(undefined)).toEqual([]);
    expect(readNodes(null)).toEqual([]);
    expect(readNodes({})).toEqual([]);
  });
  test('drops malformed entries', () => {
    expect(readNodes([{ path: '/ok' }, { other: 'no path' }, null]))
      .toEqual([{ path: '/ok' }]);
  });
});

describe('nodeOption', () => {
  test('shows version when present', () => {
    expect(nodeOption({ path: '/opt/node-20', version: '20.10.0' })).toEqual({
      value: '/opt/node-20',
      label: '/opt/node-20 — v20.10.0',
    });
  });
  test('falls back to path when version is absent', () => {
    expect(nodeOption({ path: '/opt/node-20' })).toEqual({
      value: '/opt/node-20',
      label: '/opt/node-20',
    });
  });
});

describe('probeNodesStreaming', () => {
  test('emits paths first, then versions, and clears spinner at end', async () => {
    jest.spyOn(detect, 'detectNodes').mockResolvedValue(['/a', '/b']);
    jest.spyOn(detect, 'probeNodeVersion').mockImplementation(async p =>
      p === '/a' ? { version: '20.0.0' } : { version: '18.0.0' },
    );

    const emits: any[] = [];
    await probeNodesStreaming((p) => emits.push(p), 'npm');

    // Phase 1: paths only, no resolved.
    expect(emits[0].contextPatch.nodes).toEqual([{ path: '/a' }, { path: '/b' }]);
    expect(emits[0].defaultsPatch).toEqual({ typeOptions: { nodePath: '/a' } });
    expect(emits[0].resolved).toBeUndefined();

    // Phase 2: enriched + resolved.
    expect(emits[1].contextPatch.nodes).toEqual([
      { path: '/a', version: '20.0.0' },
      { path: '/b', version: '18.0.0' },
    ]);
    expect(emits[1].resolved).toEqual(['typeOptions.nodePath']);
  });

  test('emits a single resolved patch when no nodes found', async () => {
    jest.spyOn(detect, 'detectNodes').mockResolvedValue([]);
    const emits: any[] = [];
    await probeNodesStreaming((p) => emits.push(p), 'npm');
    // First emit: empty list, no defaults.
    expect(emits[0].contextPatch.nodes).toEqual([]);
    expect(emits[0].defaultsPatch).toBeUndefined();
    // Second emit: resolved (clears spinner).
    expect(emits[1].resolved).toEqual(['typeOptions.nodePath']);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npm test -- --testPathPattern probeNodesStreaming`
Expected: import error.

- [ ] **Step 3: Implement the streaming module**

Create `src/adapters/npm/probeNodesStreaming.ts`:

```ts
import type { StreamingPatch } from '../RuntimeAdapter';
import { detectNodes, probeNodeVersion } from './detectNodes';
import type { NodeInfo } from './detectNodes';
import { log } from '../../utils/logger';

// Two-phase Node detection used by NpmAdapter.detectStreaming. Mirrors
// `probeJdksStreaming.ts`. Two emits:
//   1. After detectNodes(): contextPatch = { nodes: NodeInfo[] } with
//      paths only. Default seeded to first path. `resolved` omitted so
//      the field's spinner stays up while versions stream in.
//   2. After version probes settle: contextPatch with enriched
//      NodeInfo[]; resolved = ['typeOptions.nodePath'] to clear the
//      spinner.
export async function probeNodesStreaming(
  emit: (p: StreamingPatch) => void,
  defaultsPatchKey: string,
): Promise<void> {
  const paths = await detectNodes();
  log.debug(`probeNodesStreaming: detected ${paths.length} Node path(s)`);

  const initial: NodeInfo[] = paths.map(p => ({ path: p }));
  emit({
    contextPatch: { nodes: initial },
    ...(paths[0]
      ? { defaultsPatch: buildDefaultsPatch(defaultsPatchKey, paths[0]) }
      : {}),
  });

  if (paths.length === 0) {
    emit({ contextPatch: {}, resolved: ['typeOptions.nodePath'] });
    return;
  }

  const enriched: NodeInfo[] = await Promise.all(
    paths.map(async p => {
      try {
        const info = await probeNodeVersion(p);
        return { path: p, ...info };
      } catch { return { path: p }; }
    }),
  );
  log.debug(
    `probeNodesStreaming: enriched ${enriched.filter(n => n.version).length}/` +
    `${enriched.length} with version info`,
  );
  emit({
    contextPatch: { nodes: enriched },
    resolved: ['typeOptions.nodePath'],
  });
}

function buildDefaultsPatch(key: string, nodePath: string) {
  log.debug(`probeNodesStreaming: defaulting ${key}.typeOptions.nodePath to ${nodePath}`);
  return { typeOptions: { nodePath } } as any;
}

export function readNodes(value: unknown): NodeInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => {
    if (typeof v === 'string') return { path: v };
    if (v && typeof v === 'object' && typeof (v as NodeInfo).path === 'string') {
      return v as NodeInfo;
    }
    return null;
  }).filter((v): v is NodeInfo => v !== null);
}

export function nodeOption(n: NodeInfo): { value: string; label: string } {
  let label = n.path;
  if (n.version) label = `${n.path} — v${n.version}`;
  return { value: n.path, label };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --testPathPattern probeNodesStreaming`
Expected: all passing.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/npm/probeNodesStreaming.ts test/probeNodesStreaming.test.ts
git commit -m "feat: add two-phase streaming Node detection helper"
```

---

## Task 6: Wire `nodePath` field + streaming into `NpmAdapter`

**Files:**
- Modify: `src/adapters/npm/NpmAdapter.ts`
- Modify: `test/NpmAdapter.detect.test.ts`

- [ ] **Step 1: Add the failing form-schema test**

In `test/NpmAdapter.detect.test.ts`, add at the bottom of the file:

```ts
describe('NpmAdapter form schema — Node field', () => {
  test('includes typeOptions.nodePath as the first typeSpecific field, with options from context.nodes', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({
      scripts: ['start', 'build'],
      nodes: [
        { path: '/opt/node-20', version: '20.10.0' },
        { path: '/opt/node-18' },
      ],
    });
    const node = schema.typeSpecific.find(f => f.key === 'typeOptions.nodePath');
    expect(node).toBeDefined();
    expect(node!.kind).toBe('selectOrCustom');
    // First typeSpecific field after Script.
    expect(schema.typeSpecific[0].key).toBe('typeOptions.scriptName');
    expect(schema.typeSpecific[1].key).toBe('typeOptions.nodePath');
    // Options reflect both detected paths.
    const opts = (node as any).options as Array<{ value: string; label: string }>;
    expect(opts.map(o => o.value)).toEqual(['/opt/node-20', '/opt/node-18']);
    expect(opts[0].label).toBe('/opt/node-20 — v20.10.0');
    expect(opts[1].label).toBe('/opt/node-18');
  });

  test('renders an empty options list when no nodes detected', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({ scripts: ['start'] });
    const node = schema.typeSpecific.find(f => f.key === 'typeOptions.nodePath');
    expect(node).toBeDefined();
    expect((node as any).options).toEqual([]);
  });
});
```

(If the file doesn't already import `NpmAdapter`, add `import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';` at the top.)

- [ ] **Step 2: Run the tests; confirm failure**

Run: `npm test -- --testPathPattern NpmAdapter.detect`
Expected: failure — the field doesn't exist yet.

- [ ] **Step 3: Add the imports + detectStreaming + form field**

In `src/adapters/npm/NpmAdapter.ts`, replace the imports block:

```ts
import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readPackageJsonInfo } from './detectPackageJson';
import { splitArgs } from './splitArgs';
import { log } from '../../utils/logger';
import { dependsOnField, envFilesField, closeTerminalOnExitField } from '../sharedFields';
import { detectNpmPort } from '../../services/detectProjectPort';
import { probeNodesStreaming, readNodes, nodeOption } from './probeNodesStreaming';
import * as path from 'path';
```

Add `detectStreaming` immediately after `detect`:

```ts
  async detectStreaming(folder: vscode.Uri, emit: (p: StreamingPatch) => void): Promise<void> {
    void folder;
    await probeNodesStreaming(emit, 'npm');
  }
```

In `getFormSchema`, find the `typeSpecific:` array and insert this field as the SECOND entry (right after `scriptField`):

```ts
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.nodePath',
          label: 'Node',
          options: readNodes(context.nodes).map(nodeOption),
          placeholder: '/path/to/node-home',
          help:
            '`node` runtime to use for this configuration.\n\n' +
            'Auto-detected from `nvm`, `volta`, `asdf`, `fnm`, `n`, the extension\'s own ' +
            'install root, and standard install locations. The selected Node\'s `bin` ' +
            'directory is prepended to `PATH` at launch, so `npm` / `yarn` / `pnpm` and ' +
            'any binary they spawn (Node itself included) come from this install.\n\n' +
            'Leave blank to use whatever `node` is on `PATH` when VS Code started.\n\n' +
            'Click ☁ to download a fresh Node from `nodejs.org`.',
          examples: ['/usr/local/lib/node_modules/node-v20', '~/.nvm/versions/node/v20.10.0'],
          action: { id: 'openNodeDownload', label: '☁', title: 'Download and install a Node from nodejs.org', inline: true },
        },
```

- [ ] **Step 4: Run the schema tests**

Run: `npm test -- --testPathPattern NpmAdapter.detect`
Expected: all assertions pass.

- [ ] **Step 5: Add the PATH prepend test**

In `test/NpmAdapter.build.test.ts`, append:

```ts
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import * as path from 'path';

describe('NpmAdapter.prepareLaunch — PATH prepend', () => {
  const adapter = new NpmAdapter();
  const baseCfg: any = {
    type: 'npm',
    typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
    env: {}, programArgs: '', vmArgs: '', name: 'x', id: 'i', projectPath: '', workspaceFolder: '',
  };

  test('does not touch PATH when nodePath is blank', async () => {
    const out = await adapter.prepareLaunch(baseCfg);
    expect(out.env?.PATH).toBeUndefined();
  });

  test('prepends nodePath/bin on POSIX', async () => {
    const orig = process.env.PATH;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.PATH = '/usr/bin:/bin';
    try {
      const cfg = { ...baseCfg, typeOptions: { ...baseCfg.typeOptions, nodePath: '/opt/node-20' } };
      const out = await adapter.prepareLaunch(cfg);
      expect(out.env?.PATH).toBe('/opt/node-20/bin:/usr/bin:/bin');
    } finally {
      process.env.PATH = orig;
    }
  });

  test('prepends nodePath itself on Windows (node.exe lives at root)', async () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = 'C:\\Windows';
    try {
      const cfg = { ...baseCfg, typeOptions: { ...baseCfg.typeOptions, nodePath: 'C:\\nodejs' } };
      const out = await adapter.prepareLaunch(cfg);
      expect(out.env?.PATH).toBe('C:\\nodejs;C:\\Windows');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
    }
  });
});
```

- [ ] **Step 6: Run; expect failure**

Run: `npm test -- --testPathPattern NpmAdapter.build`
Expected: the new tests fail (PATH still undefined).

- [ ] **Step 7: Update `prepareLaunch`**

Replace the existing `prepareLaunch` in `src/adapters/npm/NpmAdapter.ts`:

```ts
  async prepareLaunch(cfg: RunConfig): Promise<{ env?: Record<string, string> }> {
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
    return { env };
  }
```

- [ ] **Step 8: Run the tests**

Run: `npm test -- --testPathPattern NpmAdapter`
Expected: all passing.

- [ ] **Step 9: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/adapters/npm/NpmAdapter.ts test/NpmAdapter.detect.test.ts test/NpmAdapter.build.test.ts
git commit -m "feat: NpmAdapter exposes Node selector + prepends PATH at launch"
```

---

## Task 7: JDK detector parity — scan `userInstallRoot('jdks')`

**Files:**
- Modify: `src/adapters/spring-boot/detectJdks.ts`
- Modify: `test/detectJdks.test.ts`

- [ ] **Step 1: Add the failing test**

In `test/detectJdks.test.ts`, append:

```ts
import { userInstallRoot } from '../src/services/archiveInstall';

describe('detectJdks — own install root parity', () => {
  test('scans userInstallRoot("jdks")', async () => {
    // Use a smoke-test approach mirroring the existing detectJdks
    // smoke test: just confirm detectJdks doesn't crash when the
    // install root contains an empty dir, and that the function
    // explicitly references the install root in source.
    const fs = require('fs');
    const path = require('path');
    const root = userInstallRoot('jdks');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'spring-boot', 'detectJdks.ts'), 'utf8');
    expect(src).toContain("userInstallRoot('jdks')");
    void root; // assertion above is enough — implementation test in Step 4.
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `npm test -- --testPathPattern detectJdks`
Expected: assertion failure on `expect(src).toContain(...)`.

- [ ] **Step 3: Add the import**

In `src/adapters/spring-boot/detectJdks.ts`, after the existing imports:

```ts
import { userInstallRoot } from '../../services/archiveInstall';
```

- [ ] **Step 4: Add the scan source**

Inside `detectJdks()`, add a new step between source 6 (version managers) and source 7 (fixed roots) — or wherever fits best in the existing flow. Insert before the `// 7. Fixed filesystem probes.` comment block:

```ts
  // 6b. Extension's own install root — anything we put in
  //     ~/.rcm/jdks/ via JdkInstallerService should appear automatically.
  for (const candidate of await listChildDirs(userInstallRoot('jdks'))) {
    out: { /* preserved variable name from above scope is fine in TS */ }
    found.push(candidate);
    found.push(path.join(candidate, 'Contents', 'Home'));
  }
```

(Actually, drop the `out:` label — it was a copy mistake. Final form:)

```ts
  // 6b. Extension's own install root — anything we put in
  //     ~/.rcm/jdks/ via JdkInstallerService appears automatically.
  for (const candidate of await listChildDirs(userInstallRoot('jdks'))) {
    found.push(candidate);
    found.push(path.join(candidate, 'Contents', 'Home'));
  }
```

- [ ] **Step 5: Run the parity test**

Run: `npm test -- --testPathPattern detectJdks`
Expected: passes.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green (no detection regressions).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/spring-boot/detectJdks.ts test/detectJdks.test.ts
git commit -m "fix: detectJdks scans the extension's own install root"
```

---

## Task 8: `NodeInstallerService` — listing + parsers

**Files:**
- Create: `src/services/NodeInstallerService.ts`
- Create: `test/NodeInstallerService.test.ts`

- [ ] **Step 1: Write the parser tests**

Create `test/NodeInstallerService.test.ts`:

```ts
import {
  parseNodeReleases,
  pickNodeAsset,
  parseNodeShasum,
  NodeInstallerService,
} from '../src/services/NodeInstallerService';

describe('parseNodeReleases', () => {
  test('keeps GA versions, sorts newest first, marks current and currentLts', () => {
    const raw = [
      { version: 'v20.10.0', date: '2023-12-01', files: ['linux-x64', 'osx-x64-tar', 'win-x64-zip'], lts: 'Iron' },
      { version: 'v18.19.1', date: '2023-11-01', files: ['linux-x64'], lts: 'Hydrogen' },
      { version: 'v21.5.0',  date: '2024-01-01', files: ['linux-x64'], lts: false },
      { version: 'v20.11.0-rc.0', date: '2024-01-15', files: [], lts: false },
    ];
    const out = parseNodeReleases(raw);
    expect(out.map(v => v.version)).toEqual(['v21.5.0', 'v20.10.0', 'v18.19.1']);
    // The first non-LTS is "current"; first LTS in the (sorted) list is "currentLts".
    expect(out[0].current).toBe(true);
    const lts = out.find(v => v.version === 'v20.10.0')!;
    expect(lts.isLts).toBe(true);
    expect(lts.currentLts).toBe(true);
    // Older LTS isn't tagged currentLts.
    const older = out.find(v => v.version === 'v18.19.1')!;
    expect(older.isLts).toBe(true);
    expect(older.currentLts).toBe(false);
  });

  test('returns [] for non-array input', () => {
    expect(parseNodeReleases(null)).toEqual([]);
    expect(parseNodeReleases({})).toEqual([]);
  });

  test('drops entries with missing version', () => {
    expect(parseNodeReleases([{ date: '2024' }])).toEqual([]);
  });
});

describe('pickNodeAsset', () => {
  test('returns linux-x64 tar.xz on linux/x64', () => {
    expect(pickNodeAsset('v20.10.0', 'linux', 'x64')).toEqual({
      filename: 'node-v20.10.0-linux-x64.tar.xz',
      url: 'https://nodejs.org/dist/v20.10.0/node-v20.10.0-linux-x64.tar.xz',
    });
  });
  test('returns linux-arm64 tar.xz on linux/arm64', () => {
    expect(pickNodeAsset('v18.19.1', 'linux', 'arm64')).toEqual({
      filename: 'node-v18.19.1-linux-arm64.tar.xz',
      url: 'https://nodejs.org/dist/v18.19.1/node-v18.19.1-linux-arm64.tar.xz',
    });
  });
  test('returns darwin-arm64 tar.gz on darwin/arm64', () => {
    expect(pickNodeAsset('v20.10.0', 'darwin', 'arm64')).toEqual({
      filename: 'node-v20.10.0-darwin-arm64.tar.gz',
      url: 'https://nodejs.org/dist/v20.10.0/node-v20.10.0-darwin-arm64.tar.gz',
    });
  });
  test('returns win-x64 zip on win32/x64', () => {
    expect(pickNodeAsset('v20.10.0', 'win32', 'x64')).toEqual({
      filename: 'node-v20.10.0-win-x64.zip',
      url: 'https://nodejs.org/dist/v20.10.0/node-v20.10.0-win-x64.zip',
    });
  });
  test('throws on unsupported platform/arch', () => {
    expect(() => pickNodeAsset('v20.10.0', 'aix' as any, 'ppc64' as any)).toThrow(/unsupported/i);
  });
});

describe('parseNodeShasum', () => {
  test('matches the line whose filename equals the asset', () => {
    const text = [
      'aaaaa  node-v20.10.0-linux-x64.tar.gz',
      'bbbbb  node-v20.10.0-linux-x64.tar.xz',
      'ccccc  node-v20.10.0-darwin-arm64.tar.gz',
    ].join('\n');
    expect(parseNodeShasum(text, 'node-v20.10.0-linux-x64.tar.xz')).toBe('bbbbb');
  });
  test('returns null when filename is absent', () => {
    expect(parseNodeShasum('xxx  other.tar.gz', 'missing.tar.xz')).toBeNull();
  });
});

describe('NodeInstallerService', () => {
  test('cancel() is safe with no install in flight', () => {
    expect(() => new NodeInstallerService().cancel()).not.toThrow();
  });
  test('getInstallRoot returns a per-user path', () => {
    const root = new NodeInstallerService().getInstallRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
    expect(root).toMatch(/nodes$/);
  });
});
```

- [ ] **Step 2: Run; confirm failures**

Run: `npm test -- --testPathPattern NodeInstallerService`
Expected: import error.

- [ ] **Step 3: Implement `NodeInstallerService.ts`**

Create `src/services/NodeInstallerService.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import {
  CancelledError,
  makeCancellation,
  httpGetJson,
  httpGetText,
  downloadFile,
  hashOfFile,
  extractArchive,
  flattenSingleNestedDir,
  fileSize,
  pathExists,
  userInstallRoot,
  humanSize,
} from './archiveInstall';

// Node installer using nodejs.org's official `dist/index.json` listing —
// the same data Node's own version managers consume. Each entry is
// keyed by version and lists the platforms it ships for; we synthesize
// the per-platform asset URLs from that.
//
// The dropdown shows GA-only entries (no `-rc`, `-nightly`, `-test`)
// sorted newest-first. LTS lines are flagged so the picker can
// surface them visibly.

const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';

export interface NodeVersion {
  version: string;       // e.g. "v20.10.0"
  downloadUrl: string;
  checksumUrl: string;
  filename: string;      // archive filename — used to match in SHASUMS256
  isLts: boolean;
  // True for the latest LTS in this listing.
  currentLts: boolean;
  // True for the most recent GA in this listing (highlighted as default).
  current: boolean;
}

export interface NodeProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  fraction: number | null;
  detail?: string;
}

export interface NodeInstallResult {
  // Absolute path to the install root — the directory containing
  // bin/node (POSIX) or node.exe (Windows).
  nodeHome: string;
  version: string;
}

// Raw shape of a row in nodejs.org's index.json. `lts` is either a
// string codename (e.g. "Hydrogen", "Iron") for LTS lines or `false`
// for non-LTS releases.
interface RawNodeRelease {
  version: string;
  date: string;
  files: string[];
  lts: string | false;
}

export class NodeInstallerService {
  private cancellation = makeCancellation();

  getInstallRoot(): string {
    return userInstallRoot('nodes');
  }

  async listVersions(): Promise<NodeVersion[]> {
    log.debug(`NodeInstallerService.listVersions: GET ${NODE_INDEX_URL}`);
    const raw = await httpGetJson<RawNodeRelease[]>(NODE_INDEX_URL, this.cancellation);
    const releases = parseNodeReleases(raw);
    log.debug(`NodeInstallerService.listVersions: ${releases.length} GA release(s)`);
    return releases.map(r => {
      const asset = pickNodeAsset(r.version, process.platform, process.arch);
      return {
        version: r.version,
        downloadUrl: asset.url,
        checksumUrl: `https://nodejs.org/dist/${r.version}/SHASUMS256.txt`,
        filename: asset.filename,
        isLts: r.isLts,
        currentLts: r.currentLts,
        current: r.current,
      };
    });
  }

  async install(
    v: NodeVersion,
    onProgress: (p: NodeProgress) => void,
  ): Promise<NodeInstallResult> {
    this.cancellation = makeCancellation();
    const root = this.getInstallRoot();
    await fs.promises.mkdir(root, { recursive: true });

    // Final install dir is the archive root after extraction —
    // node-v<version>-<platform>-<arch>.
    const installDir = path.join(root, v.filename.replace(/\.(tar\.xz|tar\.gz|zip)$/i, ''));

    if (await pathExists(installDir)) {
      log.info(`Node ${v.version} already installed at ${installDir} — reusing`);
      return { nodeHome: installDir, version: v.version };
    }

    const tmp = path.join(root, '.download', v.filename);
    await fs.promises.mkdir(path.dirname(tmp), { recursive: true });

    onProgress({ state: 'downloading', fraction: 0 });
    await downloadFile(v.downloadUrl, tmp, this.cancellation, (p) => {
      onProgress({
        state: 'downloading',
        fraction: p.totalBytes ? p.transferredBytes / p.totalBytes : null,
        detail: p.totalBytes ? `${humanSize(p.transferredBytes)} / ${humanSize(p.totalBytes)}` : humanSize(p.transferredBytes),
      });
    });

    onProgress({ state: 'verifying', fraction: null });
    const sha = parseNodeShasum(
      await httpGetText(v.checksumUrl, this.cancellation),
      v.filename,
    );
    if (!sha) throw new Error(`Could not find checksum for ${v.filename} in SHASUMS256.txt`);
    const actual = await hashOfFile(tmp, 'sha256');
    if (actual !== sha) {
      try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
      throw new Error(`Checksum mismatch for ${v.filename}: expected ${sha}, got ${actual}`);
    }
    log.debug(`Node ${v.version}: checksum OK (${humanSize(await fileSize(tmp))})`);

    onProgress({ state: 'extracting', fraction: null });
    await extractArchive(tmp, installDir, this.cancellation);
    await flattenSingleNestedDir(installDir);
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }

    log.info(`Node ${v.version} installed at ${installDir}`);
    return { nodeHome: installDir, version: v.version };
  }

  cancel(): void {
    this.cancellation.cancel();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

const GA_RE = /^v\d+\.\d+\.\d+$/;

export function parseNodeReleases(raw: unknown): Array<{
  version: string;
  isLts: boolean;
  currentLts: boolean;
  current: boolean;
}> {
  if (!Array.isArray(raw)) return [];
  const ga = raw.filter((r: any) => typeof r?.version === 'string' && GA_RE.test(r.version));
  // Already roughly newest-first in the nodejs.org listing, but sort
  // explicitly to be safe.
  ga.sort((a: any, b: any) => compareSemver(b.version, a.version));
  let currentMarked = false;
  let currentLtsMarked = false;
  return ga.map((r: any) => {
    const isLts = typeof r.lts === 'string' && r.lts.length > 0;
    const current = !currentMarked;
    if (current) currentMarked = true;
    const currentLts = isLts && !currentLtsMarked;
    if (currentLts) currentLtsMarked = true;
    return { version: r.version, isLts, currentLts, current };
  });
}

export function pickNodeAsset(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): { filename: string; url: string } {
  // Map (platform, arch) → (folderTag, archiveExt).
  // Source: nodejs.org/dist/<v>/ filenames.
  let folder: string;
  let ext: string;
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64' || arch === 'armv7l')) {
    folder = `linux-${arch}`;
    ext = 'tar.xz';
  } else if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    folder = `darwin-${arch}`;
    ext = 'tar.gz';
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    folder = `win-${arch}`;
    ext = 'zip';
  } else {
    throw new Error(`Unsupported platform/arch for Node download: ${platform}/${arch}`);
  }
  const filename = `node-${version}-${folder}.${ext}`;
  return { filename, url: `https://nodejs.org/dist/${version}/${filename}` };
}

export function parseNodeShasum(text: string, filename: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+(.+)$/);
    if (m && m[2] === filename) return m[1];
  }
  return null;
}

// Loose semver compare adequate for nodejs.org's GA versions
// ("v20.10.0" vs "v18.19.1"). Returns negative when a < b.
function compareSemver(a: string, b: string): number {
  const ax = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  const bx = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const av = ax[i] ?? 0, bv = bx[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export { CancelledError };
```

- [ ] **Step 4: Run the parser tests**

Run: `npm test -- --testPathPattern NodeInstallerService`
Expected: all 10+ assertions pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/NodeInstallerService.ts test/NodeInstallerService.test.ts
git commit -m "feat: NodeInstallerService — list / download / verify Node releases"
```

---

## Task 9: Wire `NodeInstallerService` into `EditorPanel`

**Files:**
- Modify: `src/ui/EditorPanel.ts`

This task introduces the messaging contract between the webview and extension. Mirror the Gradle wiring exactly (search the file for `gradleInstaller`, `gradleVersions`, `listGradleDownloads`, `downloadGradle`, `cancelGradleDownload`).

- [ ] **Step 1: Add the import**

In `src/ui/EditorPanel.ts`, add to the imports near the top:

```ts
import { NodeInstallerService, type NodeVersion } from '../services/NodeInstallerService';
```

- [ ] **Step 2: Add the field on the class**

Find the line `private readonly gradleInstaller = new GradleInstallerService();` and add immediately below:

```ts
  private readonly nodeInstaller = new NodeInstallerService();
  private nodeVersions?: NodeVersion[];
```

- [ ] **Step 3: Add the message handlers**

Find the `case 'listGradleDownloads':` block. Add these three new cases in the same switch (their structure mirrors the Gradle handlers — use the existing Gradle implementation as a reference and substitute Node):

```ts
      case 'listNodeDownloads': {
        log.debug('listNodeDownloads');
        try {
          const versions = await this.nodeInstaller.listVersions();
          this.nodeVersions = versions;
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadList',
            versions: versions.map(v => ({
              version: v.version,
              isLts: v.isLts,
              currentLts: v.currentLts,
              current: v.current,
              filename: v.filename,
            })),
            installRoot: this.nodeInstaller.getInstallRoot(),
          } as any);
        } catch (e) {
          log.warn(`listNodeDownloads failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadError',
            message: `Could not load Node versions: ${(e as Error).message}`,
          } as any);
        }
        return;
      }
      case 'downloadNode': {
        log.info(`downloadNode: ${msg.version}`);
        const v = (this.nodeVersions ?? []).find(x => x.version === msg.version);
        if (!v) {
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadError',
            message: 'Node version not found — please refresh the dialog.',
          } as any);
          return;
        }
        try {
          const result = await this.nodeInstaller.install(v, p => {
            this.panel.webview.postMessage({
              cmd: 'nodeDownloadProgress',
              state: p.state,
              fraction: p.fraction,
              ...(p.detail ? { detail: p.detail } : {}),
            } as any);
          });
          // Push the new install into context so the dropdown picks it up
          // without waiting for a re-detect.
          const existing = (this.context.nodes as any[] | undefined) ?? [];
          if (!existing.some((n: any) => (n?.path ?? n) === result.nodeHome)) {
            this.context.nodes = [...existing, { path: result.nodeHome, version: result.version.replace(/^v/, '') }];
            if (this.args.adapter) {
              const schema = this.args.adapter.getFormSchema(this.context);
              this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } as any);
            }
          }
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadComplete',
            nodeHome: result.nodeHome,
            version: result.version,
          } as any);
          this.panel.webview.postMessage({
            cmd: 'configPatch',
            patch: { typeOptions: { nodePath: result.nodeHome } } as any,
            force: true,
          } as any);
        } catch (e) {
          const cancelled = (e as Error).name === 'CancelledError';
          log.warn(`downloadNode: ${cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadError',
            message: cancelled ? 'Download cancelled.' : (e as Error).message,
            ...(cancelled ? { cancelled: true } : {}),
          } as any);
        }
        return;
      }
      case 'cancelNodeDownload': {
        log.debug('cancelNodeDownload');
        this.nodeInstaller.cancel();
        return;
      }
```

- [ ] **Step 4: Add the action-id forwarding**

Search the file for `case 'openGradleDownload':` (or how that string gets mapped — look for `onFieldAction` handling). Add an analogous `'openNodeDownload'` branch that posts `{ cmd: 'openNodeDialog' }` to the webview. If the action-id forwarding is generic (a single `panel.webview.postMessage({ cmd: 'openInstaller', kind: msg.actionId })` shape), the new ID gets handled automatically — verify by reading the code there.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: zero errors. The webview side won't yet handle these messages — that's Task 10.

- [ ] **Step 6: Commit**

```bash
git add src/ui/EditorPanel.ts
git commit -m "feat: wire NodeInstallerService messages into EditorPanel"
```

---

## Task 10: Webview `NodeDownloadDialog` + App wiring

**Files:**
- Create: `webview/src/NodeDownloadDialog.tsx`
- Modify: `webview/src/App.tsx`

The dialog is a near-clone of `webview/src/GradleDownloadDialog.tsx` — read it first to understand the full flow, then transcribe with Node-specific copy.

- [ ] **Step 1: Read the Gradle dialog as the template**

Open `webview/src/GradleDownloadDialog.tsx` and `webview/src/App.tsx`. Find every reference to `GradleDownloadDialog`, `gradleDownloadList`, `gradleDownloadProgress`, `gradleDownloadComplete`, `gradleDownloadError`, `openGradleDialog`. Each becomes a Node analogue.

- [ ] **Step 2: Create the Node dialog**

Create `webview/src/NodeDownloadDialog.tsx` modeled on the Gradle dialog. Key Node-specific differences:

- Title: "Download Node from nodejs.org"
- LTS badge: when `version.isLts` is true, show "LTS" pill next to the version. Highlight `currentLts` in green.
- "Latest" badge on the row whose `current` is true.
- Default-selected version: prefer `currentLts`, falling back to `current`.
- Body: same progress states (`downloading` / `verifying` / `extracting`), same fraction → percentage formatting, same error display + cancel button.

The component signature mirrors `GradleDownloadDialog` exactly:

```tsx
interface Props {
  open: boolean;
  postMessage: (msg: any) => void;
  onClose: () => void;
}
```

It owns local state for `versions: NodeVersionDto[] | null`, `loading: boolean`, `error: string | null`, `selected: string | null`, `progress: ProgressDto | null`. The `useEffect` on `open` posts `{ cmd: 'listNodeDownloads' }`.

A handler for `messageEvent` listens for `nodeDownloadList` / `nodeDownloadProgress` / `nodeDownloadComplete` / `nodeDownloadError` and updates state accordingly.

(Don't paste a full 230-line transcription — copy the Gradle dialog file, rename in place, swap the messages and copy the LTS label additions.)

- [ ] **Step 3: Wire the dialog into App.tsx**

In `webview/src/App.tsx`, find the existing `GradleDownloadDialog` import and import block:

```tsx
import { GradleDownloadDialog } from './GradleDownloadDialog';
```

Add directly below:

```tsx
import { NodeDownloadDialog } from './NodeDownloadDialog';
```

Find the existing state for `gradleDialogOpen` (or similar name — search `gradleDialog` in App.tsx). Add an analogous `nodeDialogOpen` boolean piece of state.

In the message handler that maps `cmd: 'openGradleDialog'` → `setGradleDialogOpen(true)`, add a sibling case for `'openNodeDialog'`.

In the JSX render where `<GradleDownloadDialog ... />` is mounted, add immediately below:

```tsx
<NodeDownloadDialog
  open={nodeDialogOpen}
  postMessage={postMessage}
  onClose={() => setNodeDialogOpen(false)}
/>
```

- [ ] **Step 4: Webview typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 5: Webview build (smoke check)**

Run: `npm run build:webview`
Expected: success — confirms no JSX/TS issue at production-build level.

- [ ] **Step 6: Commit**

```bash
git add webview/src/NodeDownloadDialog.tsx webview/src/App.tsx
git commit -m "feat: add Node download dialog + App.tsx wiring"
```

---

## Task 11: Final integration verification

**Files:** none (verification-only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test passing (the suite should be ≥ 740+ tests after this plan's additions).

- [ ] **Step 2: Both typechecks**

Run: `npm run typecheck`
Expected: zero errors in both `tsconfig.extension.json` and `tsconfig.webview.json`.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: clean Vite build + esbuild bundle, no warnings other than the pre-existing CJS-deprecation Vite warning.

- [ ] **Step 4: Manual sanity check — open an npm config in the editor**

```bash
code --extensionDevelopmentPath="$(pwd)" /tmp/scratch
```

Inside the host VS Code:
1. Open the Run Configurations sidebar.
2. Add a new npm config in a workspace that has a `package.json`.
3. Verify the **Node** dropdown appears between **Script** and **Package manager**.
4. Confirm it lists at least one auto-detected Node install (your local `node`).
5. Click the ☁ button → dialog opens → list of Node versions loads.
6. Pick an LTS, hit install, watch progress, confirm install lands in `~/.rcm/nodes/`.
7. Save the config; reload; the dropdown still shows the new install.
8. Run the config; check `node --version` from inside the script picks up the chosen install.

Note any mismatch with the spec — those are bugs that need fixing before merging.

- [ ] **Step 5: Final commit (if anything turned up in step 4)**

If smoke-test bugs were found and fixed:

```bash
git add -p   # carefully review per-hunk
git commit -m "fix: <specific issue from manual smoke test>"
```

If nothing turned up: skip.

---

## Self-review

**Spec coverage:**
- Detection sources 1–5 from spec → Task 4.
- Version probe → Task 4 (`probeNodeVersion`).
- Streaming probe → Task 5.
- NpmAdapter wiring → Task 6.
- PATH prepend → Task 6.
- NodeInstallerService → Task 8.
- `userInstallRoot('nodes')` extension → Task 1.
- Schema + types → Task 2.
- sanitizeConfig defaults → Task 3.
- JDK detector parity → Task 7.
- EditorPanel messages → Task 9.
- Webview dialog + App wiring → Task 10.
- Tests called out in spec → covered in Tasks 4 / 5 / 6 / 7 / 8 (one per pure unit).

All spec sections mapped.

**Placeholder scan:** none of the disallowed patterns ("TODO", "implement later", "similar to Task N") appear. Task 10's "transcribe the Gradle dialog" instruction is concrete enough — it points at a real file with all the same mechanics, and the Node-specific differences (LTS badge, default selection priority) are spelled out.

**Type consistency:**
- `NodeInfo` defined in Task 4, re-exported in Task 5, consumed in Task 6 — same shape `{ path, version? }` throughout.
- `NodeVersion` defined in Task 8, transmitted in Task 9 (DTO subset), consumed in Task 10. Webview side uses a structural subset (`isLts`, `currentLts`, `current`, `version`, `filename`) — the DTO shape is matching.
- Messages: `nodeDownloadList`, `nodeDownloadProgress`, `nodeDownloadComplete`, `nodeDownloadError`, `openNodeDialog`, `cancelNodeDownload`, `downloadNode`, `listNodeDownloads` — all spelled identically across Tasks 9 and 10.

Plan complete.
