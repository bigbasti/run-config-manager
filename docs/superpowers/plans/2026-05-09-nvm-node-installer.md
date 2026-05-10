# nvm-aware Node Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `nvm` is detected on a POSIX host, route the Node download dialog through `nvm install <version>` instead of the standalone tarball download. Detection-only on Windows; the dialog falls back to the existing tarball flow there.

**Architecture:** Two new modules — a tiny `detectNvm` probe and a `NvmInstallerService` that spawns `bash -c '. nvm.sh && nvm install <ver>'` and streams its output. EditorPanel detects nvm once per `listNodeDownloads`, forwards an `installerKind` flag to the webview, and routes `downloadNode` to the matching installer. Dialog adds a small "via nvm" badge and a one-line live-output progress UI when nvm is in use. No changes to user-facing config — `nodePath` still stores an absolute path that detection already finds.

**Tech Stack:** TypeScript, Node `child_process` (spawn bash with `-c`), VS Code webview message protocol, Jest, React for the dialog.

---

## Spec reference

Implements `docs/superpowers/specs/2026-05-09-nvm-node-installer-design.md`.

## File map

**New files:**
- `src/adapters/npm/detectNvm.ts` — POSIX-only nvm.sh detection.
- `src/services/NvmInstallerService.ts` — bash subshell + `nvm install`, streaming output.
- `test/detectNvm.test.ts`
- `test/NvmInstallerService.test.ts`

**Modified files:**
- `src/shared/protocol.ts` — add `installerKind` to `nodeDownloadList`; add `'installing'` to `nodeDownloadProgress.state`.
- `src/ui/EditorPanel.ts` — detect nvm in `listNodeDownloads`, branch in `downloadNode`, branch in `cancelNodeDownload`.
- `webview/src/NodeDownloadDialog.tsx` — read `installerKind`, render "via nvm" badge, route progress copy.
- `webview/src/App.tsx` — pass `installerKind` to the dialog (already plumbed via the existing `nodeDownloadList` handler — just include the field).
- `src/adapters/npm/NpmAdapter.ts` — extend the Node-field help text with a one-line nvm note.

## Conventions used throughout

- Every code/test step is a complete copy-pasteable block.
- Verification: `npm run typecheck`, `npm test`, `npm run build:webview`.
- **No commits per the user's instruction** — the final "Commit" step in each task is replaced with verification only.
- Tests use the existing `jest.mock('child_process')` pattern from `test/detectNodes.test.ts` and the spawn-mock pattern from `test/NodeInstallerService.test.ts`.

---

## Task 1: Schema — add installerKind + 'installing' progress state

**Files:**
- Modify: `src/shared/protocol.ts:267-277`

- [ ] **Step 1: Read the current Node messages**

Open `src/shared/protocol.ts` lines 267-279. Confirm the current shape:

```ts
  | {
      cmd: 'nodeDownloadList';
      versions: NodeVersionDto[];
      installRoot: string;
    }
  | {
      cmd: 'nodeDownloadProgress';
      state: 'downloading' | 'verifying' | 'extracting';
      fraction: number | null;
      detail?: string;
    }
```

- [ ] **Step 2: Replace those two messages with the extended versions**

```ts
  | {
      cmd: 'nodeDownloadList';
      versions: NodeVersionDto[];
      // For 'nvm', the path the dialog displays is NVM_DIR; for 'download',
      // it's userInstallRoot('nodes'). Both are absolute paths.
      installRoot: string;
      // Tells the dialog which installer is in flight. Set per-call by
      // EditorPanel after running detectNvm() at list-fetch time.
      installerKind: 'nvm' | 'download';
    }
  | {
      cmd: 'nodeDownloadProgress';
      // 'installing' is used by the nvm path (single-phase, with a
      // live-output detail string). The other three are emitted by
      // the standalone-download path.
      state: 'downloading' | 'verifying' | 'extracting' | 'installing';
      fraction: number | null;
      detail?: string;
    }
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

Expected: zero errors. (Existing usages of these two messages — `EditorPanel.ts` and `NodeDownloadDialog.tsx` — are still type-correct because the unions widened, not narrowed.)

- [ ] **Step 4: Run full test suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`

Expected: 756 passing.

- [ ] **Step 5: Verify (no commit per user instruction)**

Confirm the diff is just the two message additions:
`git diff src/shared/protocol.ts`

---

## Task 2: detectNvm — POSIX-only nvm.sh probe

**Files:**
- Create: `src/adapters/npm/detectNvm.ts`
- Create: `test/detectNvm.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/detectNvm.test.ts`:

```ts
import { detectNvm } from '../src/adapters/npm/detectNvm';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('detectNvm', () => {
  let savedNvmDir: string | undefined;
  let savedPlatform: NodeJS.Platform;

  beforeEach(() => {
    savedNvmDir = process.env.NVM_DIR;
    savedPlatform = process.platform;
    delete process.env.NVM_DIR;
  });

  afterEach(() => {
    if (savedNvmDir === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = savedNvmDir;
    Object.defineProperty(process, 'platform', { value: savedPlatform });
    jest.restoreAllMocks();
  });

  test('returns available=false on Windows without checking the filesystem', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const statSpy = jest.spyOn(fs.promises, 'stat');
    const result = await detectNvm();
    expect(result).toEqual({ available: false });
    expect(statSpy).not.toHaveBeenCalled();
  });

  test('uses NVM_DIR/nvm.sh when env var is set and file exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.NVM_DIR = '/custom/nvm';
    jest.spyOn(fs.promises, 'stat').mockImplementation(async (p: any) => {
      if (p === path.join('/custom/nvm', 'nvm.sh')) return { isFile: () => true } as any;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectNvm();
    expect(result).toEqual({
      available: true,
      nvmDir: '/custom/nvm',
      nvmShPath: path.join('/custom/nvm', 'nvm.sh'),
    });
  });

  test('falls back to ~/.nvm/nvm.sh when NVM_DIR is unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const home = os.homedir();
    const expectedDir = path.join(home, '.nvm');
    const expectedSh = path.join(expectedDir, 'nvm.sh');
    jest.spyOn(fs.promises, 'stat').mockImplementation(async (p: any) => {
      if (p === expectedSh) return { isFile: () => true } as any;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectNvm();
    expect(result).toEqual({
      available: true,
      nvmDir: expectedDir,
      nvmShPath: expectedSh,
    });
  });

  test('returns available=false when nvm.sh is absent at every probe location', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.NVM_DIR = '/custom/nvm';
    jest.spyOn(fs.promises, 'stat').mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectNvm();
    expect(result).toEqual({ available: false });
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectNvm 2>&1 | tail -10`

Expected: import error.

- [ ] **Step 3: Implement `detectNvm.ts`**

Create `src/adapters/npm/detectNvm.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface NvmInstall {
  available: boolean;
  // Absolute path to NVM_DIR (the directory containing nvm.sh).
  // Only populated when available === true.
  nvmDir?: string;
  // Absolute path to nvm.sh inside nvmDir. Only populated when available === true.
  nvmShPath?: string;
}

// POSIX-only nvm probe. Resolution order:
//   1. $NVM_DIR/nvm.sh, if NVM_DIR is set and the file exists.
//   2. $HOME/.nvm/nvm.sh, the standard install location.
// Returns { available: false } on Windows or if neither location resolves.
//
// Two fs.stat calls in the worst case. Cheap enough to call on every
// dialog open — no caching needed at this layer.
export async function detectNvm(): Promise<NvmInstall> {
  if (process.platform === 'win32') {
    // nvm-windows is a separate tool with a different binary and command
    // surface. Out of scope for this detector — Windows users get the
    // standalone tarball download path instead.
    return { available: false };
  }

  const candidates: string[] = [];
  if (process.env.NVM_DIR) candidates.push(process.env.NVM_DIR);
  candidates.push(path.join(os.homedir(), '.nvm'));

  for (const dir of candidates) {
    const sh = path.join(dir, 'nvm.sh');
    if (await isFile(sh)) {
      return { available: true, nvmDir: dir, nvmShPath: sh };
    }
  }
  return { available: false };
}

async function isFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern detectNvm 2>&1 | tail -10`

Expected: all 4 tests pass.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: 760 passing (756 + 4 new).

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

- [ ] **Step 6: Verify (no commit)**

`git diff src/adapters/npm/detectNvm.ts test/detectNvm.test.ts`

---

## Task 3: NvmInstallerService — bash subshell + streaming nvm install

**Files:**
- Create: `src/services/NvmInstallerService.ts`
- Create: `test/NvmInstallerService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/NvmInstallerService.test.ts`:

```ts
import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  NvmInstallerService,
  parseNvmVersion,
} from '../src/services/NvmInstallerService';

jest.mock('child_process');

describe('parseNvmVersion', () => {
  test('strips leading v', () => {
    expect(parseNvmVersion('v20.10.0')).toBe('20.10.0');
  });
  test('passes plain semver through', () => {
    expect(parseNvmVersion('18.19.1')).toBe('18.19.1');
  });
  test('trims surrounding whitespace', () => {
    expect(parseNvmVersion('  v22.3.0  ')).toBe('22.3.0');
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
  kill: jest.Mock;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = jest.fn();
  return child;
}

describe('NvmInstallerService', () => {
  let spawnMock: jest.MockedFunction<typeof cp.spawn>;
  let statSpy: jest.SpiedFunction<typeof fs.promises.stat>;

  beforeEach(() => {
    spawnMock = cp.spawn as unknown as jest.MockedFunction<typeof cp.spawn>;
    spawnMock.mockReset();
    // Default: bin/node exists after install.
    statSpy = jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('spawns bash -c "<source nvm.sh> && nvm install <version>"', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const onProgress = jest.fn();
    const promise = svc.install('v20.10.0', onProgress);

    // Simulate nvm completing successfully after a couple of progress lines.
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('Downloading and installing node v20.10.0...\n'));
      child.stderr.emit('data', Buffer.from('Computing checksum...\n'));
      child.emit('close', 0);
    });

    const result = await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('bash');
    expect(args).toEqual(['-c', '. "/home/u/.nvm/nvm.sh" && nvm install 20.10.0']);

    expect(onProgress).toHaveBeenCalledWith({
      state: 'installing',
      detail: 'Downloading and installing node v20.10.0...',
    });
    expect(onProgress).toHaveBeenCalledWith({
      state: 'installing',
      detail: 'Computing checksum...',
    });
    expect(result).toEqual({
      nodeHome: path.join('/home/u/.nvm', 'versions', 'node', 'v20.10.0'),
      version: 'v20.10.0',
    });
  });

  test('throws with the last lines of output on non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const promise = svc.install('20.10.0', () => {});

    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('curl: (22) The requested URL returned error: 404\n'));
      child.stderr.emit('data', Buffer.from('nvm: install 20.10.0 failed!\n'));
      child.emit('close', 5);
    });

    await expect(promise).rejects.toThrow(/exit 5/);
    await expect(promise).rejects.toThrow(/install 20.10.0 failed/);
  });

  test('throws when bin/node is missing after a "successful" install', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    statSpy.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const promise = svc.install('v20.10.0', () => {});
    setImmediate(() => {
      child.emit('close', 0);
    });

    await expect(promise).rejects.toThrow(/no node binary/i);
  });

  test('cancel() sends SIGTERM and the install rejects with CancelledError', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const promise = svc.install('20.10.0', () => {});

    // Wait one tick so the spawn handler has wired up event listeners.
    await new Promise(setImmediate);
    svc.cancel();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate the child eventually exiting after the signal.
    child.emit('close', 143); // SIGTERM exit code

    await expect(promise).rejects.toThrow(/cancel/i);
  });

  test('cancel() is safe with no install in flight', () => {
    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    expect(() => svc.cancel()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern NvmInstallerService 2>&1 | tail -10`

Expected: import error.

- [ ] **Step 3: Implement `NvmInstallerService.ts`**

Create `src/services/NvmInstallerService.ts`:

```ts
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import { CancelledError } from './archiveInstall';

export interface NvmProgress {
  state: 'installing';
  // The most-recent line of nvm output. The dialog renders this directly
  // under "Installing via nvm".
  detail: string;
}

export interface NvmInstallResult {
  // Absolute path to the install dir (contains bin/node).
  // Same shape detection produces, so the form's dropdown picks it
  // up via the existing nvm version-manager scan.
  nodeHome: string;
  // The version label exactly as nvm reports it, with the leading 'v'.
  // Matches what the user picked in the dropdown.
  version: string;
}

// Drives `nvm install <version>` through a bash subshell that sources
// nvm.sh first. nvm is a shell function, not a binary — we can't call
// it directly via child_process.spawn. Streaming stdout/stderr line-by-
// line lets the dialog show what nvm is doing in real time (downloading,
// computing checksums, building, etc.).
//
// POSIX only — Windows nvm-windows is a different tool. Constructor
// inputs come from detectNvm().
export class NvmInstallerService {
  private child: cp.ChildProcess | undefined;
  private cancelled = false;
  // Last few lines of output, kept for failure-message construction.
  private readonly tail: string[] = [];
  private static readonly TAIL_LIMIT = 8;

  constructor(
    private readonly nvmDir: string,
    private readonly nvmShPath: string,
  ) {}

  async install(version: string, onProgress: (p: NvmProgress) => void): Promise<NvmInstallResult> {
    const normalized = parseNvmVersion(version);
    // Constructed-here string — no user-controlled shell injection
    // because `version` is constrained by the dropdown to nodejs.org's
    // semver shape and we strip the 'v' before splicing.
    const script = `. "${this.nvmShPath}" && nvm install ${normalized}`;
    log.info(`NvmInstallerService.install: bash -c '${script}'`);

    return new Promise<NvmInstallResult>((resolve, reject) => {
      this.cancelled = false;
      this.tail.length = 0;

      const child = cp.spawn('bash', ['-c', script], { windowsHide: true });
      this.child = child;

      let stdoutBuf = '';
      let stderrBuf = '';

      const flushLines = (chunk: string, side: 'out' | 'err'): void => {
        const buf = side === 'out' ? stdoutBuf + chunk : stderrBuf + chunk;
        const lines = buf.split('\n');
        // Last fragment is the (possibly partial) trailing line.
        const trailing = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.replace(/\r$/, '');
          if (!trimmed) continue;
          this.tail.push(trimmed);
          if (this.tail.length > NvmInstallerService.TAIL_LIMIT) this.tail.shift();
          try { onProgress({ state: 'installing', detail: trimmed }); }
          catch { /* swallow — progress is best-effort */ }
        }
        if (side === 'out') stdoutBuf = trailing;
        else stderrBuf = trailing;
      };

      child.stdout?.on('data', (b: Buffer) => flushLines(b.toString('utf8'), 'out'));
      child.stderr?.on('data', (b: Buffer) => flushLines(b.toString('utf8'), 'err'));

      child.on('error', (e) => {
        this.child = undefined;
        reject(e);
      });

      child.on('close', (code) => {
        this.child = undefined;
        if (this.cancelled) {
          reject(new CancelledError('nvm install cancelled'));
          return;
        }
        if (code !== 0) {
          const tail = this.tail.join('\n');
          reject(new Error(`nvm install failed (exit ${code}): ${tail}`));
          return;
        }
        // Compute the install path — nvm's standard layout.
        const nodeHome = path.join(this.nvmDir, 'versions', 'node', `v${normalized}`);
        const nodeBin = path.join(nodeHome, 'bin', 'node');
        fs.promises.stat(nodeBin).then(() => {
          resolve({ nodeHome, version: `v${normalized}` });
        }).catch(() => {
          reject(new Error(
            `nvm reported success but no node binary at ${nodeBin}. ` +
            `Last output:\n${this.tail.join('\n')}`,
          ));
        });
      });
    });
  }

  cancel(): void {
    if (!this.child) return;
    this.cancelled = true;
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    // 3-second grace period, then SIGKILL. Matches RunTerminal.kill semantics.
    const child = this.child;
    setTimeout(() => {
      if (!child.exitCode && child.exitCode !== 0) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3000).unref?.();
  }
}

// Strips a leading 'v' and trims whitespace. Exported for unit tests.
// Input examples: 'v20.10.0' → '20.10.0'; '18.19.1' → '18.19.1'.
export function parseNvmVersion(input: string): string {
  return input.trim().replace(/^v/, '');
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern NvmInstallerService 2>&1 | tail -15`

Expected: all 8 tests pass (3 parser + 5 service).

- [ ] **Step 5: Run full suite + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: 768 passing (760 + 8 new).

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

- [ ] **Step 6: Verify (no commit)**

`git diff src/services/NvmInstallerService.ts test/NvmInstallerService.test.ts`

---

## Task 4: EditorPanel routing — detect once, branch on installerKind

**Files:**
- Modify: `src/ui/EditorPanel.ts`

The current code only ever calls `NodeInstallerService`. After this task, `listNodeDownloads` runs `detectNvm()` and stores the result; `downloadNode` and `cancelNodeDownload` branch on it.

- [ ] **Step 1: Add the imports**

In `src/ui/EditorPanel.ts`, find the import for `NodeInstallerService` (around line 25) and add directly below:

```ts
import { NvmInstallerService } from '../services/NvmInstallerService';
import { detectNvm, type NvmInstall } from '../adapters/npm/detectNvm';
```

- [ ] **Step 2: Add the cached state**

Find the existing `nodeVersions` field (around line 85) and add immediately after:

```ts
  // Result of detectNvm() captured during the most recent
  // listNodeDownloads. downloadNode reads this to decide whether to
  // route through nvm or the standalone tarball installer.
  private nvmInstall: NvmInstall | undefined;
  // Held for cancel(): set to NvmInstallerService when an nvm install
  // is in flight, undefined otherwise. Standalone downloads cancel via
  // the persistent NodeInstallerService.cancel(), unchanged.
  private activeNvmInstaller: NvmInstallerService | undefined;
```

- [ ] **Step 3: Update `listNodeDownloads` to detect nvm and forward installerKind**

Replace the existing `case 'listNodeDownloads':` block (around lines 1070-1088) with:

```ts
      case 'listNodeDownloads': {
        log.debug('listNodeDownloads');
        try {
          const versions = await this.nodeInstaller.listVersions();
          this.nodeVersions = versions;
          this.nvmInstall = await detectNvm();
          const installerKind: 'nvm' | 'download' = this.nvmInstall.available ? 'nvm' : 'download';
          // When nvm is available, show the user where nvm will land
          // the install (NVM_DIR). When falling back to standalone, show
          // the extension's install root.
          const installRoot = this.nvmInstall.available
            ? this.nvmInstall.nvmDir!
            : this.nodeInstaller.getInstallRoot();
          log.info(`listNodeDownloads: installerKind=${installerKind}, installRoot=${installRoot}`);
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadList',
            versions: versions.map(toNodeDto),
            installRoot,
            installerKind,
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listNodeDownloads failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadError',
            message: `Could not load Node versions: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
```

- [ ] **Step 4: Branch the `downloadNode` handler**

Replace the existing `case 'downloadNode':` block (around lines 1089-1141) with:

```ts
      case 'downloadNode': {
        log.info(`downloadNode: ${msg.version}`);
        const v = (this.nodeVersions ?? []).find(x => x.version === msg.version);
        if (!v) {
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadError',
            message: 'Node version not found — please refresh the dialog.',
          } satisfies Inbound);
          return;
        }
        try {
          // Route to the right installer based on the cached detect.
          let result: { nodeHome: string; version: string };
          if (this.nvmInstall?.available) {
            const svc = new NvmInstallerService(
              this.nvmInstall.nvmDir!,
              this.nvmInstall.nvmShPath!,
            );
            this.activeNvmInstaller = svc;
            try {
              result = await svc.install(v.version, p => {
                this.panel.webview.postMessage({
                  cmd: 'nodeDownloadProgress',
                  state: 'installing',
                  fraction: null,
                  detail: p.detail,
                } satisfies Inbound);
              });
            } finally {
              this.activeNvmInstaller = undefined;
            }
          } else {
            result = await this.nodeInstaller.install(v, p => {
              this.panel.webview.postMessage({
                cmd: 'nodeDownloadProgress',
                state: p.state,
                fraction: p.fraction,
                ...(p.detail ? { detail: p.detail } : {}),
              } satisfies Inbound);
            });
          }

          // Push the new install into context so the dropdown picks
          // it up without a re-detect. Same shape regardless of installer.
          const existing = (this.context.nodes as Array<{ path: string; version?: string }> | undefined) ?? [];
          if (!existing.some(n => n.path === result.nodeHome)) {
            this.context.nodes = [
              ...existing,
              { path: result.nodeHome, version: result.version.replace(/^v/, '') },
            ];
            if (this.args.adapter) {
              const schema = this.args.adapter.getFormSchema(this.context);
              this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
            }
          }
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadComplete',
            nodeHome: result.nodeHome,
            version: result.version,
          } satisfies Inbound);
          this.panel.webview.postMessage({
            cmd: 'configPatch',
            patch: { typeOptions: { nodePath: result.nodeHome } } as any,
            force: true,
          } satisfies Inbound);
        } catch (e) {
          const cancelled = e instanceof CancelledError;
          log.warn(`downloadNode: ${cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'nodeDownloadError',
            message: cancelled ? 'Download cancelled.' : (e as Error).message,
            ...(cancelled ? { cancelled: true } : {}),
          } satisfies Inbound);
        }
        return;
      }
```

- [ ] **Step 5: Branch the cancel handler**

Replace the existing `case 'cancelNodeDownload':` block (around lines 1142-1146) with:

```ts
      case 'cancelNodeDownload': {
        log.debug('cancelNodeDownload');
        // Cancel whichever installer is currently running.
        if (this.activeNvmInstaller) {
          this.activeNvmInstaller.cancel();
        } else {
          this.nodeInstaller.cancel();
        }
        return;
      }
```

- [ ] **Step 6: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: 768 passing (no new tests in this task; existing ones still green).

- [ ] **Step 7: Verify diff (no commit)**

`git diff src/ui/EditorPanel.ts | head -80`
Expect: imports + two field additions + three replaced switch cases.

---

## Task 5: NodeDownloadDialog — render via-nvm badge + nvm progress copy

**Files:**
- Modify: `webview/src/NodeDownloadDialog.tsx`

The dialog already accepts `installerKind` from the protocol because Task 1 widened `nodeDownloadList`. This task surfaces it in the UI.

- [ ] **Step 1: Read the current dialog header and progress block**

Open `webview/src/NodeDownloadDialog.tsx`. Find:
- The component's props or state that captures `nodeDownloadList` data (around the area that handles the inbound message).
- The header (where the "Download Node.js" title and badges live).
- The progress block (where `phaseLabel` is computed and the progress bar / detail line render).

Make a note of the variable name the dialog uses for the inbound list payload (likely `versions`, `installRoot`, plus we'll add `installerKind`).

- [ ] **Step 2: Wire `installerKind` through the dialog**

Wherever the dialog stores the inbound `nodeDownloadList` payload (likely in a `useEffect` that listens for `cmd: 'nodeDownloadList'`), capture `installerKind` alongside `versions` and `installRoot`. Add a state hook:

```tsx
const [installerKind, setInstallerKind] = useState<'nvm' | 'download'>('download');
```

In the message handler, when handling `nodeDownloadList`:

```tsx
setInstallerKind(msg.installerKind);
```

The webview already has `App.tsx` forwarding `nodeDownloadList` to dialog subscribers per Task 10 of the prior plan; the new `installerKind` field will arrive automatically because the dialog reads `msg.installerKind` directly.

- [ ] **Step 3: Render a "via nvm" pill in the header**

Find the existing pill row (where LTS / Latest pills already render). Add a `via nvm` pill at the start of the row when `installerKind === 'nvm'`. Match the existing pill component / styling — typically a small `<span class="dialog-pill dialog-pill--info">via nvm</span>` or whatever the existing pills use. Add a `title` attribute (tooltip): `Installs via your local nvm (~/.nvm)`.

If the existing pills are inline JSX (not a component), add the new pill in the same style. Goal: visually distinct, fits next to the LTS/Latest pills.

- [ ] **Step 4: Switch progress copy by installerKind**

Find the `phaseLabel` map (or equivalent) — where the progress block's heading text is computed from `state`. Update it to handle the new `'installing'` state with copy `Installing via nvm…` and to keep the existing three labels for `downloading` / `verifying` / `extracting`.

Sketch (adapt to the actual variable names in the file):

```tsx
const phaseLabel: Record<NonNullable<typeof state>, string> = {
  downloading: 'Downloading…',
  verifying: 'Verifying checksum…',
  extracting: 'Extracting archive…',
  installing: 'Installing via nvm…',
};
```

In the detail line, when `installerKind === 'nvm'`, display the latest `detail` string from `nodeDownloadProgress` directly (no fraction bar — nvm progress is text-only). The existing fraction-progress UI can hide when `state === 'installing'`:

```tsx
{state === 'installing' ? (
  <p className="dialog-progress-detail">{detail ?? 'starting…'}</p>
) : (
  /* existing fraction-progress UI */
)}
```

(Adjust class names to match the file's existing conventions.)

- [ ] **Step 5: Update the install-target preview**

The dialog currently shows something like:
> Will be installed to: `<installRoot>/<dirName>`

When `installerKind === 'nvm'`, change the copy to:
> Will be installed via nvm to: `<NVM_DIR>/versions/node/v<version>`

The version is the user's currently-selected dropdown row. `installRoot` (from `nodeDownloadList`) is `nvmDir` when nvm-routed.

Build that string client-side from the selected version + the received `installRoot`:

```tsx
const installTargetText = installerKind === 'nvm'
  ? `Will be installed via nvm to: ${installRoot}/versions/node/${selectedVersion}`
  : `Will be installed to: ${installRoot}/${dirFromFilename(selectedVersionDto.filename)}`;
```

(Use the actual variable names in the file. `selectedVersion` should be the full `v<x.y.z>` string; `dirFromFilename` is the existing helper Task 10 added.)

- [ ] **Step 6: Verify webview build**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm run build:webview 2>&1 | tail -10`
Expected: clean Vite build.

- [ ] **Step 7: Verify (no commit)**

`git diff webview/src/NodeDownloadDialog.tsx`
Expect: a `useState` for `installerKind`, a setter call in the inbound message handler, the new pill row entry, the `'installing'` phaseLabel mapping, and the conditional install-target text.

---

## Task 6: NpmAdapter help-text update

**Files:**
- Modify: `src/adapters/npm/NpmAdapter.ts`

Add one paragraph to the Node-field `help:` value so the user knows nvm-routing is automatic.

- [ ] **Step 1: Locate the existing help string**

Run: `grep -n "Auto-detected from" src/adapters/npm/NpmAdapter.ts`
Note the line — that's where the Node-field help text lives.

- [ ] **Step 2: Add the nvm note**

Find the help string (a multi-line string-concatenation expression). Insert a new paragraph between the existing "Leave blank to use whatever..." line and the "Click ☁..." line. The help string already uses `\n\n` between paragraphs — match that:

```ts
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
```

(Verify the surrounding lines in the file before editing — string-concat shape may differ from the snippet above. The new paragraph slots in between the two existing paragraphs.)

- [ ] **Step 3: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: still 768 passing.

- [ ] **Step 4: Verify diff (no commit)**

`git diff src/adapters/npm/NpmAdapter.ts | head -25`

---

## Task 7: Final integration verification

**Files:** none (verification-only)

- [ ] **Step 1: Full test suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -8`
Expected: 768 passing (or higher if any incidental new tests landed). 67 suites.

- [ ] **Step 2: Both typechecks**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

- [ ] **Step 3: Production build**

Run: `cd /git/run-config-manager && npm run build 2>&1 | tail -10`
Expected: clean Vite + esbuild build, no warnings beyond the pre-existing Vite-CJS-deprecation message.

- [ ] **Step 4: Manual sanity check (recommended)**

```bash
code --extensionDevelopmentPath="$(pwd)" /tmp/scratch
```

In the host VS Code:
1. Open the Run Configurations sidebar; create a new npm config in a workspace with a `package.json`.
2. Click the ☁ button on the Node field. Dialog opens.
3. With nvm installed (`~/.nvm/nvm.sh` present): confirm the dialog header shows the **`via nvm`** pill. The "Will be installed to" line reads "Will be installed via nvm to: `<NVM_DIR>/versions/node/v<ver>`".
4. Pick an LTS version, click Install. Watch the progress block: it should show "Installing via nvm…" with a live one-line detail string (the most recent line of nvm output).
5. After install completes, the dropdown shows the new install (auto-detected). The form's `nodePath` is set to the new `<NVM_DIR>/versions/node/v<ver>` path.
6. Run the config; confirm `node --version` matches the picked version.
7. (Optional) Cancel a long-running install with the dialog's cancel button — the install aborts, no orphan processes survive (`pgrep -f 'nvm install'`).

Report any deviation from the spec — those are bugs to fix before merging.

---

## Self-review

**Spec coverage:**
- detectNvm (env probe + ~/.nvm fallback + Windows short-circuit) → Task 2.
- NvmInstallerService (bash subshell, line-streamed progress, version normalization, post-install bin/node check, cancel with SIGTERM→SIGKILL) → Task 3.
- EditorPanel routing (detect once, branch downloadNode + cancel) → Task 4.
- Protocol (`installerKind`, `'installing'` state) → Task 1.
- Dialog UI (badge + nvm progress copy + install-target preview) → Task 5.
- Help-text update → Task 6.
- Tests called out in spec (`detectNvm.test.ts`, `NvmInstallerService.test.ts`) → Tasks 2 + 3.
- Final verification → Task 7.

All spec sections covered.

**Placeholder scan:** none of the disallowed patterns ("TBD", "TODO", "implement later", "similar to Task N") appear. Task 5 has prose-style instructions for the dialog edit because the existing `NodeDownloadDialog.tsx` has its own variable conventions that the implementer needs to read; I list the additions to make and the resulting behavior explicitly. Each Task-5 sub-step describes one concrete edit with the right snippet, and the verification step confirms the build is green.

**Type consistency:**
- `NvmInstall { available; nvmDir?; nvmShPath? }` defined in Task 2, consumed in Task 4 (`detectNvm` import) — same shape.
- `NvmProgress { state: 'installing'; detail }` — defined in Task 3, used in Task 4's `downloadNode` callback, surfaces via the protocol's `nodeDownloadProgress.state: 'installing'` (Task 1).
- `NvmInstallerService.install(version: string, onProgress)` returns `{ nodeHome, version }` — same shape as `NodeInstallerService.install`, so the post-install context-update block in Task 4 is shape-correct for both branches.
- `installerKind: 'nvm' | 'download'` — same string union in protocol (Task 1), EditorPanel (Task 4), and dialog (Task 5).

Plan complete.
