# npm framework-aware enhancements

**Date:** 2026-05-12
**Status:** Design approved, ready for implementation plan

## Problem

The npm adapter currently treats every JavaScript project the same — same form, same default script (first in `package.json`), no port pre-fill, no framework awareness beyond the sidebar icon. Users in Angular / Next.js / Vite / etc. projects have to know the framework's conventions themselves: which script to pick, which port the framework binds to, that they need to run `npm install` after a fresh clone.

The Python adapter we just shipped does this work for the user — detects the framework, suggests the right command, pre-fills the port, runs a pre-flight dependency check. The npm adapter should reach the same level of helpfulness.

## Goals

- Detected framework drives a smarter default script (`dev` for Vite/Next.js/Nuxt/SvelteKit/Astro, `start` for Angular/CRA, etc.).
- Form shows a "Detected: <framework>" badge below the Script field with the source of detection.
- Port field auto-fills with the framework's convention default (4200 for Angular, 3000 for Next.js, 5173 for Vite, etc.) when no explicit `--port` is found in the script.
- On Run click, pre-flight checks `node_modules/` exists; if missing, prompts with [Install] / [Run anyway] / [Cancel].
- Existing npm configs keep working without any user action.

## Non-goals

- A `launchMode` select for npm configs (that's the Python-style refactor; we're keeping the existing form shape).
- Framework-specific right-click actions (e.g. `Angular: ng build --prod`). Could come later; out of scope here.
- "Outdated `node_modules`" detection — checking lockfile vs `node_modules` consistency requires running `npm install --dry-run`, which is slow. We only check for **missing** `node_modules`.
- Yarn PnP / pnpm with `node-linker=hoisted` etc. — we only check for the literal `node_modules` directory, which works for >95% of setups. Users with PnP can [Run anyway].
- Replacing the existing icon-only `detectNpmSubtype` (used in the tree-render path). It runs synchronously on every render and can't await `package.json` reads; the new framework detector is async and lives in a different code path.

## Architecture

One new detection module + four touch-points across the existing adapter / form / runtime.

### Files

| File | Responsibility |
|---|---|
| `src/adapters/npm/detectNpmFramework.ts` | New. Async framework detector. Reads `package.json` + checks for framework config files. Returns `NpmFrameworkInfo`. |
| `src/adapters/npm/detectPackageJson.ts` | Modified. `readPackageJsonInfo` already returns `defaultScript`; augment so it asks the framework detector for a smarter default when one is detected. |
| `src/adapters/npm/NpmAdapter.ts` | Modified. Read framework info from context; add the "Detected" badge to the form schema; thread `defaultPort` into the port field's defaultsPatch. |
| `src/services/detectProjectPort.ts` | Modified. After existing `--port` flag scan in scripts, fall back to framework default port. |
| `src/services/ExecutionService.ts` | Modified. New `preflightNpmDependencies` mirroring `preflightPythonDependencies`. Cached per `(projectPath, packageJsonMtime, lockfileMtime)`. |

### Detection module

```ts
// src/adapters/npm/detectNpmFramework.ts

export type NpmFramework =
  | 'angular' | 'nextjs' | 'nuxt' | 'vite' | 'sveltekit' | 'svelte'
  | 'vue' | 'react' | 'astro' | 'remix' | 'gatsby' | 'storybook'
  | null;

export interface NpmFrameworkInfo {
  // Identified framework, or null when no signal matched.
  name: NpmFramework;
  // Human-readable detection source for the form badge.
  // Examples: 'angular.json', 'next.config.ts', '@angular/core in dependencies'.
  source: string;
  // Best-guess script to invoke. Picks the framework convention name
  // when a script with that name exists; otherwise falls back to
  // package.json's first script.
  defaultScript: string;
  // Convention port for this framework. null when the framework isn't
  // a server (e.g. a library project's tooling).
  defaultPort: number | null;
}

export async function detectNpmFramework(
  folder: vscode.Uri,
  scripts: string[],
  packageJson: PackageJsonInfo,
): Promise<NpmFrameworkInfo>;
```

`PackageJsonInfo` is the existing return shape from `detectPackageJson.ts` — `{ scripts, defaultScript, packageManager, dependencies, devDependencies }`. The detector reuses already-parsed data rather than re-reading disk.

### Per-framework signals (single source of truth)

Detection runs in **priority order** because some frameworks use others under the hood (e.g. Nuxt uses Vite). First match wins.

| Priority | Framework | Signal (any one matches) | Default script | Default port |
|---|---|---|---|---|
| 1 | **Next.js** | `next.config.{js,mjs,ts}` present · `next` in deps | `dev` | 3000 |
| 2 | **Nuxt** | `nuxt.config.{js,ts}` present · `nuxt` in deps | `dev` | 3000 |
| 3 | **SvelteKit** | `@sveltejs/kit` in deps | `dev` | 5173 |
| 4 | **Astro** | `astro.config.{js,mjs,ts}` present · `astro` in deps | `dev` | 4321 |
| 5 | **Remix** | `remix.config.{js,ts}` present · `@remix-run/dev` in deps | `dev` | 3000 |
| 6 | **Gatsby** | `gatsby-config.{js,ts}` present · `gatsby` in deps | `develop` | 8000 |
| 7 | **Angular** | `angular.json` present · `@angular/core` in deps | `start` | 4200 |
| 8 | **Storybook** | `.storybook/` dir · `@storybook/cli` in devDeps | `storybook` | 6006 |
| 9 | **Svelte** | `svelte.config.{js,ts}` present · `svelte` in deps | `dev` | 5173 |
| 10 | **Vue (CLI)** | `vue.config.js` present · `@vue/cli-service` in deps | `serve` | 8080 |
| 11 | **CRA (React)** | `react-scripts` in deps · `react-scripts` in any script line | `start` | 3000 |
| 12 | **Vite (generic)** | `vite.config.{js,ts,mjs}` present · `vite` in deps | `dev` | 5173 |
| (none) | null | — | (first script) | null |

Notes:

- Next.js / Nuxt / SvelteKit / Astro / Remix are checked BEFORE generic Vite because they often have a `vite.config.*` as a transitive consequence — without the priority, Vite would mis-claim them.
- Vue 3 + Vite (`create-vue` template) doesn't have `vue.config.js`; it shows up as `vite` here because that's what `npm run dev` actually invokes. The icon detector at `iconForConfig.ts` retains the old Vue logic since the icon priority differs.
- The existing icon-only detector `detectNpmSubtype` is kept synchronous so the tree render path stays fast. The two detectors run separately; consistency is enforced by sharing the same priority order in their respective tables (a follow-up task could unify them, but YAGNI for now).

### "Detected" badge in the form

In `NpmAdapter.getFormSchema`, when `context.npmFramework?.name` is non-null, insert an `info`-kind FormField immediately below the Script field:

```ts
{
  kind: 'info',
  key: 'npmFrameworkBadge',
  label: 'Detected framework',
  content: {
    banner: {
      kind: 'muted',
      text: `Detected: **${displayName}** (${source})`,
    },
  },
}
```

Mirrors the Python adapter's `fwBadge` pattern in shape, but uses the `info` field kind for VS Code-style consistency. No interaction; purely informational.

`displayName` is the human-friendly capitalization (`Next.js`, `SvelteKit`, `Vue (CLI)`, etc.); `source` is the file/dep name from the detector.

### Default script + port

`detectPackageJson.ts:readPackageJsonInfo` currently returns `defaultScript = scripts[0] ?? 'start'`. Replace with: ask `detectNpmFramework` for the framework, then pick whichever exists from the framework's preferred script names (`dev`, `start`, `serve`, etc.); fall back to `scripts[0]` when none of the preferred names match.

`detectNpmPort` (in `src/services/detectProjectPort.ts`) already parses scripts for `--port <n>` / `-p <n>`. After that existing logic, when no port was found, look up the framework's `defaultPort` and use it.

The framework detection is run once per detect cycle; the result lives in `context.npmFramework` so the form schema and the port detector both consume the same value without re-running detection.

### Pre-flight `node_modules` check

In `ExecutionService.run`, before launching any `cfg.type === 'npm'` config:

1. Resolve `projectRoot` from `cfg.projectPath`.
2. If `projectRoot/package.json` doesn't exist → fast path, no prompt (script will fail loudly; not our problem).
3. If `projectRoot/node_modules` exists → fast path, cache as `'ok'`.
4. Otherwise: show `vscode.window.showWarningMessage`:
   > "<configName>" depends on packages that aren't installed. Run `<pm> install` first?
   > **[Install]** **[Run anyway]**
5. **[Install]** spawns `<pm> install` via the existing Task-based `runInTerminal` plumbing (no shell-init race). Aborts the current Run; user clicks Run again after install completes.
6. **[Run anyway]** proceeds with the launch.
7. Dismiss / Cancel → abort.

The package manager (`npm` / `yarn` / `pnpm`) is read from the resolved npm context. If a lockfile exists (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`), the chosen manager respects it.

Cache key: `(projectPath, packageJsonMtimeMs, lockfileMtimeMs)`. Same shape as the Python pre-flight cache. Editing `package.json` (or running `npm install`, which updates the lockfile mtime) invalidates the cache so the prompt is fresh on the next Run.

### Schema migration

No schema changes — all features are detection-side. Existing npm configs round-trip unchanged.

## Error handling

- **`package.json` parse failure** — log at `warn`, return `name: null`. Form falls back to the existing first-script behavior; pre-flight skips the check.
- **Framework detector throws** — try/catch in `NpmAdapter.detect` and `ExecutionService.preflightNpmDependencies`. Detection failure is non-fatal: form opens with no badge, port defaults stay blank, pre-flight no-ops.
- **`node_modules` exists but is empty** (`{}` after `rm -rf node_modules/* && touch node_modules/.keep`) — we treat the directory's existence as sufficient. False negatives here are rare and the Run command would fail clearly anyway.

## Testing

- `detectNpmFramework.test.ts` — one test per framework (priority + signal), one for "no signal", one for the priority order (Next.js wins over generic Vite when both signals present).
- `NpmAdapter.detect.test.ts` — assert the badge field is included when a framework is detected; absent otherwise. Assert the chosen `defaultScript` follows framework convention.
- `detectNpmPort.test.ts` — assert framework default fires only when no `--port` is found.
- `ExecutionService.preflightNpmDependencies.test.ts` — pre-flight skips when no `package.json`; fires when `node_modules` is missing; caches per-mtime.

## Risks

- **Detection priority drift.** Adding a new framework requires inserting it at the right priority slot. Mitigated by the explicit priority-numbered table in the design doc; tests cover the Next.js-vs-Vite collision.
- **First-time `npm install` for a complex monorepo can take minutes.** The pre-flight Install button kicks off the install but doesn't auto-launch the config afterward — the user has agency and will click Run when they see the install finish. Same UX as the Python pre-flight.
- **Port collision with explicit user value.** The port default only fires when the existing `--port`-from-scripts detector returned nothing. User-configured `port` field values are preserved by `mergeBlanks` in the webview.

## Out of scope (deferred)

- Framework-specific right-click actions (`Angular: ng build`, `Next.js: next build`, `Vite: vite preview`).
- Outdated `node_modules` detection.
- Monorepo-aware install (running `npm install` at workspace root vs project subfolder when the user's setup uses workspaces).
- Yarn PnP / pnpm `node-linker=pnp` setups.
- A unified async detector that replaces the synchronous icon-side `detectNpmSubtype`.
