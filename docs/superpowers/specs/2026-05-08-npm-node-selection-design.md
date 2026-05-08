# Node selection for npm / Node configs

**Date:** 2026-05-08
**Status:** Design approved, ready for implementation plan

## Problem

The `npm` config type currently has no way to pin a specific Node runtime. Whatever `node` happens to be on `PATH` when VS Code launched is what runs the script. Users with multiple Node versions installed (via `nvm`, `volta`, `asdf`, `fnm`, the extension's own installer, etc.) have no way to declare "this config uses Node 18, that one uses Node 20."

The Spring Boot / Java / Tomcat / Quarkus adapters solved the same problem for JDKs: a `selectOrCustom` dropdown in the form, populated by an auto-detector, with a cloud (☁) installer button next to it. Bring the same UX to Node.

## Goals

- Per-config Node selection on the npm form, populated by detection of Node installs found on the user's machine.
- Selected Node takes effect at run time without surprises (`npm`, `yarn`, `pnpm`, and any binary they spawn — including `node` itself — come from the chosen install).
- Users can download a fresh Node from `nodejs.org` directly into the extension's install root, the same way the JDK / Tomcat / Maven / Gradle installers work.
- Existing npm configs keep working unchanged — leaving the field blank means "use whatever's on PATH," matching today's behavior.

## Non-goals

- No package-manager pinning beyond what's already there (`npm` / `yarn` / `pnpm` selector stays).
- No `engines` field reading from `package.json` to auto-suggest a Node version. Could come later; not in v1.

## Architecture

Six pieces, mirroring the JDK detection / installation pipeline.

### 1. `src/adapters/npm/detectNodes.ts`

Analogue of `src/adapters/spring-boot/detectJdks.ts`. Returns a list of Node home directories — each entry is guaranteed to have `bin/node` (or `node.exe` on Windows) on disk. Versions are NOT populated here; that's the streaming probe's job.

Detection sources, in priority order:

1. **Env vars** — `NODE_HOME`, `NVM_DIR` (the nvm root, whose `versions/node/*` children are install dirs).
2. **`which node` / `where node`** — resolved through symlinks so `nvm` / `volta` / `fnm` shims point back to their real install directory.
3. **Extension's own install root** — `userInstallRoot('nodes')` (`~/.rcm/nodes/*` on macOS/Linux, `%LOCALAPPDATA%\rcm\nodes\*` on Windows). Anything previously downloaded via the cloud installer shows up immediately.
4. **Version managers**:
   - `~/.nvm/versions/node/<v>`
   - `~/.volta/tools/image/node/<v>`
   - `~/.asdf/installs/nodejs/<v>`
   - `~/.fnm/node-versions/<v>/installation`
   - `~/.n/versions/node/<v>`
5. **Fixed roots**:
   - `/opt/node*`, `/usr/lib/node*`
   - `/opt/homebrew/opt/node*`, `/usr/local/opt/node*`
   - `C:\Program Files\nodejs`

Symlinks resolved with `fs.realpath` at the end so a shim and its real install don't double up.

Public API:

```ts
export interface NodeInfo {
  path: string;     // dir containing bin/node
  version?: string; // e.g. "20.10.0" — populated by probeNodeVersion
}

export async function detectNodes(): Promise<string[]>;
export async function probeNodeVersion(nodeHome: string): Promise<{ version?: string }>;
```

### 2. Version probe — `probeNodeVersion()` in the same file

Spawns `<home>/bin/node --version` (or `node.exe` on Windows), captures stdout, parses `v20.10.0` → `{ version: '20.10.0' }`. 2-second timeout; returns `{}` on timeout / non-zero exit / spawn error so a hung install can't block detection.

### 3. `src/adapters/npm/probeNodesStreaming.ts`

Analogue of `src/adapters/spring-boot/probeJdksStreaming.ts`. Two-phase emit:

1. Right after `detectNodes()` returns: emit `contextPatch: { nodes: NodeInfo[] }` with paths only. Dropdown is usable immediately. `typeOptions.nodePath` stays in `pending` so the field shows a spinner.
2. After all version probes settle (parallel `Promise.all`): emit the same context shape with `version` filled in, plus `resolved: ['typeOptions.nodePath']` to clear the spinner.

Also exports:

```ts
export function readNodes(value: unknown): NodeInfo[];
export function nodeOption(n: NodeInfo): { value: string; label: string };
```

`nodeOption` formats labels as `"/path/to/node — v20.10.0"` when version is known, just the path otherwise.

### 4. NpmAdapter wiring

`NpmAdapter.detectStreaming(folder, emit)` calls `probeNodesStreaming(emit, 'npm')`. The form schema gains a `selectOrCustom` field at the top of `typeSpecific`, between Script and Package manager:

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
}
```

### 5. Runtime hook — `NpmAdapter.prepareLaunch`

Today this returns the FORCE_COLOR / CLICOLOR_FORCE env block. The new behavior: when `cfg.typeOptions.nodePath` is set, prepend `<nodePath>/bin` (Unix) or `<nodePath>` itself (Windows — Node ships `node.exe` at the install root, not in `bin/`) to `PATH`.

```ts
async prepareLaunch(cfg: RunConfig): Promise<{ env?: Record<string, string> }> {
  const env: Record<string, string> = {
    FORCE_COLOR: '1', CLICOLOR_FORCE: '1', COLORTERM: 'truecolor', npm_config_color: 'always',
  };
  if (cfg.type === 'npm' && cfg.typeOptions.nodePath) {
    const binDir = process.platform === 'win32'
      ? cfg.typeOptions.nodePath
      : path.join(cfg.typeOptions.nodePath, 'bin');
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = `${binDir}${sep}${process.env.PATH ?? ''}`;
  }
  return { env };
}
```

The PATH prepend is the standard convention used by every Node version manager. `npm` / `yarn` / `pnpm` resolve their own binary first from PATH, and they internally use `process.execPath` (the calling Node) to spawn child Node processes — so the entire toolchain stays consistent.

### 6. `src/services/NodeInstallerService.ts`

Analogue of `GradleInstallerService.ts`, downloading from the official Node release index.

- **Index URL:** `https://nodejs.org/dist/index.json` — JSON array of `{ version, date, files, lts, ... }` covering every published release. Filter to non-pre-release entries (`version` matches `/^v\d+\.\d+\.\d+$/`); sort newest first; flag the first LTS as "current LTS." Could optionally hide ancient unsupported lines (Node ≤ 16) from the picker, but that's policy — keep them visible for now.
- **Download URL:** `https://nodejs.org/dist/<version>/node-<version>-<platform>-<arch>.<ext>`
  - `linux-x64.tar.xz`, `linux-arm64.tar.xz`, `darwin-x64.tar.gz`, `darwin-arm64.tar.gz`, `win-x64.zip`, `win-arm64.zip`.
- **Checksum:** `https://nodejs.org/dist/<version>/SHASUMS256.txt` — single text file listing `<sha256>  <filename>` per line. Match the row whose filename equals our download.
- **Install location:** `userInstallRoot('nodes')` → `~/.rcm/nodes/node-<version>-<platform>-<arch>/` (the archive root after extraction, which already has `bin/node` inside).
- **Cancellation, progress, retries:** reuse `src/services/archiveInstall.ts` helpers (`makeCancellation`, `httpGetJson`, `httpGetText`, `downloadFile`, `extractArchive`, `flattenSingleNestedDir`, `pathExists`, `humanSize`).

The `userInstallRoot` helper's `kind` parameter currently accepts `'jdks' | 'tomcats' | 'mavens' | 'gradles'`. Extend the union to include `'nodes'`.

Public API, mirroring `GradleInstallerService`:

```ts
export interface NodeVersion {
  version: string;          // "v20.10.0"
  downloadUrl: string;
  checksumUrl: string;
  isLts: boolean;
  // True for the latest LTS release in the listing.
  currentLts: boolean;
  // True for the most recent stable release overall.
  current: boolean;
}

export interface NodeProgress {
  state: 'downloading' | 'verifying' | 'extracting';
  fraction: number | null;
  detail?: string;
}

export interface NodeInstallResult {
  nodeHome: string;  // contains bin/node — value to write into typeOptions.nodePath
  version: string;
}

export class NodeInstallerService {
  listVersions(): Promise<NodeVersion[]>;
  install(v: NodeVersion, onProgress: (p: NodeProgress) => void): Promise<NodeInstallResult>;
  cancel(): void;
  getInstallRoot(): string;
}
```

### 7. JDK detector parity fix

`detectJdks.ts` currently doesn't scan `userInstallRoot('jdks')` — a small gap that means JDKs the user installed via the cloud icon don't show up in the dropdown until detection accidentally finds them via another source. Add the same `userInstallRoot('jdks')` sweep used by `detectTomcat.ts` and `detectBuildTools.ts`. Out of strict scope for this design but free to tack on alongside the parallel work; keeps the four detectors consistent.

### 8. EditorPanel integration

Same shape as the existing Gradle / Maven / Tomcat installers. New webview ↔ extension messages:

- `listNodeDownloads` (webview → extension) → `nodeDownloadList` reply with `{ versions, installRoot }`.
- `downloadNode { version }` (webview → extension) → progressing `nodeDownloadProgress` messages → `nodeDownloadComplete { nodeHome, version }` or `nodeDownloadError { message, cancelled? }`.
- `cancelNodeDownload` (webview → extension).

Successful install:

1. Pushes the new `nodeHome` into `context.nodes` (re-detected on next form open anyway, but instant feedback for this session).
2. Re-emits `schemaUpdate` so the dropdown refreshes.
3. Sends `configPatch` writing `typeOptions.nodePath = nodeHome`.

Action handler in `EditorPanel`:

```ts
case 'openNodeDownload': {
  this.panel.webview.postMessage({ cmd: 'openNodeDialog' });
  return;
}
```

### 9. Webview dialog

`webview/src/dialogs/NodeInstallDialog.tsx`, modeled on the existing `GradleInstallDialog.tsx`. Lists versions, distinguishes LTS from current, shows progress, cancellable. No design surprises here — just the Node analogue.

## Schema changes

```ts
// src/shared/types.ts
export interface NpmTypeOptions {
  scriptName: string;
  packageManager: PackageManager;
  nodePath: string; // empty = use PATH (legacy/default)
}

// src/shared/schema.ts
export const NpmTypeOptionsSchema = z.object({
  scriptName: z.string().min(1),
  packageManager: PackageManagerSchema,
  nodePath: z.string().optional().default(''),
});
```

No migration needed — `default('')` handles configs from before this change.

## Testing

- **`detectNodes.test.ts`** — mirrors `detectJdks.test.ts`. Covers: `which`-resolution path; nvm / volta / asdf / fnm / n directory walk; fixed-roots scan; `userInstallRoot('nodes')` scan; realpath dedupe; missing-binary filtering.
- **`probeNodeVersion.test.ts`** — happy path (`v20.10.0` parsed), timeout, non-zero exit returns `{}`.
- **`NodeInstallerService.test.ts`** — release listing parse (LTS detection, GA filter), download URL composition by platform/arch, cancel behavior, checksum verification, archive extraction.
- **`NpmAdapter.detect.test.ts`** — extend with: form schema includes `typeOptions.nodePath` field; options come from `context.nodes`.
- **`NpmAdapter.build.test.ts`** — extend with: `prepareLaunch` prepends `<nodePath>/bin` to PATH when nodePath is set; PATH untouched when blank; Windows variant uses `nodePath` directly without `/bin`.
- **`probeNodesStreaming.test.ts`** — two emits in order, pending→resolved transition, default seeded into `defaultsPatch` only when present.
- **JDK detection parity test** — assert `detectJdks` includes paths from `userInstallRoot('jdks')`.

## Risks

- **`PATH` prepend ordering edge cases:** if the user's existing `PATH` already contains a Node install at higher precedence (rare in practice — the prepend wins), the chosen install is still authoritative. Documented in help text.
- **Older Node lines in the installer dropdown:** showing every published version means the picker has hundreds of entries. Mitigated by sorting newest-first and tagging LTS visibly. If it becomes noisy, hide ≤ Node 14 in a follow-up.
- **`fnm` install layout** — `fnm` puts each install at `~/.fnm/node-versions/v<ver>/installation/`, with `bin/node` one more level down. Detection has to walk one extra level versus `nvm`. Captured in detection source #4.
- **Windows path:** Windows Node tarballs have `node.exe` at the archive root, not in `bin/`. The PATH prepend uses `<nodePath>` directly on Windows, not `<nodePath>/bin`. Captured in `prepareLaunch`.

## Out of scope (deferred)

- Reading `engines.node` from `package.json` to auto-pick a matching install.
- Per-workspace default Node (vs per-config).
- Importing `nvm` / `volta` config from `.nvmrc` / `package.json#volta`.
