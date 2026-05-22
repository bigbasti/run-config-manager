# Gradle Configuration Cache Auto-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect the Gradle configuration cache incompatibility error in terminal output and automatically offer to append `--no-configuration-cache` to the task field, persisting the fix to `.vscode/run.json`.

**Architecture:** Inside `ExecutionService`'s `onOutput` callback (which already receives every stdout/stderr chunk), match the Gradle configuration cache error regex. On match, show a VS Code warning toast; on "Fix and save", fetch the original config from `RunConfigService`, append the flag to `typeOptions.task`, and persist via `RunConfigService.update()`. `ExecutionService` receives `RunConfigService` as an optional third constructor parameter so existing callers remain unaffected.

**Tech Stack:** TypeScript, VS Code API (`vscode.window.showWarningMessage`, `vscode.window.showInformationMessage`), Jest (in-memory vscode mock).

---

## File Map

| File | Change |
|------|--------|
| `src/services/ExecutionService.ts` | Add optional `configSvc` 3rd constructor param; add `configCacheToastShown: Set<string>`; add pattern check in `onOutput`; add `maybeOfferGradleConfigCacheFix` private method; clear set in `handleEnd` and `stop` |
| `src/extension.ts` | Pass `svc` as 3rd arg to `new ExecutionService(...)` |
| `test/gradleConfigCacheAutofix.test.ts` | New test file — 6 cases |

---

## Task 1: Write the failing tests

**Files:**
- Create: `test/gradleConfigCacheAutofix.test.ts`

These tests read `ExecutionService.ts` source to assert the fix mechanism exists (same pattern as `test/preflightNpmDependencies.test.ts`). They will fail until Task 2 is done.

- [ ] **Step 1: Create the test file**

```typescript
// test/gradleConfigCacheAutofix.test.ts
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'ExecutionService.ts'),
  'utf8',
);

describe('Gradle config cache auto-fix — source-level guards', () => {
  test('defines the config cache error regex', () => {
    expect(src).toMatch(/Invocation of 'Task\\.project'/);
  });

  test('uses a per-run deduplication set (configCacheToastShown)', () => {
    expect(src).toMatch(/configCacheToastShown/);
  });

  test('calls maybeOfferGradleConfigCacheFix from onOutput', () => {
    expect(src).toMatch(/maybeOfferGradleConfigCacheFix/);
  });

  test('appends --no-configuration-cache to typeOptions.task', () => {
    expect(src).toMatch(/--no-configuration-cache/);
  });

  test('guards against double-appending the flag', () => {
    // The fix method must check whether the flag is already present
    // before appending, to avoid "task --no-configuration-cache --no-configuration-cache".
    expect(src).toMatch(/includes\('--no-configuration-cache'\)/);
  });

  test('accepts configSvc as optional third constructor parameter', () => {
    // Existing two-arg callers (tests, extension.ts before the wiring commit)
    // must not break. The param must be optional (? or default undefined).
    // Match "constructor(... configSvc?" or "configSvc?: "
    expect(src).toMatch(/configSvc\?/);
  });

  test('clears configCacheToastShown in handleEnd', () => {
    // The deduplication set must be cleared when the task ends so a
    // re-run of the same config can trigger the toast again if the
    // error still fires.
    const handleEndIdx = src.indexOf('private handleEnd(');
    expect(handleEndIdx).toBeGreaterThan(-1);
    const handleEndBody = src.slice(handleEndIdx, handleEndIdx + 600);
    expect(handleEndBody).toMatch(/configCacheToastShown\.delete/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /path/to/run-config-manager
npx jest test/gradleConfigCacheAutofix.test.ts --no-coverage
```

Expected: 7 failures — none of the patterns exist yet.

---

## Task 2: Implement the fix in ExecutionService

**Files:**
- Modify: `src/services/ExecutionService.ts`

Read the current file before editing. Key locations:
- Constructor: line ~114 — add optional third param.
- `configCacheToastShown` set: add alongside the other private sets (lines ~81-101).
- `onOutput` callback: line ~418 — add detection after the existing `rebuildHit` block.
- `handleEnd`: line ~802 — add `.delete(id)` alongside the other set clears.
- `stop`: line ~763 — add `.delete(configId)` alongside the other set clears.

The config cache error pattern to detect (matches Gradle 9.x output verbatim):
```
Invocation of 'Task.project' by task ':something' at execution time is unsupported with the configuration cache.
```

- [ ] **Step 1: Add the `configCacheToastShown` set and `configSvc` param to the class**

In `src/services/ExecutionService.ts`, find this block (around line 109-122):

```typescript
  private httpFlash = new Map<string, 'success' | 'warn' | 'error'>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private taskEndSub: vscode.Disposable;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly monitoring?: MonitoringService,
  ) {
```

Replace with:

```typescript
  private httpFlash = new Map<string, 'success' | 'warn' | 'error'>();
  // Tracks which config ids have already shown the "config cache incompatible"
  // toast in the current run. Cleared in handleEnd/stop so re-runs can
  // trigger the toast again if the error fires again.
  private configCacheToastShown = new Set<string>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private taskEndSub: vscode.Disposable;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly monitoring?: MonitoringService,
    private readonly configSvc?: {
      getById(id: string): { folderKey: string; config: RunConfig; valid: true } | { folderKey: string; config: unknown; valid: false } | undefined;
      update(folderKey: string, cfg: RunConfig): Promise<void>;
    },
  ) {
```

- [ ] **Step 2: Add the detection regex constant at the top of the file**

After the existing imports (around line 23, after `import * as pathModule from 'path';`), add:

```typescript
// Gradle 9+ aborts tasks that call Task.project at execution time when
// the configuration cache is enabled. This pattern matches the exact
// error line Gradle emits so we can offer a one-click fix.
const GRADLE_CONFIG_CACHE_PATTERN =
  /Invocation of 'Task\.project'.*unsupported with the configuration cache/;
```

- [ ] **Step 3: Add the detection call inside the `onOutput` callback**

In the `onOutput` callback (around line 441 in the current file), find this block:

```typescript
            const rebuildHit = rebuildPatterns.length ? firstMatch(chunk, rebuildPatterns) : null;
            if (rebuildHit) {
              markRebuilding(`matched rebuild pattern ${patternLabel(rebuildHit)}`);
            }
```

Add immediately after that block (still inside the `onOutput` arrow function):

```typescript
            // Gradle configuration cache incompatibility — offer one-click fix.
            // Only fire once per run (deduplication guard) and only when we
            // have a configSvc to persist the change through.
            if (
              !this.configCacheToastShown.has(cfg.id) &&
              GRADLE_CONFIG_CACHE_PATTERN.test(chunk)
            ) {
              this.configCacheToastShown.add(cfg.id);
              void this.maybeOfferGradleConfigCacheFix(cfg, folder);
            }
```

- [ ] **Step 4: Add the `maybeOfferGradleConfigCacheFix` private method**

Add this method at the end of the class body, just before the closing `}` of the class (before the standalone `buildCwd` function at the bottom):

```typescript
  // Shown when the terminal output contains the Gradle configuration cache
  // incompatibility error. Offers to append --no-configuration-cache to the
  // task field and persist the change to run.json so the next run succeeds
  // without user intervention.
  private async maybeOfferGradleConfigCacheFix(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
  ): Promise<void> {
    if (!this.configSvc) {
      log.warn(`Config cache fix: no configSvc wired — cannot auto-fix "${cfg.name}"`);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Gradle configuration cache is incompatible with this task. Add --no-configuration-cache to fix it?`,
      'Fix and save',
      'Dismiss',
    );
    if (choice !== 'Fix and save') return;

    // Re-fetch the config from the store rather than using the resolved copy —
    // we want to write back the original ${VAR} tokens, not the runtime values.
    const ref = this.configSvc.getById(cfg.id);
    if (!ref || !ref.valid) {
      log.warn(`Config cache fix: config "${cfg.id}" not found or invalid — cannot update`);
      return;
    }

    const originalCfg = ref.config as RunConfig;
    if (originalCfg.type !== 'gradle-task' && originalCfg.type !== 'spring-boot' &&
        originalCfg.type !== 'java' && originalCfg.type !== 'maven-goal') {
      // Only types that run Gradle directly can produce this error.
      log.warn(`Config cache fix: unexpected type "${originalCfg.type}" — skipping`);
      return;
    }

    // Type-narrowing: only gradle-task has typeOptions.task at top level.
    // For other Gradle types (spring-boot gradle mode, java gradle mode) the
    // user should add the flag to programArgs. For now we only auto-fix
    // gradle-task since that's the type with the named `task` field.
    if (originalCfg.type !== 'gradle-task') {
      vscode.window.showInformationMessage(
        `Add --no-configuration-cache to the task arguments in "${cfg.name}" to fix this.`,
      );
      return;
    }

    const currentTask: string = originalCfg.typeOptions.task ?? '';
    if (currentTask.includes('--no-configuration-cache')) {
      // Already present — nothing to do.
      vscode.window.showInformationMessage(
        `"${cfg.name}" already has --no-configuration-cache. Re-run to apply.`,
      );
      return;
    }

    const updatedCfg: RunConfig = {
      ...originalCfg,
      typeOptions: {
        ...originalCfg.typeOptions,
        task: currentTask + ' --no-configuration-cache',
      },
    };

    try {
      await this.configSvc.update(ref.folderKey, updatedCfg);
      vscode.window.showInformationMessage(
        `"${cfg.name}" updated. Re-run to apply.`,
      );
      log.info(`Config cache fix applied to "${cfg.name}": task="${updatedCfg.typeOptions.task}"`);
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to save fix for "${cfg.name}": ${(e as Error).message}`,
      );
    }
  }
```

- [ ] **Step 5: Clear `configCacheToastShown` in `handleEnd`**

In `handleEnd` (around line 802), find this block:

```typescript
        this.running.delete(id);
        this.started.delete(id);
        this.failed.delete(id);
        this.rebuilding.delete(id);
        this.emitter.fire(id);
        return;
```

Replace with:

```typescript
        this.running.delete(id);
        this.started.delete(id);
        this.failed.delete(id);
        this.rebuilding.delete(id);
        this.configCacheToastShown.delete(id);
        this.emitter.fire(id);
        return;
```

- [ ] **Step 6: Clear `configCacheToastShown` in `stop`**

In `stop` (around line 795), find this block:

```typescript
    this.running.delete(configId);
    this.started.delete(configId);
    this.failed.delete(configId);
    this.rebuilding.delete(configId);
    this.emitter.fire(configId);
```

Replace with:

```typescript
    this.running.delete(configId);
    this.started.delete(configId);
    this.failed.delete(configId);
    this.rebuilding.delete(configId);
    this.configCacheToastShown.delete(configId);
    this.emitter.fire(configId);
```

- [ ] **Step 7: Also clear in `dispose`**

In `dispose` (around line 827), find:

```typescript
    this.running.clear();
    this.started.clear();
    this.failed.clear();
    this.rebuilding.clear();
```

Replace with:

```typescript
    this.running.clear();
    this.started.clear();
    this.failed.clear();
    this.rebuilding.clear();
    this.configCacheToastShown.clear();
```

- [ ] **Step 8: Run the tests — they should now pass**

```bash
npx jest test/gradleConfigCacheAutofix.test.ts --no-coverage
```

Expected: 7 tests pass.

- [ ] **Step 9: Run the full test suite to check for regressions**

```bash
npm run typecheck && npx jest --no-coverage
```

Expected: all existing tests still pass (the new optional param doesn't break any existing constructor calls in tests).

---

## Task 3: Wire `configSvc` into `ExecutionService` in `extension.ts`

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Update the `ExecutionService` construction call**

In `src/extension.ts`, find line 81:

```typescript
  const exec = new ExecutionService(registry, monitoring);
```

Replace with:

```typescript
  const exec = new ExecutionService(registry, monitoring, svc);
```

`svc` is `RunConfigService`, constructed on line 77 — already in scope. `RunConfigService.getById` returns `ConfigRef | undefined` where `ConfigRef` is `{ folderKey, config, valid }` — the structural type on `ExecutionService`'s `configSvc` parameter matches this exactly.

- [ ] **Step 2: Run typecheck to confirm the wiring is type-safe**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run the full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass.

---

## Task 4: Final verification and build

**Files:** none — verification only.

- [ ] **Step 1: Run typecheck + tests + build**

```bash
npm run typecheck && npm test && npm run build
```

Expected:
- `typecheck`: no errors on either `tsconfig.extension.json` or `tsconfig.webview.json`
- `npm test`: all tests pass (930+ cases)
- `npm run build`: completes without errors, producing `out/extension.js` and `media/webview/assets/main.js`

DO NOT COMMIT — the user reviews and commits manually.

---

## Self-Review Checklist (completed by plan author)

**Spec coverage:**
- [x] Detection pattern (`GRADLE_CONFIG_CACHE_PATTERN`) — Task 2, Step 2
- [x] Per-run deduplication (`configCacheToastShown`) — Task 2, Steps 1, 5, 6, 7
- [x] Toast with "Fix and save" / "Dismiss" — Task 2, Step 4
- [x] Auto-save via `configSvc.update` — Task 2, Step 4
- [x] Guard against double-append — Task 2, Step 4 (`includes` check)
- [x] Guard for `valid: false` entries — Task 2, Step 4
- [x] Optional 3rd constructor param — Task 2, Step 1
- [x] `extension.ts` wiring — Task 3, Step 1
- [x] Tests — Task 1

**No placeholders:** confirmed — all code is complete.

**Type consistency:** `configSvc` structural type defined once in Step 1; used identically in `maybeOfferGradleConfigCacheFix` in Step 4. `RunConfig` type used throughout — no renames.
