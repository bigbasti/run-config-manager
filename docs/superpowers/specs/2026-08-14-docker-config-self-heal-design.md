# Docker config self-heal — design

Date: 2026-08-14
Status: approved, ready for planning

## Problem

A `type: 'docker'` run configuration stores `typeOptions.containerId`. When the
user re-creates the container — `docker compose up --force-recreate`, a rebuild,
`docker rm` + `docker run` — Docker assigns a **new** container id. The stored id
now points at nothing.

Today nothing repairs this. The tree renders a yellow warning icon with
description `not found` (`RunConfigTreeProvider.ts:483-487`) and a tooltip
telling the user to re-create the config
(`RunConfigTreeProvider.ts:459-461`). Run/Stop shell out to
`docker start|stop <stale-id>`, which exits non-zero, and the user gets
`docker start failed: Error response from daemon: No such container: …`
(`extension.ts:404-467`). The only remedy is manually re-picking the container in
the editor — every single time the container is re-created.

Container **names**, by contrast, are stable across re-creation: `docker compose`
derives them deterministically from the project + service name, and hand-run
containers keep whatever `--name` the user gave them. Docker also enforces name
uniqueness across all existing containers. A name is therefore a better identity
key than an id.

## Solution overview

Treat `containerName` as the durable identity and `containerId` as a cache of the
current instance. When a config's stored id no longer resolves but exactly one
live container carries the stored name, rewrite `containerId` in `.vscode/run.json`
and tell the user via an information notification.

Detection is driven by the existing `DockerService` 3-second `docker ps -a` poll,
so the repair happens in the background and the tree flips from `not found` to the
correct state without the user doing anything.

## Blocking precondition: `containerName` is never persisted

`DockerTypeOptions.containerName` already exists in `src/shared/types.ts:403-411`
and `src/shared/schema.ts:359-371`, documented as a "human-readable name snapshot".
It is **dead**: `DockerAdapter.getFormSchema` produces exactly two typeSpecific
fields — a `selectOrCustom` for `typeOptions.containerId` and a read-only `info`
banner — so no code path ever writes a name.
`EditorPanel.sanitizeConfig` (`EditorPanel.ts:1769-1779`) merely preserves the key
if it is already present, which it never is.

Consequently the "was X" tooltip fallback at `RunConfigTreeProvider.ts:449` can
never fire for form-created configs, and self-healing has nothing to match on.

**Resolution: opportunistic backfill.** Whenever the heal runs and sees a config whose
`containerId` still resolves, and the live container's name differs from the stored
`containerName` (including the missing case), write the live name into the config.
Silently, with no notification.

The heal runs on two triggers, and both are needed:

- **`docker.onChanged`** — an edge on the container list. Guaranteed to fire at least
  once per session via the initial `[] -> [containers]` transition (which is why
  `docker.start()` is called *after* the subscription is registered), so every
  pre-existing docker config becomes heal-capable shortly after activation.
- **`store.onChange`** — any config save. Required because `onChanged` is edge-triggered
  on containers, so saving a *new* docker config fires nothing. Without this trigger the
  backfill would wait for an unrelated container transition, and since Docker's `status`
  string is the practical clock, a config created against a long-lived container
  (`Up 5 days`) could wait up to a day to become heal-capable — precisely the window in
  which its first re-creation would fall back to the old broken behaviour.

The backfill's own write re-fires `store.onChange` while the runner is still in flight;
the drain coalesces it into one follow-up pass, which plans nothing because the stored
name now equals the live name. It therefore converges in a single extra pass.

This deliberately replaces an editor-side "write the name when the user picks a
container" change. The backfill covers newly-saved configs immediately via the
`store.onChange` trigger, covers pre-existing configs identically, and needs no change to
`DockerAdapter.getFormSchema` or `EditorPanel.sanitizeConfig`. The only gap is a
config saved while the Docker daemon is unreachable — and with no daemon there is
nothing to heal against anyway.

## Matching rules

Let `find(storedId)` be the existing bidirectional short/long id prefix match from
`DockerService.find` (`DockerService.ts:98-105`).

A config is skipped entirely when `typeOptions.containerId` is empty.

**Relink** is planned when all of:
1. `find(containerId)` is `undefined` (stale), and
2. `containerName` is non-empty, and
3. **exactly one** container in `docker.list()` has `name === containerName`.

Zero matches → no action (the container has not been re-created yet; a
`--force-recreate` window where the old container is removed and the new one not
yet started resolves itself on the next tick). Two or more matches → no action.
Docker enforces name uniqueness across all existing containers, so the multi-match
branch is unreachable in practice; it is a cheap correctness guard, not a
diagnostic, and deliberately does not log.

Name comparison is exact against `ContainerSummary.name`, which
`DockerService.poll` already normalises to the first alias
(`(row.Names ?? '').split(',')[0]`).

**Image is deliberately not part of the match.** A re-created container almost
always carries a rebuilt image; requiring an image match would defeat the feature.

**Backfill** is planned when `find(containerId)` resolves, the live summary's name
is non-empty, and it differs from the stored `containerName`. It writes
`containerName` only and never touches `containerId`.

At most one action is planned per config per tick — a config is either stale
(relink candidate) or live (backfill candidate), never both.

## Architecture

### Shared id predicate

Extract the bidirectional prefix rule from `DockerService.find` into a new
dependency-free module `src/services/containerMatch.ts`:

```ts
export function containerIdMatches(summaryId: string, storedId: string): boolean;
```

`find()` is rewritten to call it, and the planner imports it, so the two never
drift. It gets its own file rather than living in `DockerService.ts` because
`DockerService.ts` imports `vscode`; a value import from the planner would drag
`vscode` into an otherwise pure module. (`ContainerSummary` is imported into the
planner as a type-only import, which is erased at compile time.)

The extracted helper also adds a guard the original lacked: an empty
`summaryId` currently matches *any* stored id, because
`storedId.startsWith('')` is `true`. A malformed `docker ps` row with a blank id
would therefore match every config. `containerIdMatches` returns `false` when
either side is empty.

### Pure planner — `src/services/dockerConfigHealer.ts` (new)

```ts
export type HealAction =
  | {
      kind: 'relink';
      folderKey: string;
      configId: string;
      configName: string;
      oldContainerId: string;
      newContainerId: string;
      containerName: string;
    }
  | {
      kind: 'backfillName';
      folderKey: string;
      configId: string;
      containerName: string;
    };

export function planDockerHeal(input: {
  configs: Array<{ folderKey: string; config: RunConfig }>;
  containers: ContainerSummary[];
}): HealAction[];
```

No `vscode` import, no I/O, no persistence, no logging side effects. It takes the
caller's config refs and the container list and returns the actions to apply.
`extension.ts` passes only valid docker refs, but the planner also filters on
`config.type === 'docker'` itself so it is safe to call with a full config list and
its behaviour is fully specified by its own inputs. This mirrors the established
`src/services/monitorAutoOpen.ts` pure-helper
pattern: decision logic lives in a testable free function, `extension.ts` owns the
side effects.

`DockerService` itself is not modified beyond the `containerIdMatches` extraction
and the `summariesChanged` change below. It stays a dumb daemon poller with no
knowledge of run configurations.

### Event sensitivity

`summariesChanged` (`DockerService.ts:228-236`) compares only `id`, `state` and
`status`, so a pure `docker rename` fires no `onChanged` event and the backfill
would not observe the drift until some unrelated state change. Add `name` to the
comparison. One line; it only makes the event marginally more sensitive.

### Wiring — `dockerHealRunner.ts` + `extension.ts`

The side-effect layer lives in its own module, `src/services/dockerHealRunner.ts`,
rather than inline in `activate()`. `extension.ts` is excluded from coverage by repo
convention, and the concurrency logic below is the part most worth testing, so it must
not live there. `createDockerHealRunner(deps)` takes every vscode interaction as an
injected callback and returns the function to subscribe. `extension.ts` builds the deps
and subscribes it to both triggers, alongside the existing `maybeAutoOpenMonitor` hook:

```ts
context.subscriptions.push(docker.onChanged(() => { void runDockerHeal().catch(...); }));
context.subscriptions.push(store.onChange(() => { void runDockerHeal().catch(...); }));
```

The returned `runDockerHeal()`:

1. Return immediately if `runConfigManager.docker.autoRelink` is `false`, re-read per
   pass so the setting takes effect without a reload.
2. If a previous invocation is still in flight, set a `pending` flag and return; the
   in-flight call drains it via `do { pending = false; await healOnce(); } while (pending)`.
   Dropping the event would be unsafe: both triggers are edge-triggered, so a discarded
   event is never redelivered and the config it would have healed stays broken
   indefinitely.
3. Build the input from `svc.list()` — valid refs only, `config.type === 'docker'`
   — plus `docker.list()`. Call `planDockerHeal`.
4. Drop actions already present in an attempted-guard `Set<string>` keyed by
   `healActionKey(action)` — `` `${folderKey}:${configId}:${newContainerId}` `` for
   relinks, `` `${folderKey}:${configId}:name:${containerName}` `` for backfills. The
   folder is part of the key because config ids are only unique within a root. Prune
   guard entries whose key no longer appears in the plan, so a container that flaps away
   and back is healed again rather than silently skipped.
5. Apply sequentially. Immediately before each write, re-read the config with
   `svc.getById(id)` and bail on that action if it is missing, invalid, or no longer
   a docker config. Additionally re-validate the *precondition the plan was built on* —
   that `oldContainerId` is still the stored id (and, for backfills, that the name still
   differs). Existence alone is not enough: a user who re-pointed the config at a
   different container while the write was queued would otherwise be silently reverted.
   Also bail when the resolved `folderKey` differs from the planned one, since `getById`
   returns the first id match across all roots. Build the updated config by
   spreading `typeOptions`, as at `ExecutionService.ts:1221-1227`, and call
   `svc.update(folderKey, cfg)`.
6. Add the guard key **before** attempting the write, and never remove it on
   failure. A persistently failing write (read-only filesystem, for instance) is
   therefore attempted exactly once per distinct target rather than re-attempted —
   and re-notified — on every subsequent trigger. The failure path is `log.warn` plus a
   single `showErrorMessage`. Recovery is automatic when the situation changes, because a
   new container id produces a new guard key.
7. `log.info` one line per applied relink, including old id, new id and name.
   Backfills log at `debug` level.

### Notification

Only relinks notify; backfills are silent.

- Exactly one relink:
  `"API Server" now points at the re-created container "myapp-api".`
- Two or more relinks in one pass (the `docker compose up --force-recreate` case):
  `Updated 4 Docker configurations to point at re-created containers.` with a
  `Show Details` button that calls `log.show()`. The per-action `log.info` lines
  from step 7 are the detail.

The container id is deliberately absent from both toasts — it is the one detail a user
does not need in a "this was fixed for you" message. The full old and new ids appear in
the `log.info` line for anyone debugging.

`showInformationMessage` in both cases. No prompt, no undo — the change is
non-destructive (the old id was already worthless) and prompting would nag on every
compose restart.

### Setting

New in `package.json` `contributes.configuration.properties`, next to
`runConfigManager.monitoring.autoOpenView` (`package.json:51-55`):

```json
"runConfigManager.docker.autoRelink": {
  "type": "boolean",
  "default": true,
  "description": "When a Docker configuration's container has been re-created with a new id, automatically re-link the configuration to the container with the same name."
}
```

Read at event time (not cached at activation), gating both the relink and the
backfill. When off, behaviour is exactly as today: the tree shows `not found`.

## Data flow

1. User runs `docker compose up --force-recreate`.
2. Within 3s `DockerService.poll` sees a different id set, `summariesChanged`
   returns true, `onChanged` fires.
3. `applyDockerHeal` builds the plan: the config's stored id no longer resolves,
   its stored `containerName` matches exactly one live container → `relink`.
4. `svc.getById` re-read, `svc.update` writes `.vscode/run.json` atomically.
5. `ConfigStore.write` fires `onChange(folderKey)` → tree refresh. The row's stale
   `not found` state is gone. (The FS watcher also fires a debounced reload; this
   is the normal double-notify already present for every save and is harmless.)
6. `showInformationMessage` tells the user what happened.

No feedback loop exists: the config write does not trigger a Docker poll.

## Failure modes and edge cases

| Situation | Behaviour |
|---|---|
| Docker daemon unreachable | `poll` clears the cache and fires `onChanged` once. Plan sees an empty container list: every config is stale with zero name matches → no actions, no notifications. |
| Mid-recreate window (old removed, new not yet up) | Stale with zero name matches → no action. Heals on a later event. |
| Config has an empty `containerId` | Skipped. |
| Config has a stale id and no stored `containerName` | Not healable. Renders `not found` as today. Once the user re-picks the container manually, the backfill captures the name and future re-creations self-heal. |
| Two containers share the stored name | No action. Unreachable in practice; Docker enforces name uniqueness. |
| User edits the config concurrently | The `svc.getById` re-read immediately before the write means the healer writes on top of the current stored config, not the snapshot — and it re-checks that `oldContainerId` is still stored, so an edit that re-points the config at a different container cancels the heal instead of being reverted. |
| Write fails (read-only FS, etc.) | One `showErrorMessage` + `log.warn`. The guard key was added before the attempt and is not cleared, so there is no repeating error-toast loop. A changed container id yields a new key and a fresh attempt. |
| Multi-root workspace | `svc.list()` returns `folderKey` per ref; `svc.update(folderKey, cfg)` targets the right `.vscode/run.json`. `folderKey` is part of the guard key, and a write is skipped when the re-read resolves to a different root, so duplicate config ids across roots cannot collide. |
| Setting turned off mid-session | Read at event time, so it takes effect on the next event with no reload. |

## Testing

New `test/dockerConfigHealer.test.ts`, pure object fixtures, no `vscode` mocking
required beyond the existing module mapper:

- stale id + stored name matching exactly one live container → one `relink` with the
  correct old/new ids
- stale id + no stored name → no actions
- stale id + stored name absent from the container list → no actions
- stale id + stored name matching two containers → no actions
- live id + live name differs from stored name → one `backfillName`
- live id + stored name missing → one `backfillName`
- live id + names equal → no actions
- empty `containerId` → no actions
- stored 12-char short id vs. full id reported by `docker ps --no-trunc` → treated as
  live, not stale (guards the `containerIdMatches` extraction)
- non-docker configs in the input are ignored
- multiple configs → one action each, order-independent assertions
- `healActionKey` produces distinct keys for relink vs. backfill on the same config,
  and distinct keys for the same config id in two different workspace roots

New `test/containerMatch.test.ts`: full/full, short-stored/full-summary,
full-stored/short-summary, unrelated ids, empty stored id, empty summary id.

New `test/DockerService.test.ts`: `summariesChanged` returns true on a
name-only difference (the new behaviour) and on the pre-existing id/state/status
differences, false for identical lists; plus `find` delegation to
`containerIdMatches`. `summariesChanged` is exported from `DockerService.ts` for this.
This is the first test to construct a real `DockerService`, whose constructor
subscribes to `vscode.window.onDidCloseTerminal`, so that event had to be added to
`__mocks__/vscode.ts`.

New `test/dockerHealRunner.test.ts` covers the side-effect layer, which is the reason
it was extracted from `extension.ts`: disabled setting, single relink, silent backfill,
convergence (a second pass after a backfill writes nothing), drain-not-drop of an event
arriving mid-write, single attempt on a persistently failing write, the precondition and
folder-mismatch bail-outs, guard pruning so a flapped container is re-healed, and
per-batch notification coalescing.

`test/DockerAdapter.test.ts` and its `FakeDockerService` are untouched.
`src/extension.ts` is excluded from coverage per repo convention
(`jest.config.js`), so the subscriber body stays thin and the logic under test lives
entirely in `planDockerHeal` and `createDockerHealRunner`.

Verification: `npm run typecheck && npm test && npm run build`. Note the known
environment-specific failure in `test/detectTomcat.test.ts:73` on macOS
(`/tmp` → `/private/tmp` realpath), unrelated to this change.

## Non-goals

- Healing configs that never had a stored name *and* whose container is already
  gone. There is nothing to match on.
- Image-based or fuzzy fallback matching.
- Any prompt, confirmation, or undo affordance.
- Changing `DockerAdapter.buildCommand` (still the `docker start` stub) or closing
  the MCP docker routing gap (`bridgeServices.ts` sends docker configs through
  `ExecutionService`, which has no docker branch).
- Auto-creating a container that does not exist at all.
- Changing the `not found` tree rendering, which remains correct for the
  genuinely-unhealable cases.
