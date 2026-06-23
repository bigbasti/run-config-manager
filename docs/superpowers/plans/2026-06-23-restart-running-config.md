# Restart Running Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a blue inline "Restart" button to running run-configurations that stops the config, waits ~1s, and starts it again in the same mode (normal / debug / monitored).

**Architecture:** A testable pure-ish helper `restartConfig()` captures the current run mode (`dbg.isRunning`, `monitoring.state`) before stopping, then stops via the tracking service, waits a configurable delay, and restarts in the same mode. `extension.ts` registers a thin `runConfig.restart` command that delegates to the helper. `package.json` adds the command (blue SVG icon) plus an inline menu entry to the left of Stop and a right-click entry.

**Tech Stack:** TypeScript, VS Code extension API, Jest (with in-memory `vscode` mock), esbuild + vite build.

**IMPORTANT — no auto-commits:** This repo's golden rule #7 forbids agent commits. Do NOT run `git commit`. The "Commit" steps below are intentionally replaced with a staging-only note; the user commits manually after review.

---

### Task 1: Testable `restartConfig` helper

**Files:**
- Create: `src/services/restartConfig.ts`
- Test: `test/restartConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/restartConfig.test.ts`:

```ts
import { restartConfig } from '../src/services/restartConfig';
import type { RunConfig } from '../src/shared/types';

// Minimal fakes — restartConfig only reads config.id and passes folder through.
const config = { id: 'cfg-1', name: 'X' } as unknown as RunConfig;
const folder = {} as any;

interface Recorder { calls: string[] }

function makeDeps(opts: { debugging: boolean; monitoring: boolean }) {
  const rec: Recorder = { calls: [] };
  const exec = {
    stop: jest.fn(async () => { rec.calls.push('exec.stop'); }),
    run: jest.fn(async () => { rec.calls.push('exec.run'); return undefined; }),
  };
  const dbg = {
    isRunning: jest.fn(() => opts.debugging),
    stop: jest.fn(async () => { rec.calls.push('dbg.stop'); }),
    debug: jest.fn(async () => { rec.calls.push('dbg.debug'); return true; }),
  };
  const monitoring = {
    state: jest.fn(() => (opts.monitoring ? ({} as any) : undefined)),
  };
  return { rec, exec, dbg, monitoring };
}

describe('restartConfig', () => {
  test('normal mode: stop via exec, restart via exec.run with no opts', async () => {
    const { rec, exec, dbg } = makeDeps({ debugging: false, monitoring: false });
    await restartConfig({ exec, dbg, delayMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['exec.stop', 'exec.run']);
    expect(exec.run).toHaveBeenCalledWith(config, folder, undefined);
    expect(dbg.stop).not.toHaveBeenCalled();
  });

  test('debug mode: stop and restart via debug, no monitor opt', async () => {
    const { rec, exec, dbg } = makeDeps({ debugging: true, monitoring: false });
    await restartConfig({ exec, dbg, delayMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['dbg.stop', 'dbg.debug']);
    expect(dbg.debug).toHaveBeenCalledWith(config, folder, undefined);
    expect(exec.stop).not.toHaveBeenCalled();
  });

  test('monitored mode: restart via exec.run with monitor opt', async () => {
    const { rec, exec, monitoring, dbg } = makeDeps({ debugging: false, monitoring: true });
    await restartConfig({ exec, dbg, monitoring, delayMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['exec.stop', 'exec.run']);
    expect(exec.run).toHaveBeenCalledWith(config, folder, { monitor: true });
  });

  test('debug + monitored: restart via debug with monitor opt', async () => {
    const { rec, dbg, monitoring } = makeDeps({ debugging: true, monitoring: true });
    await restartConfig({ exec: { stop: jest.fn(), run: jest.fn() }, dbg, monitoring, delayMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['dbg.stop', 'dbg.debug']);
    expect(dbg.debug).toHaveBeenCalledWith(config, folder, { monitor: true });
  });

  test('mode is captured BEFORE stop (isRunning queried once, up front)', async () => {
    const { dbg } = makeDeps({ debugging: true, monitoring: false });
    await restartConfig({ exec: { stop: jest.fn(), run: jest.fn() }, dbg, delayMs: 0 } as any, config, folder);
    expect(dbg.isRunning).toHaveBeenCalledWith('cfg-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest restartConfig -t restartConfig`
Expected: FAIL — `Cannot find module '../src/services/restartConfig'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/restartConfig.ts`:

```ts
import type * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { ExecutionService } from './ExecutionService';
import type { DebugService } from './DebugService';
import type { MonitoringService } from './MonitoringService';

/**
 * Pause between stop and start so the OS releases the port and the child
 * process fully exits before we relaunch. Tuned for a usability "restart"
 * rather than correctness — a value too small risks a port-in-use relaunch.
 */
export const RESTART_DELAY_MS = 1000;

export interface RestartDeps {
  exec: Pick<ExecutionService, 'stop' | 'run'>;
  dbg: Pick<DebugService, 'isRunning' | 'stop' | 'debug'>;
  monitoring?: Pick<MonitoringService, 'state'>;
  /** Injectable purely so tests can pass 0. Defaults to RESTART_DELAY_MS. */
  delayMs?: number;
}

/**
 * Stop a running config and start it again in the SAME mode it was running.
 *
 * Mode is captured up front (before the stop tears down the tracking state):
 *  - debug:   dbg.isRunning(id) — true for both launch- and attach-mode debug.
 *  - monitor: monitoring.state(id) — present while a JMX agent is attached.
 *
 * dbg.stop() also tears down the underlying run task in attach-mode, so a
 * single stop call is sufficient regardless of mode.
 */
export async function restartConfig(
  deps: RestartDeps,
  config: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const { exec, dbg, monitoring } = deps;
  const delayMs = deps.delayMs ?? RESTART_DELAY_MS;

  const wasDebugging = dbg.isRunning(config.id);
  const wasMonitoring = Boolean(monitoring?.state(config.id));

  if (wasDebugging) {
    await dbg.stop(config.id);
  } else {
    await exec.stop(config.id);
  }

  if (delayMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  }

  if (wasDebugging) {
    await dbg.debug(config, folder, wasMonitoring ? { monitor: true } : undefined);
  } else if (wasMonitoring) {
    await exec.run(config, folder, { monitor: true });
  } else {
    await exec.run(config, folder, undefined);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest restartConfig`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Stage (DO NOT COMMIT)**

```bash
git add src/services/restartConfig.ts test/restartConfig.test.ts
```
Do NOT run `git commit` — the user commits manually.

---

### Task 2: Blue restart SVG icon

**Files:**
- Create: `media/icons/restart.svg`

- [ ] **Step 1: Create the icon**

Create `media/icons/restart.svg` (a circular-arrow "restart" glyph in VS Code blue `#3794ff`, 16×16). This deliberately uses color — it is an action icon, not a monochrome brand icon:

```svg
<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path fill="#3794ff" fill-rule="evenodd" clip-rule="evenodd" d="M8 3V1L5 4l3 3V5a3 3 0 1 1-3 3H3.5A4.5 4.5 0 1 0 8 3z"/>
</svg>
```

- [ ] **Step 2: Verify the file is valid SVG**

Run: `node -e "const s=require('fs').readFileSync('media/icons/restart.svg','utf8'); if(!s.includes('<svg')||!s.includes('</svg>')) throw new Error('bad svg'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Stage (DO NOT COMMIT)**

```bash
git add media/icons/restart.svg
```
Do NOT run `git commit`.

---

### Task 3: Register the `runConfig.restart` command in `package.json`

**Files:**
- Modify: `package.json` (commands array ~line 110; `view/item/context` menus ~line 388 and ~line 449)

- [ ] **Step 1: Add the command definition**

In `package.json`, in `contributes.commands`, immediately after the `runConfig.stop` command block (the one ending at the `}` on line 110), insert:

```json
      {
        "command": "runConfig.restart",
        "title": "Restart",
        "icon": "media/icons/restart.svg"
      },
```

Resulting in the sequence: `runConfig.stop` → `runConfig.restart` → `runConfig.debug`.

- [ ] **Step 2: Add the inline menu entry (left of Stop)**

In `package.json`, in `contributes.menus` → `view/item/context`, insert this entry immediately BEFORE the existing `runConfig.stop` inline entry (the block at lines 386–390 with `"group": "inline@1"`):

```json
        {
          "command": "runConfig.restart",
          "when": "view == runConfigurations && viewItem =~ /^configRunning(NoDebug)?(:(maven|gradle|npm|python|go))?(:grouped)?(:monitored)?$/",
          "group": "inline@0"
        },
```

`inline@0` sorts before `inline@1` (Stop), so Restart renders to the left of Stop.

- [ ] **Step 3: Add the right-click context-menu entry**

In the same `view/item/context` array, insert immediately AFTER the `runConfig.stop` entry whose `"group": "1_run@3"` (the block at lines 446–450):

```json
        {
          "command": "runConfig.restart",
          "when": "view == runConfigurations && viewItem =~ /^configRunning(NoDebug)?(:(maven|gradle|npm|python|go))?(:grouped)?(:monitored)?$/",
          "group": "1_run@4"
        },
```

(`1_run@4` slots between Stop `@3` and runMonitored `@5`.)

- [ ] **Step 4: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('valid json')"`
Expected: prints `valid json`.

- [ ] **Step 5: Stage (DO NOT COMMIT)**

```bash
git add package.json
```
Do NOT run `git commit`.

---

### Task 4: Wire the command handler in `extension.ts`

**Files:**
- Modify: `src/extension.ts` (import near other service imports; command registration near the `runConfig.stop` handler at lines 391–419)

- [ ] **Step 1: Add the import**

In `src/extension.ts`, add an import for the helper alongside the other `./services/*` imports (place near the top with the existing service imports):

```ts
import { restartConfig } from './services/restartConfig';
```

- [ ] **Step 2: Register the command**

In `src/extension.ts`, immediately AFTER the `runConfig.stop` command registration (the `registerCommand('runConfig.stop', ...)` block that ends around line 419), add:

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

Notes for the implementer (already verified):
- `exec`, `dbg`, and `monitoring` are all in scope in `activate()` (declared at `extension.ts:82`, `87`, `88`).
- `ConfigNodeArg`, `resolveCommandTarget`, `store`, and `log` are already used by the surrounding handlers — no new imports for those.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Stage (DO NOT COMMIT)**

```bash
git add src/extension.ts
```
Do NOT run `git commit`.

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites pass, including the new `restartConfig.test.ts` (5 tests). Total count increases by 5.

- [ ] **Step 2: Typecheck both projects**

Run: `npm run typecheck`
Expected: no errors (extension + webview).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean build, `out/extension.js` and the webview bundle produced.

- [ ] **Step 4: Manual sanity (optional, if running the extension)**

Launch the extension, start a config, hover the running row:
- A blue restart button appears to the LEFT of the red stop button.
- Click it → config stops, ~1s pause, config starts again.
- Start a config in Debug → restart → it comes back in Debug.
- Run with Monitoring → restart → monitoring re-attaches.

- [ ] **Step 5: Final note**

DO NOT COMMIT. Report completion to the user and let them review + commit manually.

---

## Self-Review

**Spec coverage:**
- Blue inline button, running-only, left of stop → Tasks 2 & 3. ✅
- Stop → wait 1s → start → Task 1 (`restartConfig`, `RESTART_DELAY_MS`). ✅
- Preserve debug mode → Task 1 (`wasDebugging` branch). ✅
- Preserve monitoring mode → Task 1 (`wasMonitoring` branch). ✅
- Right-click parity → Task 3 Step 3. ✅
- Docker excluded / no contextValue change → handled by the `configRunning…` regex (docker rows don't match). ✅
- Tests for 4 mode combinations + ordering → Task 1. ✅

**Placeholder scan:** No TBD/TODO; all code shown in full. ✅

**Type consistency:** `restartConfig(deps, config, folder)`, `RestartDeps` with `exec`/`dbg`/`monitoring`/`delayMs`, `RESTART_DELAY_MS` — names match across Tasks 1 and 4. `dbg.debug(cfg, folder, { monitor })` matches `DebugService.debug` signature (verified). `exec.run(cfg, folder, opts?)` and `exec.stop(id)` match `ExecutionService` (verified). ✅
