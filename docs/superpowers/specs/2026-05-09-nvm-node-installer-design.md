# nvm-aware Node installer

**Date:** 2026-05-09
**Status:** Design approved, ready for implementation plan

## Problem

The Node download dialog (just shipped) always downloads a standalone tarball from `nodejs.org` and unpacks it under `~/.rcm/nodes/`. A user with `nvm` already installed ends up with two separate Node pools: their nvm-managed installs in `~/.nvm/versions/node/` and the extension's standalone copies in `~/.rcm/nodes/`. The extension's detector finds both, but the standalone copies are duplicates of versions the user could have installed via `nvm install <ver>`, and they don't get nvm's normal symlinks, default-version handling, or cleanup affordances.

The fix: when `nvm` is present, route the cloud-icon installer through `nvm install <version>` so new Node downloads land in the user's existing nvm pool. Detection already picks installs out of `~/.nvm/versions/node/*`, so the result shows up in the dropdown automatically.

## Goals

- When `nvm` is installed (POSIX), the Node download dialog auto-routes to `nvm install <version>`.
- nvm output streams into the dialog's progress UI live, so the user sees what nvm is doing.
- When `nvm` isn't installed (or on Windows), the dialog keeps using the standalone tarball download — no behavior change for those users.
- The dialog UI signals which installer is in use (a small `[via nvm]` badge), so the user understands where the install will land.
- Cancellation works the same in both modes.

## Non-goals

- Windows `nvm-windows` support. That tool uses a different binary, different commands, different env var (`NVM_HOME`). Out of scope; Windows users continue to get the tarball download.
- `volta`, `fnm`, `asdf` integrations. nvm has the largest user base by a wide margin and is the only one we'll target in v1.
- Letting the user choose between nvm and standalone when both are available. We auto-route — too much UI noise to expose a toggle nobody would meaningfully change.
- Running `nvm alias default <ver>` after install. The user's nvm default stays whatever they picked; we just install the version.

## Architecture

Five pieces.

### 1. `src/adapters/npm/detectNvm.ts`

Detects whether `nvm` is installed and returns the resolved `nvm.sh` path so the installer can source it.

```ts
export interface NvmInstall {
  available: boolean;
  // Absolute path to NVM_DIR (the directory containing nvm.sh).
  // Populated only when available === true.
  nvmDir?: string;
  // Absolute path to nvm.sh inside nvmDir. Populated only when available === true.
  nvmShPath?: string;
}

export async function detectNvm(): Promise<NvmInstall>;
```

Resolution order:

1. `$NVM_DIR/nvm.sh` — if `NVM_DIR` is set in the extension host's env AND `<NVM_DIR>/nvm.sh` exists on disk.
2. `~/.nvm/nvm.sh` — fallback to the standard install location.
3. Otherwise `{ available: false }`.

Two `fs.stat` calls in the worst case. Synchronous from the dialog's perspective (called once when the dialog opens, on the same code path that loads the version list).

POSIX only — on `process.platform === 'win32'`, return `{ available: false }` immediately without checking the filesystem.

### 2. `src/services/NvmInstallerService.ts`

Spawns `bash -c '. <nvmShPath> && nvm install <version>'`, streams output, returns the install path on success.

```ts
export interface NvmProgress {
  state: 'installing';
  detail: string; // most recent line of nvm output
}

export interface NvmInstallResult {
  nodeHome: string; // absolute path to the install dir (contains bin/node)
  version: string;
}

export class NvmInstallerService {
  constructor(private readonly nvmDir: string, private readonly nvmShPath: string);
  install(version: string, onProgress: (p: NvmProgress) => void): Promise<NvmInstallResult>;
  cancel(): void;
}
```

**Implementation details:**

- `install(version, onProgress)` accepts a version like `v20.10.0` or `20.10.0`. Strips a leading `v` so the command always passes `nvm install 20.10.0` (nvm handles both, but we normalize for clarity in logs).
- Spawns `bash` with `-c` and the script:
  ```bash
  . "<nvmShPath>" && nvm install <version>
  ```
  No shell escaping concerns — `version` is constrained by the dropdown to nodejs.org's `v<major>.<minor>.<patch>` shape, so no user-controlled string reaches the shell.
- Listens to both `stdout` and `stderr` (nvm prints status to both). Buffers partial lines; when a `\n` arrives, fires `onProgress({ state: 'installing', detail: <line> })` with the latest line. The webview displays this directly.
- On exit code `0`:
  - Computes `nodeHome = <nvmDir>/versions/node/v<normalized-version>`.
  - Verifies `<nodeHome>/bin/node` exists with `fs.stat`. If missing, throws (`"nvm reported success but no node binary at <path>"`) — defends against nvm output drift.
  - Returns `{ nodeHome, version: 'v' + normalized }`.
- On non-zero exit: throws with a message like `nvm install failed (exit ${code}): ${lastFewLines.join('\n')}`. Tail length: 8 lines.
- `cancel()` calls `SIGTERM` on the child, sets a 3-second timer to `SIGKILL` if it's still alive (matches the `RunTerminal` shutdown pattern). Cancellation manifests as a `CancelledError` thrown from `install()`.

### 3. EditorPanel routing

`listNodeDownloads` is extended to detect nvm once and forward the verdict to the webview:

```ts
case 'listNodeDownloads': {
  try {
    const versions = await this.nodeInstaller.listVersions();
    this.nodeVersions = versions;
    this.nvmInstall = await detectNvm();              // NEW
    this.panel.webview.postMessage({
      cmd: 'nodeDownloadList',
      versions: versions.map(toNodeDto),
      installRoot: this.nvmInstall.available
        ? this.nvmInstall.nvmDir!                       // show nvm dir to user
        : this.nodeInstaller.getInstallRoot(),
      installerKind: this.nvmInstall.available ? 'nvm' : 'download',  // NEW
    } satisfies Inbound);
  } catch (e) { /* existing error path */ }
  return;
}
```

`downloadNode` branches on the cached `installerKind`:

```ts
case 'downloadNode': {
  if (this.nvmInstall?.available) {
    // Use the nvm-backed installer.
    const nvmService = new NvmInstallerService(this.nvmInstall.nvmDir!, this.nvmInstall.nvmShPath!);
    this.activeNodeCancel = () => nvmService.cancel();
    try {
      const result = await nvmService.install(msg.version, p => {
        this.panel.webview.postMessage({
          cmd: 'nodeDownloadProgress',
          state: 'installing',
          fraction: null,
          detail: p.detail,
        } satisfies Inbound);
      });
      // existing context-update + completion path, identical to the standalone branch.
    } catch (e) { /* existing error path */ }
  } else {
    // Existing standalone tarball path.
  }
  return;
}
```

The two paths share the success/error post-processing — only the installer call differs. Worth extracting a small helper if duplication grows; for v1, two near-identical blocks are clearer than abstraction.

`cancelNodeDownload` already routes through `this.activeNodeCancel?.()` — both installers wire into the same cancel hook.

### 4. Webview dialog

Two changes to `NodeDownloadDialog.tsx`:

- Read `installerKind` from the `nodeDownloadList` payload. Render a `via nvm` pill in the dialog header when `'nvm'` (mirrors the existing LTS / Latest pills). Tooltip: "Will install via your local `nvm`."
- Progress block shows different copy by `installerKind`:
  - `'download'` → existing `Downloading… / Verifying… / Extracting…` 3-phase UI.
  - `'nvm'` → single phase labeled `"Installing via nvm"`. The `detail` line from `nodeDownloadProgress` displays directly under the spinner (e.g. `"Downloading https://nodejs.org/dist/v20.10.0/node-v20.10.0-linux-x64.tar.xz..."`).

The "Will be installed to: `<installRoot>/<dirName>`" preview switches to "Will be installed via nvm to: `<NVM_DIR>/versions/node/v<ver>`" when `installerKind === 'nvm'`.

### 5. Help-text update

Add one paragraph to the `Node` field help in `NpmAdapter.ts`:

> `nvm` users: when `nvm` is detected on your system, the cloud-icon installer routes through `nvm install` instead of downloading a standalone tarball, so the install lands in your existing nvm pool (`~/.nvm/versions/node/`).

## Schema changes

`src/shared/protocol.ts`:

- Add `installerKind: 'nvm' | 'download'` to the `nodeDownloadList` Inbound message.
- Add an optional `state: 'installing'` to `nodeDownloadProgress` (existing union is `'downloading' | 'verifying' | 'extracting'`).

No persistence changes. The user's saved `nodePath` still stores the absolute install directory — what `nvm install` produces is just an `~/.nvm/versions/node/v<ver>/` path that the existing detector already picks up.

## Error handling

- **`nvm` exit code != 0** — throw with last 8 lines of output. The dialog shows a red error block with the message (existing `nodeDownloadError` flow).
- **`nvm` succeeds but `bin/node` missing** — defensive throw `"nvm reported success but no node binary at <path>"`. Same dialog path.
- **`bash` not on PATH** (extreme edge case on POSIX) — `child_process.spawn` rejects; surfaces as `nodeDownloadError`. Acceptable; `bash` is a hard dependency for nvm itself, so this is "broken environment, not our problem."
- **Cancellation during `nvm install`** — `SIGTERM` → 3 s grace → `SIGKILL`. nvm aborts; partial downloads are discarded by nvm itself (it stages into a temp dir).

## Testing

- **`test/detectNvm.test.ts`** — `NVM_DIR` set + nvm.sh present, `NVM_DIR` set + nvm.sh missing, `NVM_DIR` unset + `~/.nvm/nvm.sh` present, neither, Windows short-circuit. Mocks `fs.promises.stat`.
- **`test/NvmInstallerService.test.ts`** — verify spawn args (`bash -c '. <path> && nvm install <ver>'`); progress callback fires per line; success returns expected `nodeHome`; non-zero exit throws with message containing the last lines; cancel sends SIGTERM and SIGKILLs after 3 s. Uses a fake `child_process` mock.
- **`test/EditorPanel`-equivalent** — there's no existing EditorPanel unit test; we'll skip extending it. The branching is covered by the nvm-vs-standalone distinction in the message-handler tests if any get added later.
- **No webview unit tests for the dialog change** — existing dialogs aren't unit-tested either; manual smoke check covers it.

## Risks

- **nvm output format drift.** The version-string-to-path computation (`<nvmDir>/versions/node/v<ver>`) assumes nvm's standard install layout. Defended by the post-install `bin/node` existence check — if drift breaks the path, the user gets a clear error rather than a silently-wrong `nodePath`.
- **Long install times.** `nvm install` downloads source on some platforms (e.g. when no prebuilt binary is available for the requested version on the host arch). The dialog's "Installing via nvm" state handles this — the live `detail` line keeps the user informed. Cancel still works.
- **Slow detection.** `detectNvm` is two `fs.stat`s. Worst case ~1 ms; not a concern.
- **PATH not having `bash`.** As noted above, acceptable to fail loudly here. nvm itself requires bash, so a host without bash can't have nvm in the first place — `detectNvm` would return `{ available: false }` and we'd never spawn bash.

## Out of scope (deferred)

- nvm-windows support.
- `volta install`, `fnm install`, `asdf install nodejs <ver>`.
- Setting the new install as nvm's default (`nvm alias default`).
- Listing already-installed nvm versions in the picker (we still fetch from nodejs.org for full version visibility; the user's nvm pool is shown via the existing detection-driven dropdown on the form).
