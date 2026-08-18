# Docker Config Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Docker container is re-created and gets a new id, automatically re-link the run configuration by matching on the container name, and tell the user via a VS Code notification.

**Architecture:** A pure, unit-tested planner `planDockerHeal({ configs, containers })` returns `relink` / `backfillName` actions. `extension.ts` subscribes once to the existing `DockerService.onChanged` 3-second poll, applies the actions via `svc.update`, and shows a coalesced information notification. `DockerService` gains no knowledge of run configurations — it only gets its id-matching predicate extracted into a shared module and one extra field in its change detection.

**Tech Stack:** TypeScript, VS Code extension API, Jest with the in-memory `__mocks__/vscode.ts`, Zod (unchanged — the `containerName` field already exists in the schema).

**Spec:** `docs/superpowers/specs/2026-08-14-docker-config-self-heal-design.md`

**Repo rule — read this before you start:** NEVER run `git commit`. The user reviews and commits manually. The commit steps in this plan are written as `git add` only; stage the files and stop there.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/services/containerMatch.ts` | **create** | Single source of truth for the bidirectional short/long container-id prefix match. No imports at all — deliberately dependency-free so the pure planner can use it without pulling in `vscode`. |
| `test/containerMatch.test.ts` | **create** | Unit tests for the above. |
| `src/services/DockerService.ts` | modify | Use the extracted predicate in `find()`. Export `summariesChanged` and add `name` to its comparison. Nothing else changes — it stays a dumb daemon poller. |
| `test/dockerSummaries.test.ts` | **create** | Unit tests for `summariesChanged`. |
| `src/services/dockerConfigHealer.ts` | **create** | The pure planner: `HealAction`, `planDockerHeal`, `healActionKey`. No `vscode` import, no I/O, no logging. |
| `test/dockerConfigHealer.test.ts` | **create** | Unit tests for the planner — this is where essentially all of the feature's logic is verified. |
| `package.json` | modify | New `runConfigManager.docker.autoRelink` setting. |
| `src/extension.ts` | modify | Import the planner, add the `applyDockerHeal` side-effect function and the `docker.onChanged` subscription. Excluded from coverage by repo convention, so this stays thin. |
| `docs/LLM_ONBOARDING.md` | modify | One line in the DockerService bullet so the next session knows this exists. |

Task order is dependency-ordered: the shared predicate first (the planner needs it), then the planner, then the setting, then the wiring that consumes both.

---

## Task 1: Extract the container-id matching predicate

`DockerService.find` matches short (12-char) ids against full (64-char) ids by
comparing prefixes in both directions. The planner needs exactly the same rule.
Duplicating it would guarantee drift, so extract it into a module with zero
imports — the planner must stay free of `vscode`, and `DockerService.ts` imports
`vscode` at the top.

The extraction also fixes a latent bug: the current inline version treats an
empty summary id as matching *every* stored id, because `'anything'.startsWith('')`
is `true`. A malformed `docker ps` row (the parser tolerates those) would match
every docker config.

**Files:**
- Create: `src/services/containerMatch.ts`
- Create: `test/containerMatch.test.ts`
- Modify: `src/services/DockerService.ts:98-105`

- [ ] **Step 1: Write the failing test**

Create `test/containerMatch.test.ts`:

```ts
import { containerIdMatches } from '../src/services/containerMatch';

const FULL = 'a1b2c3d4e5f6' + '0'.repeat(52); // 64 chars, as `docker ps --no-trunc` reports
const SHORT = 'a1b2c3d4e5f6'; // 12 chars, as `docker ps` prints and users copy

describe('containerIdMatches', () => {
  it('matches identical full ids', () => {
    expect(containerIdMatches(FULL, FULL)).toBe(true);
  });

  it('matches a stored short id against a reported full id', () => {
    expect(containerIdMatches(FULL, SHORT)).toBe(true);
  });

  it('matches a stored full id against a reported short id', () => {
    expect(containerIdMatches(SHORT, FULL)).toBe(true);
  });

  it('does not match unrelated ids', () => {
    expect(containerIdMatches(FULL, 'f' + '0'.repeat(63))).toBe(false);
  });

  it('does not match when the stored id is empty', () => {
    expect(containerIdMatches(FULL, '')).toBe(false);
  });

  // Regression: `docker ps` rows can be malformed mid-removal and yield a blank
  // id. `storedId.startsWith('')` is true, so a naive prefix check would match
  // every configuration against that row.
  it('does not match when the reported id is empty', () => {
    expect(containerIdMatches('', SHORT)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/containerMatch.test.ts`

Expected: FAIL — `Cannot find module '../src/services/containerMatch'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/containerMatch.ts`:

```ts
// Shared by DockerService.find and the config self-healer. Deliberately has no
// imports — the healer must stay free of `vscode`, and DockerService.ts pulls
// `vscode` in at the top of the file.
//
// Docker reports full 64-char ids with `--no-trunc`, but users routinely save
// the 12-char short form because that is what plain `docker ps` prints and what
// they copy. Compare prefixes in both directions so either representation of
// the same container compares equal.
//
// Both sides must be non-empty: `docker ps` output can be malformed while a
// container is being removed, and `anything.startsWith('')` is true, so a blank
// reported id would otherwise match every stored id.
export function containerIdMatches(summaryId: string, storedId: string): boolean {
  if (!summaryId || !storedId) return false;
  return (
    summaryId === storedId || summaryId.startsWith(storedId) || storedId.startsWith(summaryId)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/containerMatch.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Rewire `DockerService.find` to use it**

In `src/services/DockerService.ts`, add to the imports at the top (after the `log` import on line 3):

```ts
import { containerIdMatches } from './containerMatch';
```

Then replace the whole of `find` (currently lines 98-105):

```ts
  find(containerId: string): ContainerSummary | undefined {
    if (!containerId) return undefined;
    // Users may save a short id (12 chars); Docker reports both — match on
    // prefix in either direction so either representation works.
    return this.cache.find(
      c => c.id === containerId || c.id.startsWith(containerId) || containerId.startsWith(c.id),
    );
  }
```

with:

```ts
  find(containerId: string): ContainerSummary | undefined {
    if (!containerId) return undefined;
    return this.cache.find(c => containerIdMatches(c.id, containerId));
  }
```

- [ ] **Step 6: Verify nothing regressed**

Run: `npm run typecheck && npx jest test/DockerAdapter.test.ts test/containerMatch.test.ts`

Expected: typecheck clean, both suites PASS. (`test/DockerAdapter.test.ts` uses its
own `FakeDockerService` and does not exercise the real `find`, but it is the
closest existing guard.)

- [ ] **Step 7: Stage the changes — DO NOT COMMIT**

```bash
git add src/services/containerMatch.ts test/containerMatch.test.ts src/services/DockerService.ts
```

Suggested message for the user (do not run it): `refactor(docker): extract containerIdMatches predicate`

---

## Task 2: Make `summariesChanged` sensitive to container renames

`DockerService.poll` only fires `onChanged` when `summariesChanged` returns true,
and that function currently compares `id`, `state` and `status` only. A bare
`docker rename` therefore fires no event, so the name-backfill added in Task 6
would not observe the drift until some unrelated state change happened to fire.
Adding `name` to the comparison makes the event marginally more sensitive and
nothing else.

**Files:**
- Modify: `src/services/DockerService.ts:228-236`
- Create: `test/dockerSummaries.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dockerSummaries.test.ts`:

```ts
import { summariesChanged, type ContainerSummary } from '../src/services/DockerService';

function mk(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: 'a'.repeat(64),
    name: 'myapp-api',
    image: 'myapp:latest',
    state: 'running',
    status: 'Up 3 minutes',
    ports: '',
    ...over,
  };
}

describe('summariesChanged', () => {
  it('is false for identical lists', () => {
    expect(summariesChanged([mk()], [mk()])).toBe(false);
  });

  it('is true when the length differs', () => {
    expect(summariesChanged([mk()], [])).toBe(true);
  });

  it('is true when an id differs', () => {
    expect(summariesChanged([mk()], [mk({ id: 'b'.repeat(64) })])).toBe(true);
  });

  it('is true when a state differs', () => {
    expect(summariesChanged([mk()], [mk({ state: 'exited' })])).toBe(true);
  });

  it('is true when a status differs', () => {
    expect(summariesChanged([mk()], [mk({ status: 'Exited (0) 1 second ago' })])).toBe(true);
  });

  // New: a bare `docker rename` must fire onChanged so the config self-healer
  // can refresh the stored containerName it later re-matches on.
  it('is true when only the name differs', () => {
    expect(summariesChanged([mk()], [mk({ name: 'myapp-api-2' })])).toBe(true);
  });

  it('ignores image and ports churn', () => {
    expect(summariesChanged([mk()], [mk({ image: 'other:1', ports: '80->80/tcp' })])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/dockerSummaries.test.ts`

Expected: FAIL — TypeScript/Jest error that `summariesChanged` is not exported
from `../src/services/DockerService`.

- [ ] **Step 3: Export the function and add the name comparison**

In `src/services/DockerService.ts`, replace the whole of `summariesChanged`
(currently lines 228-236):

```ts
function summariesChanged(a: ContainerSummary[], b: ContainerSummary[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].state !== b[i].state || a[i].status !== b[i].status) {
      return true;
    }
  }
  return false;
}
```

with:

```ts
// Exported for unit tests. `image` and `ports` are deliberately excluded — they
// churn without any UI-visible consequence. `name` IS compared so that a bare
// `docker rename` fires onChanged: the config self-healer backfills
// typeOptions.containerName from that event, and the name is the key it later
// re-matches a re-created container on.
export function summariesChanged(a: ContainerSummary[], b: ContainerSummary[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].state !== b[i].state ||
      a[i].status !== b[i].status ||
      a[i].name !== b[i].name
    ) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/dockerSummaries.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Stage the changes — DO NOT COMMIT**

```bash
git add src/services/DockerService.ts test/dockerSummaries.test.ts
```

Suggested message for the user: `fix(docker): fire onChanged on container rename`

---

## Task 3: The planner — relink actions

This is the core decision logic. It is a pure function so that all of the
feature's behaviour is testable without mocking `vscode`, the Docker CLI, or the
filesystem. `extension.ts` (excluded from coverage by repo convention) does
nothing but apply what this returns.

Background you need: a `RunConfig` with `type: 'docker'` has
`typeOptions: { containerId: string; containerName?: string }`. The id changes
every time the container is re-created; the name does not. So the name is the
durable identity and the id is a cache.

This task implements only the **relink** half (stale id → new id). Task 4 adds
the **backfill** half.

**Files:**
- Create: `src/services/dockerConfigHealer.ts`
- Create: `test/dockerConfigHealer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/dockerConfigHealer.test.ts`:

```ts
import { planDockerHeal, healActionKey } from '../src/services/dockerConfigHealer';
import type { ContainerSummary } from '../src/services/DockerService';
import type { RunConfig } from '../src/shared/types';

const OLD_ID = 'a'.repeat(64);
const NEW_ID = 'b'.repeat(64);

function mkSummary(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: NEW_ID,
    name: 'myapp-api',
    image: 'myapp:latest',
    state: 'running',
    status: 'Up 3 minutes',
    ports: '',
    ...over,
  };
}

function mkDocker(over: {
  id?: string;
  name?: string;
  containerId?: string;
  containerName?: string;
} = {}): { folderKey: string; config: RunConfig } {
  const {
    id = 'cfg-1',
    name = 'API Server',
    containerId = OLD_ID,
    containerName,
  } = over;
  return {
    folderKey: '/ws',
    config: {
      id,
      name,
      type: 'docker',
      projectPath: '',
      workspaceFolder: '/ws',
      env: {},
      programArgs: '',
      vmArgs: '',
      typeOptions: {
        containerId,
        ...(containerName !== undefined ? { containerName } : {}),
      },
    },
  };
}

function mkNpm(): { folderKey: string; config: RunConfig } {
  return {
    folderKey: '/ws',
    config: {
      id: 'cfg-npm',
      name: 'Web',
      type: 'npm',
      projectPath: '',
      workspaceFolder: '/ws',
      env: {},
      programArgs: '',
      vmArgs: '',
      typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' },
    },
  };
}

describe('planDockerHeal — relink', () => {
  it('relinks a stale id to the container with the same name', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerName: 'myapp-api' })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([
      {
        kind: 'relink',
        folderKey: '/ws',
        configId: 'cfg-1',
        configName: 'API Server',
        oldContainerId: OLD_ID,
        newContainerId: NEW_ID,
        containerName: 'myapp-api',
      },
    ]);
  });

  it('does nothing when the config has no stored container name', () => {
    const actions = planDockerHeal({
      configs: [mkDocker()],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([]);
  });

  // Mid-recreate window: the old container is gone, the new one is not up yet.
  it('does nothing when no live container carries the stored name', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerName: 'myapp-api' })],
      containers: [mkSummary({ name: 'unrelated' })],
    });
    expect(actions).toEqual([]);
  });

  // Unreachable in practice (Docker enforces unique names) but the guard must
  // hold: ambiguity means we must not guess.
  it('does nothing when two live containers carry the stored name', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerName: 'myapp-api' })],
      containers: [mkSummary(), mkSummary({ id: 'c'.repeat(64) })],
    });
    expect(actions).toEqual([]);
  });

  it('does nothing when the config has no container selected', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: '', containerName: 'myapp-api' })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([]);
  });

  it('ignores non-docker configs', () => {
    const actions = planDockerHeal({ configs: [mkNpm()], containers: [mkSummary()] });
    expect(actions).toEqual([]);
  });

  it('plans one relink per affected config', () => {
    const actions = planDockerHeal({
      configs: [
        mkDocker({ id: 'cfg-1', containerName: 'myapp-api' }),
        mkDocker({ id: 'cfg-2', name: 'DB', containerName: 'myapp-db' }),
      ],
      containers: [mkSummary(), mkSummary({ id: 'd'.repeat(64), name: 'myapp-db' })],
    });
    expect(actions).toHaveLength(2);
    expect(actions.map(a => a.configId).sort()).toEqual(['cfg-1', 'cfg-2']);
    expect(actions.every(a => a.kind === 'relink')).toBe(true);
  });

  // Guards the containerIdMatches extraction from Task 1: a stored short id and
  // the full id `docker ps --no-trunc` reports are the same container.
  it('treats a stored short id as live against the reported full id', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID.slice(0, 12), containerName: 'myapp-api' })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([]);
  });
});

describe('healActionKey', () => {
  it('distinguishes a relink from a backfill on the same config', () => {
    const relink = healActionKey({
      kind: 'relink',
      folderKey: '/ws',
      configId: 'cfg-1',
      configName: 'API Server',
      oldContainerId: OLD_ID,
      newContainerId: NEW_ID,
      containerName: 'myapp-api',
    });
    const backfill = healActionKey({
      kind: 'backfillName',
      folderKey: '/ws',
      configId: 'cfg-1',
      containerName: 'myapp-api',
    });
    expect(relink).not.toEqual(backfill);
  });

  it('changes when the target container id changes', () => {
    const base = {
      kind: 'relink' as const,
      folderKey: '/ws',
      configId: 'cfg-1',
      configName: 'API Server',
      oldContainerId: OLD_ID,
      containerName: 'myapp-api',
    };
    expect(healActionKey({ ...base, newContainerId: NEW_ID })).not.toEqual(
      healActionKey({ ...base, newContainerId: 'c'.repeat(64) }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/dockerConfigHealer.test.ts`

Expected: FAIL — `Cannot find module '../src/services/dockerConfigHealer'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/dockerConfigHealer.ts`:

```ts
import type { RunConfig } from '../shared/types';
import type { ContainerSummary } from './DockerService';
import { containerIdMatches } from './containerMatch';

// Pure decision logic for repairing Docker run configurations whose stored
// container id has gone stale. Kept free of vscode imports and of any I/O so it
// is unit-testable; extension.ts owns the side effects (config writes, the
// attempted-guard Set, and the notification).
//
// `ContainerSummary` is a type-only import, so DockerService's `vscode` import
// is erased at compile time and never reaches this module at runtime.
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

export interface HealInput {
  // Caller passes valid config refs. Non-docker entries are filtered here too,
  // so the function's behaviour is fully specified by its own inputs.
  configs: Array<{ folderKey: string; config: RunConfig }>;
  containers: ContainerSummary[];
}

export function planDockerHeal(input: HealInput): HealAction[] {
  const out: HealAction[] = [];

  for (const { folderKey, config } of input.configs) {
    if (config.type !== 'docker') continue;

    const to = config.typeOptions;
    const storedId = (to.containerId ?? '').trim();
    if (!storedId) continue; // nothing selected — not our problem

    const live = input.containers.find(c => containerIdMatches(c.id, storedId));
    if (live) continue; // handled in Task 4

    // Stale id. Container names survive re-creation (compose derives them
    // deterministically from project + service), so the name is the identity we
    // re-match on. Image is deliberately NOT compared: a re-created container
    // usually carries a freshly built image, which is exactly the case we exist
    // to handle.
    const storedName = (to.containerName ?? '').trim();
    if (!storedName) continue;

    const byName = input.containers.filter(c => c.name === storedName);
    // 0 = not re-created yet (or mid-recreate); >1 = ambiguous, never guess.
    // Docker enforces name uniqueness so >1 is unreachable, but guessing here
    // would silently point a config at the wrong container.
    if (byName.length !== 1) continue;

    out.push({
      kind: 'relink',
      folderKey,
      configId: config.id,
      configName: config.name,
      oldContainerId: storedId,
      newContainerId: byName[0].id,
      containerName: storedName,
    });
  }

  return out;
}

// Identity of an action for the caller's "already attempted" guard. Keyed by
// the TARGET, not just the config, so a container that flaps away and back is
// healed again rather than suppressed forever.
export function healActionKey(action: HealAction): string {
  return action.kind === 'relink'
    ? `${action.configId}:${action.newContainerId}`
    : `${action.configId}:name:${action.containerName}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/dockerConfigHealer.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: clean. If `config.typeOptions` does not narrow to
`DockerTypeOptions` after the `config.type !== 'docker'` guard, the discriminated
union is being widened somewhere — do not add a cast, fix the guard.

- [ ] **Step 6: Stage the changes — DO NOT COMMIT**

```bash
git add src/services/dockerConfigHealer.ts test/dockerConfigHealer.test.ts
```

Suggested message for the user: `feat(docker): plan re-link of stale container ids`

---

## Task 4: The planner — name backfill

`DockerTypeOptions.containerName` exists in `src/shared/types.ts:403-411` and
`src/shared/schema.ts:359-371`, but **nothing has ever written it**:
`DockerAdapter.getFormSchema` only produces a field for
`typeOptions.containerId`, and `EditorPanel.sanitizeConfig` merely preserves the
name key if already present. So every existing docker config has no name, and
Task 3's relink can never fire for them.

The fix is to capture the name opportunistically: whenever a config's id still
resolves, record the live container's name. This covers pre-existing configs and
newly-saved ones identically, within one poll tick, with no change to the editor
or the form schema. It is silent — the user never sees a notification for it.

**Files:**
- Modify: `src/services/dockerConfigHealer.ts`
- Modify: `test/dockerConfigHealer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/dockerConfigHealer.test.ts` (after the `planDockerHeal — relink`
describe block, before the `healActionKey` block):

```ts
describe('planDockerHeal — name backfill', () => {
  it('backfills a missing container name while the container still exists', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([
      {
        kind: 'backfillName',
        folderKey: '/ws',
        configId: 'cfg-1',
        containerName: 'myapp-api',
      },
    ]);
  });

  it('updates a stored name that has drifted (docker rename)', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID, containerName: 'old-name' })],
      containers: [mkSummary({ name: 'myapp-api' })],
    });
    expect(actions).toEqual([
      {
        kind: 'backfillName',
        folderKey: '/ws',
        configId: 'cfg-1',
        containerName: 'myapp-api',
      },
    ]);
  });

  it('does nothing when the stored name already matches', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID, containerName: 'myapp-api' })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([]);
  });

  it('does not backfill an empty name', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID })],
      containers: [mkSummary({ name: '' })],
    });
    expect(actions).toEqual([]);
  });

  // Backfill enables a future relink: it must also fire for a config whose id
  // is stored in short form.
  it('backfills against a stored short id', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID.slice(0, 12) })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([
      {
        kind: 'backfillName',
        folderKey: '/ws',
        configId: 'cfg-1',
        containerName: 'myapp-api',
      },
    ]);
  });

  it('plans at most one action per config', () => {
    const actions = planDockerHeal({
      configs: [
        mkDocker({ id: 'cfg-1', containerId: NEW_ID }),
        mkDocker({ id: 'cfg-2', containerId: OLD_ID, containerName: 'myapp-api' }),
      ],
      containers: [mkSummary()],
    });
    expect(actions).toHaveLength(2);
    expect(actions.find(a => a.configId === 'cfg-1')?.kind).toBe('backfillName');
    expect(actions.find(a => a.configId === 'cfg-2')?.kind).toBe('relink');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/dockerConfigHealer.test.ts -t "name backfill"`

Expected: FAIL — the backfill cases return `[]` because Task 3's implementation
has `if (live) continue;`.

- [ ] **Step 3: Implement the backfill branch**

In `src/services/dockerConfigHealer.ts`, replace this line inside the loop:

```ts
    const live = input.containers.find(c => containerIdMatches(c.id, storedId));
    if (live) continue; // handled in Task 4
```

with:

```ts
    const live = input.containers.find(c => containerIdMatches(c.id, storedId));

    if (live) {
      // The container still exists, so there is nothing to repair — but keep
      // the durable name key fresh so a FUTURE re-creation can be matched.
      // This is what makes the feature work for configs created before it
      // existed: nothing has ever written containerName, so without this
      // backfill there would be nothing to re-match on. Silent by design.
      const liveName = live.name.trim();
      if (liveName && liveName !== (to.containerName ?? '').trim()) {
        out.push({
          kind: 'backfillName',
          folderKey,
          configId: config.id,
          containerName: liveName,
        });
      }
      continue;
    }
```

- [ ] **Step 4: Run the whole planner suite**

Run: `npx jest test/dockerConfigHealer.test.ts`

Expected: PASS, 16 tests. Both describe blocks green — confirm the Task 3 relink
tests still pass, in particular `treats a stored short id as live against the
reported full id`, which now returns `[]` for a different reason (names match)
than it did before.

- [ ] **Step 5: Stage the changes — DO NOT COMMIT**

```bash
git add src/services/dockerConfigHealer.ts test/dockerConfigHealer.test.ts
```

Suggested message for the user: `feat(docker): backfill container name for stale-id recovery`

---

## Task 5: Add the `docker.autoRelink` setting

**Files:**
- Modify: `package.json:45-56`

- [ ] **Step 1: Add the property**

In `package.json`, inside `contributes.configuration.properties`, add a third
entry after `runConfigManager.monitoring.autoOpenView`. The block currently ends:

```json
        "runConfigManager.monitoring.autoOpenView": {
          "type": "boolean",
          "default": true,
          "description": "Automatically open the monitor view when a configuration is started with monitoring attached."
        }
      }
```

Make it:

```json
        "runConfigManager.monitoring.autoOpenView": {
          "type": "boolean",
          "default": true,
          "description": "Automatically open the monitor view when a configuration is started with monitoring attached."
        },
        "runConfigManager.docker.autoRelink": {
          "type": "boolean",
          "default": true,
          "description": "When a Docker container has been re-created with a new id, automatically re-link Docker run configurations to the container with the same name."
        }
      }
```

Note the comma added to the end of the `autoOpenView` block.

- [ ] **Step 2: Verify the JSON is still valid**

Run: `node -e "const p=require('./package.json'); console.log(Object.keys(p.contributes.configuration.properties).join('\n'))"`

Expected output — exactly these three lines:

```
runConfigManager.mcp.enabled
runConfigManager.monitoring.autoOpenView
runConfigManager.docker.autoRelink
```

- [ ] **Step 3: Stage the change — DO NOT COMMIT**

```bash
git add package.json
```

Suggested message for the user: `feat(docker): add docker.autoRelink setting`

---

## Task 6: Wire the healer into `extension.ts`

`src/extension.ts` is excluded from coverage by repo convention (see
`jest.config.js`), and there is no test for it. All decision logic therefore
already lives in Task 3/4's planner; what goes here is strictly side effects:
read the setting, build the input, apply the actions, notify.

Read `src/extension.ts:190-212` first — the `maybeAutoOpenMonitor` hook is the
pattern this mirrors (pure helper + guard `Set` + reactive subscription).

**Files:**
- Modify: `src/extension.ts` — imports near line 27, new block after line 212

- [ ] **Step 1: Add the import**

In `src/extension.ts`, next to the other service imports (the `DockerService`
import is on line 27), add:

```ts
import { planDockerHeal, healActionKey, type HealAction } from './services/dockerConfigHealer';
```

- [ ] **Step 2: Add the healer block**

Insert the following immediately after line 212 —
`context.subscriptions.push(nodeMonitoring.onChanged(maybeAutoOpenMonitor));` —
and before the `// Auto-reattach:` comment on line 214:

```ts
  // Docker containers get a brand-new id every time they are re-created
  // (`compose up --force-recreate`, image rebuilds, rm+run). The id stored in
  // run.json then points at nothing and the configuration is dead until the
  // user re-picks the container by hand. Container names DO survive
  // re-creation, so we re-match on name and rewrite the id. Driven by the
  // existing 3s `docker ps` poll, so the repair lands in the background and the
  // tree flips out of its "not found" state on its own.
  //
  // Keyed by target (config + new id), not by config: a container that flaps
  // away and back must be healed again, not suppressed forever. Entries are
  // added BEFORE the write and never removed on failure, so a permanently
  // failing write (read-only FS) is attempted once instead of re-notifying
  // every 3 seconds.
  const dockerHealAttempted = new Set<string>();
  let dockerHealing = false;
  const applyDockerHeal = async (): Promise<void> => {
    const enabled = vscode.workspace
      .getConfiguration('runConfigManager')
      .get<boolean>('docker.autoRelink', true);
    // Re-entrancy guard: poll ticks can land while an await is in flight.
    if (!enabled || dockerHealing) return;
    dockerHealing = true;
    try {
      // A plain loop rather than filter+map: `ConfigRef` is discriminated on
      // `valid`, and `InvalidConfigEntry` has no `type` field, so narrowing has
      // to happen before `.type` is touched. This also avoids any cast.
      const configs: Array<{ folderKey: string; config: RunConfig }> = [];
      for (const ref of svc.list()) {
        if (!ref.valid || ref.config.type !== 'docker') continue;
        configs.push({ folderKey: ref.folderKey, config: ref.config });
      }
      const actions = planDockerHeal({ configs, containers: docker.list() });

      // Forget attempts that are no longer being planned — either they
      // succeeded (the config now resolves) or the situation changed.
      const planned = new Set(actions.map(healActionKey));
      for (const key of [...dockerHealAttempted]) {
        if (!planned.has(key)) dockerHealAttempted.delete(key);
      }

      const relinked: Array<Extract<HealAction, { kind: 'relink' }>> = [];
      for (const action of actions) {
        const key = healActionKey(action);
        if (dockerHealAttempted.has(key)) continue;

        // Re-read before writing: the plan was built from a snapshot and the
        // user may have saved an edit in the meantime. Never clobber the
        // current stored config.
        const ref = svc.getById(action.configId);
        if (!ref || !ref.valid || ref.config.type !== 'docker') continue;
        const current = ref.config;

        const nextTypeOptions =
          action.kind === 'relink'
            ? {
                ...current.typeOptions,
                containerId: action.newContainerId,
                containerName: action.containerName,
              }
            : { ...current.typeOptions, containerName: action.containerName };

        dockerHealAttempted.add(key);
        try {
          await svc.update(ref.folderKey, { ...current, typeOptions: nextTypeOptions });
          if (action.kind === 'relink') {
            relinked.push(action);
            log.info(
              `Docker re-link: "${action.configName}" container "${action.containerName}" ` +
                `${action.oldContainerId.slice(0, 12)} -> ${action.newContainerId.slice(0, 12)}`,
            );
          } else {
            log.debug(
              `Docker name backfill: "${current.name}" containerName="${action.containerName}"`,
            );
          }
        } catch (e) {
          log.warn(
            `Docker config heal failed for "${current.name}": ${(e as Error).message}`,
          );
          vscode.window.showErrorMessage(
            `Failed to update Docker configuration "${current.name}": ${(e as Error).message}`,
          );
        }
      }

      // Backfills are silent — the user did not ask for a name and nothing they
      // can see changed. Only relinks notify, coalesced so a compose recreate
      // that touches six configs produces one toast rather than six.
      if (relinked.length === 1) {
        const a = relinked[0];
        vscode.window.showInformationMessage(
          `"${a.configName}" re-linked to the re-created container ` +
            `"${a.containerName}" (${a.newContainerId.slice(0, 12)}).`,
        );
      } else if (relinked.length > 1) {
        void vscode.window
          .showInformationMessage(
            `Re-linked ${relinked.length} Docker configurations to re-created containers.`,
            'Show Details',
          )
          .then(choice => {
            if (choice === 'Show Details') log.show();
          });
      }
    } finally {
      dockerHealing = false;
    }
  };
  context.subscriptions.push(docker.onChanged(() => void applyDockerHeal()));
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: clean. `RunConfig` is already imported at `src/extension.ts:49`, so no
new type import is needed. If `ref.config.type` reports an error, the `ref.valid`
narrowing was dropped — `InvalidConfigEntry` has no `type` field, so the guard
must come first. Do not paper over it with a cast.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: all suites pass except the known environment-specific failure at
`test/detectTomcat.test.ts:73` (macOS `/tmp` → `/private/tmp` realpath quirk,
unrelated to this change — confirm it is the *only* failure and that its message
mentions a `/private/tmp` path mismatch). If anything else fails, it is yours.

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: exit 0, `out/extension.js` and `out/mcp-server.js` written.

- [ ] **Step 6: Stage the change — DO NOT COMMIT**

```bash
git add src/extension.ts
```

Suggested message for the user: `feat(docker): auto re-link configs to re-created containers`

---

## Task 7: Manual verification and onboarding doc

The planner is fully unit-tested, but nothing has exercised the real Docker
daemon, the real poll, or the notification. Do this by hand.

**Files:**
- Modify: `docs/LLM_ONBOARDING.md`

- [ ] **Step 1: Manual smoke test**

Requires a running Docker daemon. In a scratch workspace:

```bash
docker run -d --name rcm-heal-test nginx:alpine
```

1. Launch the extension (F5 / Extension Development Host).
2. Add a Docker run configuration pointing at `rcm-heal-test`.
3. Wait ~5 seconds, then open `.vscode/run.json`. Confirm the backfill landed:
   `typeOptions` now contains `"containerName": "rcm-heal-test"` alongside the id.
   **If this is missing, stop — Task 4 is not working and nothing else can.**
4. Note the current `containerId` value.
5. Re-create the container:
   ```bash
   docker rm -f rcm-heal-test && docker run -d --name rcm-heal-test nginx:alpine
   ```
6. Within ~3-6 seconds expect an information notification:
   `"<config name>" re-linked to the re-created container "rcm-heal-test" (<12 chars>).`
7. Confirm `.vscode/run.json` now holds the **new** id, and that the tree row is
   no longer showing `not found`.
8. Click Run on the config. Expect it to start the container with no
   `No such container` error.
9. Set `runConfigManager.docker.autoRelink` to `false`, re-create the container
   again, and confirm no notification appears and `run.json` is untouched.
10. Clean up: `docker rm -f rcm-heal-test`.

- [ ] **Step 2: Update the onboarding index**

In `docs/LLM_ONBOARDING.md`, find the DockerService line in the Services section:

```markdown
**DockerService** — tracks container running state via `docker ps`, fires events used by the tree to update icon state.
```

Replace it with:

```markdown
**DockerService** — tracks container running state via `docker ps`, fires events used by the tree to update icon state. **Config self-heal**: because a re-created container gets a new id, `dockerConfigHealer.ts` (pure `planDockerHeal`) runs off `docker.onChanged` in `extension.ts` and rewrites `typeOptions.containerId` when exactly one live container carries the config's stored `containerName`; the name itself is silently backfilled whenever the stored id still resolves. Gated by `runConfigManager.docker.autoRelink` (default true). Id comparison lives in `containerMatch.ts` and is shared with `DockerService.find`.
```

- [ ] **Step 3: Final verification**

Run: `npm run typecheck && npm test && npm run build`

Expected: typecheck clean, tests green except the known
`test/detectTomcat.test.ts:73` macOS failure, build exit 0.

- [ ] **Step 4: Stage the change — DO NOT COMMIT**

```bash
git add docs/LLM_ONBOARDING.md
```

Then run `git status` and confirm the full change set is exactly:

```
new file:   src/services/containerMatch.ts
new file:   src/services/dockerConfigHealer.ts
new file:   test/containerMatch.test.ts
new file:   test/dockerConfigHealer.test.ts
new file:   test/dockerSummaries.test.ts
modified:   src/services/DockerService.ts
modified:   src/extension.ts
modified:   package.json
modified:   docs/LLM_ONBOARDING.md
```

Report to the user that the work is staged and ready for their review. **Do not
commit.**

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `containerName` as durable identity, `containerId` as cache | 3, 4 |
| Shared `containerIdMatches` in its own dependency-free module + empty-id guard | 1 |
| `summariesChanged` compares `name` | 2 |
| Relink rule: stale + non-empty name + exactly one match | 3 |
| Image deliberately not matched | 3 (comment + no image logic) |
| Backfill rule: live id + non-empty live name + differs from stored | 4 |
| Empty `containerId` skipped | 3 |
| At most one action per config per tick | 4 (`continue` after backfill) |
| Pure planner, no `vscode`, mirrors `monitorAutoOpen.ts` | 3 |
| Setting `runConfigManager.docker.autoRelink`, default true, read at event time | 5, 6 |
| Re-entrancy flag | 6 |
| Attempted-guard keyed by target, added before write, kept on failure | 6 |
| Guard pruned when no longer planned | 6 |
| `svc.getById` re-read before write | 6 |
| Notification: single vs. coalesced + `Show Details` → `log.show()` | 6 |
| Backfills silent | 6 |
| 12-char id truncation in the message | 6 |
| `log.info` per relink | 6 |
| Every planner test case in the spec, plus `containerMatch` and `summariesChanged` tests | 1, 2, 3, 4 |
| No editor / `sanitizeConfig` / form-schema change (the YAGNI cut) | — (absent by design) |
