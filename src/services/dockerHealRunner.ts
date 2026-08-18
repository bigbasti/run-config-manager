import type { RunConfig } from '../shared/types';
import type { ContainerSummary } from './DockerService';
import { planDockerHeal, healActionKey, type HealAction } from './dockerConfigHealer';

export type RelinkAction = Extract<HealAction, { kind: 'relink' }>;

// Everything this runner needs from the extension host, injected so the module
// stays free of vscode and the concurrency logic below is unit-testable.
// extension.ts is excluded from coverage by repo convention, which is exactly
// why the drain/guard logic must not live there.
export interface HealRunnerDeps {
  // Read at call time, not cached, so toggling the setting takes effect
  // without a window reload.
  isEnabled(): boolean;
  // Valid docker configs only. Narrowing ConfigRef's union is the caller's job.
  listDockerConfigs(): Array<{ folderKey: string; config: RunConfig }>;
  listContainers(): ContainerSummary[];
  getConfig(id: string): { folderKey: string; config: RunConfig } | undefined;
  updateConfig(folderKey: string, cfg: RunConfig): Promise<void>;
  notifyRelinked(relinked: RelinkAction[]): void;
  notifyError(configName: string, message: string): void;
  log: { info(m: string): void; debug(m: string): void; warn(m: string): void };
}

// Docker containers get a brand-new id every time they are re-created
// (`compose up --force-recreate`, image rebuilds, rm+run). The id stored in
// run.json then points at nothing and the configuration is dead until the user
// re-picks the container by hand. Container names DO survive re-creation, so we
// re-match on name and rewrite the id. Driven by container-list changes, so the
// repair lands in the background and the tree flips out of its "not found"
// state on its own.
export function createDockerHealRunner(deps: HealRunnerDeps): () => Promise<void> {
  // Keyed by target (config + new id), not by config: a container that flaps
  // away and back must be healed again, not suppressed forever. See
  // healActionKey for why the target rather than the config is the identity.
  // Entries are added BEFORE the write and never removed on failure, so a
  // permanently failing write (read-only FS) is attempted once instead of
  // re-notifying on every container-list change.
  const attempted = new Set<string>();
  let healing = false;
  let pending = false;

  async function healOnce(): Promise<void> {
    if (!deps.isEnabled()) return;

    const actions = planDockerHeal({
      configs: deps.listDockerConfigs(),
      containers: deps.listContainers(),
    });

    // Forget attempts that are no longer being planned — either they succeeded
    // (the config now resolves) or the situation changed. Deleting from a Set
    // while iterating it is well-defined: a not-yet-visited entry that is
    // removed is simply skipped.
    const planned = new Set(actions.map(healActionKey));
    for (const key of attempted) {
      if (!planned.has(key)) attempted.delete(key);
    }

    const relinked: RelinkAction[] = [];
    for (const action of actions) {
      const key = healActionKey(action);
      if (attempted.has(key)) continue;

      // Re-read: the plan was built from a snapshot taken before any await.
      const ref = deps.getConfig(action.configId);
      if (!ref || ref.config.type !== 'docker') continue;
      const current = ref.config;

      // Re-check the precondition the plan was built on, not merely that the
      // config still exists — otherwise a user who re-pointed this config at a
      // different container while the write was queued would be silently
      // reverted.
      if (
        action.kind === 'relink' &&
        current.typeOptions.containerId.trim() !== action.oldContainerId
      ) {
        continue;
      }
      if (
        action.kind === 'backfillName' &&
        current.typeOptions.containerName === action.containerName
      ) {
        continue;
      }

      // getConfig resolves by id across all roots and returns the first match.
      // In a multi-root workspace with duplicated run.json files that can be a
      // different config than the one planned, so trust the planner's folder.
      if (ref.folderKey !== action.folderKey) {
        deps.log.debug(
          `Docker heal: skipping "${current.name}" — resolved folder ${ref.folderKey} ` +
            `does not match planned ${action.folderKey}`,
        );
        continue;
      }

      const nextTypeOptions =
        action.kind === 'relink'
          ? {
              ...current.typeOptions,
              containerId: action.newContainerId,
              containerName: action.containerName,
            }
          : { ...current.typeOptions, containerName: action.containerName };

      attempted.add(key);
      try {
        await deps.updateConfig(ref.folderKey, { ...current, typeOptions: nextTypeOptions });
        if (action.kind === 'relink') {
          relinked.push(action);
          deps.log.info(
            `Docker re-link: "${action.configName}" container "${action.containerName}" ` +
              `${action.oldContainerId.slice(0, 12)} -> ${action.newContainerId.slice(0, 12)}`,
          );
        } else {
          deps.log.debug(
            `Docker name backfill: "${current.name}" containerName="${action.containerName}"`,
          );
        }
      } catch (e) {
        const message = (e as Error).message;
        deps.log.warn(`Docker config heal failed for "${current.name}": ${message}`);
        deps.notifyError(current.name, message);
      }
    }

    // Backfills are silent — the user's intent is unchanged and there is
    // nothing for them to act on. Only relinks notify, coalesced per batch so
    // one plan that touches six configs produces one toast rather than six.
    if (relinked.length > 0) deps.notifyRelinked(relinked);
  }

  return async function runDockerHeal(): Promise<void> {
    // Coalesce rather than drop. onChanged is EDGE-triggered — it fires only
    // when the container list actually changes, so an event discarded here is
    // never redelivered, and the config it would have healed stays broken
    // until something unrelated changes in Docker.
    if (healing) {
      pending = true;
      return;
    }
    healing = true;
    try {
      do {
        pending = false;
        await healOnce();
      } while (pending);
    } finally {
      healing = false;
    }
  };
}
