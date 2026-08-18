import type { RunConfig } from '../shared/types';
import type { ContainerSummary } from './DockerService';
import { containerIdMatches } from './containerMatch';

// Pure decision logic for repairing Docker run configurations whose stored
// container id has gone stale. Kept free of vscode imports and of any I/O so it
// is unit-testable; dockerHealRunner.ts owns the side effects (config writes,
// the attempted-guard Set, and the notification).
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
    // run.json is hand-editable and git-tracked, and sanitizeConfig round-trips
    // whatever it finds, so both fields can arrive with stray whitespace. Both
    // are trimmed on both sides of every comparison — a hand-added leading
    // space in containerName would otherwise defeat the heal permanently.
    const storedId = to.containerId.trim();
    // Load-bearing: with a blank id, containerIdMatches returns false, `live`
    // is undefined, and control would fall through to the stale branch and
    // relink a config the user never pointed at a container.
    if (!storedId) continue;

    const live = input.containers.find(c => containerIdMatches(c.id, storedId));

    if (live) {
      // The container still exists, so there is nothing to repair — but keep
      // the durable name key fresh so a FUTURE re-creation can be matched.
      // This is what makes the feature work for configs created before it
      // existed: nothing has ever written containerName, so without this
      // backfill there would be nothing to re-match on. Also covers rename
      // drift, not just first-time population: a `docker rename` re-points the
      // key at the container's current name. Silent by design.
      const liveName = live.name.trim();
      if (liveName && liveName !== (to.containerName ?? '').trim()) {
        out.push({
          kind: 'backfillName',
          folderKey,
          configId: config.id,
          containerName: liveName,
        });
      }
      // Load-bearing: at most one action per config. Without this, a config
      // whose stored name happens to match a DIFFERENT live container would
      // fall through and also emit a relink.
      continue;
    }

    // Stale id. Container names survive re-creation (compose derives them
    // deterministically from project + service), so the name is the identity we
    // re-match on. Image is deliberately NOT compared: a re-created container
    // usually carries a freshly built image, which is exactly the case we exist
    // to handle.
    const storedName = (to.containerName ?? '').trim();
    if (!storedName) continue;

    const byName = input.containers.filter(c => c.name.trim() === storedName);
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
      // Sourced from the matched container rather than from the stored value.
      // Identical by construction today, but obviously correct to a future
      // reader and survives any change to how the filter compares names.
      containerName: byName[0].name.trim(),
    });
  }

  return out;
}

// Identity of an action for the caller's "already attempted" guard. Keyed by
// the TARGET, not just the config, so a container that flaps away and back is
// healed again rather than suppressed forever. The folder is part of the key
// because config ids are only unique within a root — a run.json copied between
// roots yields duplicate ids, and without the folder the second config's heal
// would be silently suppressed forever.
export function healActionKey(action: HealAction): string {
  return action.kind === 'relink'
    ? `${action.folderKey}:${action.configId}:${action.newContainerId}`
    : `${action.folderKey}:${action.configId}:name:${action.containerName}`;
}
