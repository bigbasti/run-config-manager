# Auto-Open Monitor View on Monitoring Attach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically open the monitor webview (`MonitorPanel`) when a config gains monitoring state, covering every monitored-start path (UI `runMonitored`/`debugMonitored` commands and the MCP `run_config`/`debug_config(monitor:true)` path).

**Architecture:** A pure, unit-tested decision helper `decideAutoOpen({ enabled, live, alreadyOpened })` returns `'open' | 'clear' | 'noop'`. `extension.ts` subscribes once to `monitoring.onChanged` and once to `nodeMonitoring.onChanged`, maintains a `Set<string>` of auto-opened config ids, calls the helper on each event, and acts (`open` → `MonitorPanel.open` + mark; `clear` → unmark; `noop` → nothing). A new setting `runConfigManager.monitoring.autoOpenView` (default `true`) gates the behavior.

**Tech Stack:** TypeScript, VS Code extension API, Jest (in-memory `vscode` mock), esbuild.

> **HARD RULE — DO NOT COMMIT.** This repo forbids auto-commits; the user reviews and commits manually. Every task ends by running verification only. Do NOT run `git add` or `git commit`. Leave all changes in the working tree.

**Spec:** `docs/superpowers/specs/2026-07-15-auto-open-monitor-view-design.md`

---

## File Structure

**Create:**
- `src/services/monitorAutoOpen.ts` — pure `decideAutoOpen` decision function (one responsibility, no vscode imports).
- `test/monitorAutoOpen.test.ts` — table-driven unit tests for the helper.

**Modify:**
- `package.json` — add the `runConfigManager.monitoring.autoOpenView` setting.
- `src/extension.ts` — subscribe to both monitoring services' `onChanged`, maintain the opened-ids set, wire `decideAutoOpen` to `MonitorPanel.open`.

**Shared contract (defined in Task 1, used in Task 3):**

```ts
export type AutoOpenAction = 'open' | 'clear' | 'noop';
export function decideAutoOpen(params: { enabled: boolean; live: boolean; alreadyOpened: boolean }): AutoOpenAction;
```

---

## Task 1: Pure decision helper `decideAutoOpen` (TDD)

**Files:**
- Create: `src/services/monitorAutoOpen.ts`
- Test: `test/monitorAutoOpen.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/monitorAutoOpen.test.ts`:

```ts
import { decideAutoOpen, AutoOpenAction } from '../src/services/monitorAutoOpen';

describe('decideAutoOpen', () => {
  // enabled, live, alreadyOpened -> expected action
  const cases: Array<[boolean, boolean, boolean, AutoOpenAction]> = [
    // not live -> always clear the guard, regardless of enabled/alreadyOpened
    [true, false, false, 'clear'],
    [true, false, true, 'clear'],
    [false, false, false, 'clear'],
    [false, false, true, 'clear'],
    // live but disabled -> noop
    [false, true, false, 'noop'],
    [false, true, true, 'noop'],
    // live, enabled, already opened -> noop (don't reopen after user closes)
    [true, true, true, 'noop'],
    // live, enabled, not yet opened -> open
    [true, true, false, 'open'],
  ];

  it.each(cases)(
    'enabled=%s live=%s alreadyOpened=%s -> %s',
    (enabled, live, alreadyOpened, expected) => {
      expect(decideAutoOpen({ enabled, live, alreadyOpened })).toBe(expected);
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/monitorAutoOpen.test.ts`
Expected: FAIL — cannot find module `../src/services/monitorAutoOpen`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/monitorAutoOpen.ts`:

```ts
// Pure decision for the reactive "auto-open monitor view" behavior. Kept free
// of vscode imports so it is unit-testable; extension.ts owns the side effects
// (the opened-ids Set and the MonitorPanel.open call).
export type AutoOpenAction = 'open' | 'clear' | 'noop';

// `live`         — monitoring state currently exists for the config id.
// `enabled`      — the runConfigManager.monitoring.autoOpenView setting.
// `alreadyOpened`— this id was already auto-opened this session (guard so
//                  closing the panel mid-run doesn't force it back open).
export function decideAutoOpen(params: {
  enabled: boolean;
  live: boolean;
  alreadyOpened: boolean;
}): AutoOpenAction {
  // When monitoring is gone (detach/stop), always clear the guard so the next
  // monitored run re-opens the panel — independent of the setting.
  if (!params.live) return 'clear';
  if (!params.enabled) return 'noop';
  if (params.alreadyOpened) return 'noop';
  return 'open';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/monitorAutoOpen.test.ts`
Expected: PASS (8 cases).

- [ ] **Step 5: Verify (DO NOT COMMIT)**

Run: `npm run typecheck`
Expected: PASS. Leave changes unstaged.

---

## Task 2: Add the `monitoring.autoOpenView` setting

**Files:**
- Modify: `package.json:45-51`

- [ ] **Step 1: Add the setting property**

In `package.json`, inside `contributes.configuration.properties`, add the new property after the existing `runConfigManager.mcp.enabled` block. Replace:

```json
        "runConfigManager.mcp.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Register the Run Configuration Manager MCP server so AI agents can read the config schema and manage run configurations."
        }
```

with:

```json
        "runConfigManager.mcp.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Register the Run Configuration Manager MCP server so AI agents can read the config schema and manage run configurations."
        },
        "runConfigManager.monitoring.autoOpenView": {
          "type": "boolean",
          "default": true,
          "description": "Automatically open the monitor view when a configuration is started with monitoring attached."
        }
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "require('./package.json'); console.log('ok')"`
Expected: prints `ok` (package.json is still valid JSON).

- [ ] **Step 3: Verify (DO NOT COMMIT)**

Leave changes unstaged.

---

## Task 3: Wire the reactive auto-open in extension.ts

**Files:**
- Modify: `src/extension.ts` (add import near line 33's `MonitorPanel` import if needed; add subscription block after line 185)

Context: `monitoring` (line 89), `nodeMonitoring` (line 91), `svc`, `store`, and `context` are all in scope by line 185. `MonitorPanel` is already imported (line 33). `MonitorPanel.open(cfg, extensionUri, monitoring, nodeMonitoring)` is idempotent. Both `monitoring.onChanged` and `nodeMonitoring.onChanged` are `vscode.Event<string>` (fire the config id) and return a `Disposable` when subscribed. Both services' `detach` fire `onChanged` after removing the entry, so `state(id)` is `undefined` at that point.

- [ ] **Step 1: Add the `decideAutoOpen` import**

In `src/extension.ts`, add this import alongside the other service imports (near the top with the other `./services/...` imports):

```ts
import { decideAutoOpen } from './services/monitorAutoOpen';
```

- [ ] **Step 2: Add the reactive subscription block**

In `src/extension.ts`, immediately after line 185 (`docker.onChanged(updateRunningState);`), insert:

```ts
  // Auto-open the monitor view when a config gains monitoring state. Monitoring
  // only ever attaches when { monitor: true } was requested, so this fires for
  // exactly the monitored-start paths (runMonitored/debugMonitored commands and
  // the MCP run_config/debug_config monitor path). One reactive hook covers all
  // of them. The guard set prevents re-opening a panel the user closed mid-run;
  // it is cleared on detach so the next monitored run re-opens.
  const autoOpenedMonitors = new Set<string>();
  const maybeAutoOpenMonitor = (id: string): void => {
    const enabled = vscode.workspace
      .getConfiguration('runConfigManager')
      .get<boolean>('monitoring.autoOpenView', true);
    const live = !!(monitoring.state(id) || nodeMonitoring.state(id));
    const action = decideAutoOpen({ enabled, live, alreadyOpened: autoOpenedMonitors.has(id) });
    if (action === 'clear') {
      autoOpenedMonitors.delete(id);
      return;
    }
    if (action === 'noop') return;
    const ref = svc.getById(id);
    if (!ref || !ref.valid) return;
    autoOpenedMonitors.add(id);
    MonitorPanel.open(ref.config as RunConfig, context.extensionUri, monitoring, nodeMonitoring);
  };
  context.subscriptions.push(monitoring.onChanged(maybeAutoOpenMonitor));
  context.subscriptions.push(nodeMonitoring.onChanged(maybeAutoOpenMonitor));
```

Note: `RunConfig` is already imported in `extension.ts` (used throughout); if a typecheck error says it is not, add it to the existing `./shared/types` import.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `RunConfig` is reported missing, add it to the existing `import { ... } from './shared/types'` line and re-run.

- [ ] **Step 4: Verify (DO NOT COMMIT)**

Leave changes unstaged.

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full test suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass EXCEPT the known pre-existing macOS-only flaky `test/detectTomcat.test.ts:73` (realpath `/tmp`→`/private/tmp` quirk) — if that is the only failure, treat the suite as passing; the new `test/monitorAutoOpen.test.ts` passes; build produces `out/extension.js` and `out/mcp-server.js`.

- [ ] **Step 2: Review the diff (DO NOT COMMIT)**

Run: `git status && git --no-pager diff --stat`
Expected: only these files changed — `src/services/monitorAutoOpen.ts` (new), `test/monitorAutoOpen.test.ts` (new), `package.json`, `src/extension.ts`. Leave committing to the user.

---

## Self-Review notes (addressed)

- **Spec coverage:** reactive single hook on both `onChanged` (Task 3); open-on-gain-state + mark, clear-on-lost-state, noop otherwise via `decideAutoOpen` (Task 1 + wiring Task 3); idempotent `MonitorPanel.open` reused (Task 3); config lookup via `svc.getById` skipping missing/invalid (Task 3); setting `runConfigManager.monitoring.autoOpenView` default true, checked at event time (Task 2 + Task 3); pure testable helper + test (Task 1); no extension.ts unit test per repo convention. All present.
- **Truth table consistency:** the `decideAutoOpen` cases in the Task 1 test exactly match the spec's four rules (`!live`→clear; `live&&!enabled`→noop; `live&&enabled&&alreadyOpened`→noop; else open).
- **Type consistency:** `AutoOpenAction`, `decideAutoOpen({ enabled, live, alreadyOpened })` identical across Task 1 and Task 3.
- **No-commit rule:** every task verifies only; Task 4 explicitly leaves committing to the user.
