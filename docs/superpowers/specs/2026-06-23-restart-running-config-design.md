# Restart button for running configurations

**Date:** 2026-06-23
**Status:** Approved (design)

## Problem

When a configuration is running, the user often wants to restart it (e.g. after a
code change, or to clear a wedged state). Today this is a two-step manual chore:
click Stop, wait for it to actually stop, then click Run (or Debug). This is a
small but frequent friction point.

## Goal

Add a one-click **Restart** action to running configurations that stops the
config, waits briefly, and starts it again **in the same mode it was running**
(normal / debug / monitored).

## UX

- A new inline action button appears on a config row **only while it is running**.
- It is positioned **to the left of the Stop button**.
- The icon is **blue** (a deliberate action accent, distinct from the monochrome
  brand/type icons and from the green/red/yellow run-state colors).
- Clicking it: stop the config → wait ~1 second → start it again in the same mode.
- The action is also available in the right-click context menu (`1_run` group) for
  discoverability and keyboard/accessibility parity with Run/Stop/Debug.

## Behavior

On click, capture the current run mode **before** stopping:

- `wasDebugging  = dbg.isRunning(config.id)`
- `wasMonitoring = Boolean(monitoring?.state(config.id))`

Then:

1. **Stop** whichever service is tracking it:
   - `wasDebugging` → `dbg.stop(config.id)` (this tears down both the debug session
     and, in attach-mode, the underlying run task — see `DebugService.stop`).
   - else → `exec.stop(config.id)`.
2. **Wait** `RESTART_DELAY_MS` (default 1000 ms) so ports/processes release before
   relaunch.
3. **Start** again in the same mode:
   - `wasDebugging` → `dbg.debug(config, folder, wasMonitoring ? { monitor: true } : undefined)`
   - else if `wasMonitoring` → `exec.run(config, folder, { monitor: true })`
   - else → `exec.run(config, folder)`

## Components

### 1. `package.json`

- New command `runConfig.restart`, title `"Restart"`, icon → `media/icons/restart.svg`.
- New `view/item/context` inline entry:
  - `group: "inline@0"` (Stop is `inline@1`, so restart renders to its left).
  - `when: view == runConfigurations && viewItem =~ /^configRunning(NoDebug)?(:(maven|gradle|npm|python|go))?(:grouped)?(:monitored)?$/`
  - The `(NoDebug)?` alternative is included so restart shows for non-debuggable
    running configs too (restart does not require debug support).
- New `1_run` context-menu entry for `runConfig.restart` with the same `when`.

### 2. Blue icon

- `media/icons/restart.svg`: a restart / circular-arrow glyph filled with VS Code
  blue (`#3794ff`). A single file serves both light and dark themes (blue reads on
  both).
- This is intentionally **not** monochrome. The monochrome convention in
  `media/icons/` exists so *brand* hues don't compete with run-state colors; an
  explicit blue *action* button is the intended exception, consistent with how the
  user requested it.

### 3. `src/services/restartConfig.ts` (new, testable helper)

Extracted so the stop→wait→start orchestration is unit-testable and `extension.ts`
stays thin.

```ts
export interface RestartDeps {
  exec: Pick<ExecutionService, 'stop' | 'run'>;
  dbg: Pick<DebugService, 'isRunning' | 'stop' | 'debug'>;
  monitoring?: Pick<MonitoringService, 'state'>;
  delayMs?: number; // default RESTART_DELAY_MS (1000)
}

export const RESTART_DELAY_MS = 1000;

export async function restartConfig(
  deps: RestartDeps,
  config: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<void>;
```

The `delayMs` is injectable purely so tests can pass `0`.

### 4. `extension.ts`

Register `runConfig.restart`:

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('runConfig.restart', async (arg: ConfigNodeArg) => {
    const resolved = resolveCommandTarget(arg, store);
    if (!resolved || resolved.kind !== 'config') return; // restart only applies to RCM configs
    const { config, folder } = resolved;
    log.info(`Restart: "${config.name}"`);
    await restartConfig({ exec, dbg, monitoring }, config, folder);
  }),
);
```

## Scope decisions (explicit)

- **Single config only.** Restart restarts the selected config; it does **not**
  re-run its `dependsOn` graph. Dependencies are assumed already up.
- **Docker excluded.** Docker rows have a different `contextValue` and a separate
  lifecycle (`DockerService`); the running regex above does not match them, so no
  restart button appears on docker rows. Out of scope for this change.
- **No `contextValue` change.** Debug-vs-normal and monitoring are detected at
  restart time via `dbg.isRunning` / `monitoring.state`. The button visibility only
  needs "is running", which the existing `configRunning…` contextValue already
  expresses.

## Testing

New `test/restartConfig.test.ts` with mocked `exec` / `dbg` / `monitoring` and
`delayMs: 0`. Cases:

1. **Normal mode** (`!wasDebugging`, `!wasMonitoring`): calls `exec.stop` then
   `exec.run(config, folder)` (no opts), in order.
2. **Debug mode** (`wasDebugging`, `!wasMonitoring`): calls `dbg.stop` then
   `dbg.debug(config, folder, undefined)`.
3. **Monitored mode** (`!wasDebugging`, `wasMonitoring`): calls `exec.stop` then
   `exec.run(config, folder, { monitor: true })`.
4. **Debug + monitored** (`wasDebugging`, `wasMonitoring`): calls `dbg.stop` then
   `dbg.debug(config, folder, { monitor: true })`.
5. **Stop precedes start**: assert ordering (e.g. via a shared call-order array)
   so the wait/sequence contract is locked in.

## Verification

- `npm run typecheck && npm test && npm run build` must pass.
- DO NOT COMMIT — the user reviews and commits manually.
