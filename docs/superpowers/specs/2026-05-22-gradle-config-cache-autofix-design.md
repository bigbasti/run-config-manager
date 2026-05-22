# Gradle Configuration Cache Auto-Fix Design

## Goal

Detect the Gradle configuration cache incompatibility error in terminal output and automatically offer to append `--no-configuration-cache` to the task field, persisting the fix to `.vscode/run.json`.

## Background

Gradle 9+ enables the configuration cache by default. Some Gradle plugins (notably the Liquibase Gradle plugin) call `Task.project` at execution time, which the configuration cache prohibits. This produces a hard build failure:

```
Invocation of 'Task.project' by task ':data:dropAll' at execution time is
unsupported with the configuration cache.
```

The fix is to pass `--no-configuration-cache` to Gradle. The extension already streams all terminal output through an `onOutput` callback in `ExecutionService`, making this detectable at runtime.

## Architecture

The feature follows the existing `maybeOfferPythonInstall` pattern in `ExecutionService`:

1. A regex matches the configuration cache error in the `onOutput` chunk handler.
2. A per-run guard prevents the toast from firing more than once per execution.
3. On user confirmation, `RunConfigService.update()` persists the amended task string.

No new files. All changes confined to `ExecutionService.ts`, `extension.ts` (wiring), and a new test file.

## Components

### Detection pattern

```ts
/Invocation of 'Task\.project'.*unsupported with the configuration cache/
```

Checked inside the existing `onOutput` callback, after the existing `failHit` / `readyHit` / `rebuildHit` checks. Only evaluated when `!useShellExecution` (CustomExecution path — the path where output is observable).

### Per-run deduplication

A `Set<string>` on `ExecutionService` named `configCacheToastShown` keyed by `cfg.id`. Cleared in `handleEnd` alongside the other state sets. Prevents repeated toasts if the error line appears multiple times in one run.

### Toast

```
"Gradle configuration cache is incompatible with this task. Add --no-configuration-cache?"
Buttons: "Fix and save"  |  "Dismiss"
```

### On "Fix and save"

```ts
// Guard: don't double-append
if (!task.includes('--no-configuration-cache')) {
  const updatedCfg = {
    ...cfg,
    typeOptions: { ...cfg.typeOptions, task: task + ' --no-configuration-cache' },
  };
  await svc.update(folderKey, updatedCfg);
  vscode.window.showInformationMessage(
    `"${cfg.name}" updated. Re-run to apply.`,
  );
}
```

`cfg` here is the **original** (unresolved) config — the one from `RunConfigService`, not `resolvedCfg`. This preserves any `${VAR}` tokens in other fields.

### `ExecutionService` constructor change

New optional last parameter:

```ts
constructor(
  private readonly registry: AdapterRegistry,
  private readonly monitoring?: MonitoringService,
  private readonly configSvc?: { update: (folderKey: string, cfg: RunConfig) => Promise<void>; getById: (id: string) => { folderKey: string; config: RunConfig } | undefined },
)
```

Using a structural type (duck type) rather than importing `RunConfigService` directly avoids a circular dependency risk and keeps tests simple — they can pass a plain object.

`getById` may return a `ConfigRef` with `valid: false` (an `InvalidConfigEntry`). `maybeOfferGradleConfigCacheFix` must guard for this and return early — an invalid entry has no well-typed `typeOptions.task` to amend.

`extension.ts` passes the real `RunConfigService` instance as the third argument.

### `maybeOfferGradleConfigCacheFix` private method

Signature:

```ts
private async maybeOfferGradleConfigCacheFix(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<void>
```

Called from `onOutput` when the pattern matches and the toast hasn't been shown yet for this run. Fire-and-forget (not awaited from `onOutput`, which is synchronous).

## Data flow

```
Gradle process stdout
  → RunTerminal.onOutput(chunk)
    → ExecutionService onOutput callback
      → existing fail/ready/rebuild checks
      → [NEW] configCachePattern.test(chunk)?
          → configCacheToastShown.has(cfg.id)? → skip
          → configCacheToastShown.add(cfg.id)
          → maybeOfferGradleConfigCacheFix(cfg, folder) [fire-and-forget]
              → showWarningMessage(...)
              → user clicks "Fix and save"
                  → configSvc.getById(cfg.id) → { folderKey, config: originalCfg }
                  → append flag to originalCfg.typeOptions.task
                  → configSvc.update(folderKey, updatedCfg)
                  → showInformationMessage("Re-run to apply")
```

## Scope constraints

- Only fires when `!useShellExecution` (CustomExecution / pseudoterminal path).
- Only fires for configs whose type produces observable Gradle output: `gradle-task`, `spring-boot` (gradle/java-main modes), `java` (gradle/gradle-custom modes), `quarkus` (gradle mode — but Quarkus uses ShellExecution so in practice excluded). The pattern match itself is the gate; no explicit type filter needed.
- The flag guard (`!task.includes('--no-configuration-cache')`) prevents double-appending on repeat runs before the user re-saves the config.

## Error handling

- If `configSvc` is absent (test environments that don't wire it), the method logs a warning and returns without showing the toast.
- If `configSvc.getById` returns undefined (config was deleted while running), the method returns silently.
- `configSvc.update` failure shows the error via the existing `vscode.window.showErrorMessage` helper.

## Testing

New test file: `test/services/GradleConfigCacheAutofix.test.ts`

Tests:
1. Toast shown when pattern matches in `onOutput`.
2. Toast not shown twice for the same run (deduplication guard).
3. Toast not shown when `configSvc` is absent.
4. `update` called with correct amended task string on "Fix and save".
5. `update` NOT called when task already contains `--no-configuration-cache`.
6. `configCacheToastShown` cleared when the task ends (`handleEnd`).

Uses the same mocking approach as `ExecutionService.test.ts` (mock `vscode`, mock `child_process`).

## Files changed

| File | Change |
|------|--------|
| `src/services/ExecutionService.ts` | Add `configSvc` optional param; add `configCacheToastShown` set; add pattern check in `onOutput`; add `maybeOfferGradleConfigCacheFix`; clear set in `handleEnd` |
| `src/extension.ts` | Pass `configSvc` (the `RunConfigService` instance) to `ExecutionService` constructor |
| `test/services/GradleConfigCacheAutofix.test.ts` | New test file (6 cases) |

No schema changes, no webview changes, no new dependencies.
