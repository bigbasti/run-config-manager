import { createDockerHealRunner, type HealRunnerDeps } from '../src/services/dockerHealRunner';
import type { ContainerSummary } from '../src/services/DockerService';
import type { RunConfig } from '../src/shared/types';

const OLD_A = 'a'.repeat(64);
const NEW_A = 'b'.repeat(64);
const OLD_B = 'c'.repeat(64);
const NEW_B = 'd'.repeat(64);

function mkSummary(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: NEW_A,
    name: 'myapp-api',
    image: 'myapp:latest',
    state: 'running',
    status: 'Up 3 minutes',
    ports: '',
    ...over,
  };
}

function mkDocker(opts: {
  configId?: string;
  configName?: string;
  folderKey?: string;
  containerId?: string;
  containerName?: string;
} = {}): { folderKey: string; config: RunConfig } {
  const {
    configId = 'cfg-1',
    configName = 'API Server',
    folderKey = '/ws',
    containerId = OLD_A,
    containerName,
  } = opts;
  return {
    folderKey,
    config: {
      id: configId,
      name: configName,
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

const silentLog = { info: () => {}, debug: () => {}, warn: () => {} };

interface Harness {
  deps: HealRunnerDeps;
  configs: Array<{ folderKey: string; config: RunConfig }>;
  containers: ContainerSummary[];
  updateConfig: jest.Mock;
  notifyRelinked: jest.Mock;
  notifyError: jest.Mock;
}

// Mutable fake store. `updateConfig` writes back so a second pass sees the
// healed state, which is what makes the drain assertions meaningful.
function mkHarness(
  init: {
    configs?: Array<{ folderKey: string; config: RunConfig }>;
    containers?: ContainerSummary[];
  } = {},
  over: Partial<HealRunnerDeps> = {},
): Harness {
  const configs = init.configs ?? [];
  const containers = init.containers ?? [];

  const updateConfig = jest.fn(async (folderKey: string, cfg: RunConfig) => {
    const i = configs.findIndex(c => c.config.id === cfg.id);
    if (i >= 0) configs[i] = { folderKey, config: cfg };
  });
  const notifyRelinked = jest.fn();
  const notifyError = jest.fn();

  const deps: HealRunnerDeps = {
    isEnabled: () => true,
    listDockerConfigs: () => configs.map(c => ({ ...c })),
    listContainers: () => containers.slice(),
    getConfig: id => {
      const found = configs.find(c => c.config.id === id);
      return found ? { folderKey: found.folderKey, config: found.config } : undefined;
    },
    updateConfig,
    notifyRelinked,
    notifyError,
    log: silentLog,
    ...over,
  };

  return { deps, configs, containers, updateConfig, notifyRelinked, notifyError };
}

function typeOptionsOf(cfg: RunConfig): { containerId: string; containerName?: string } {
  if (cfg.type !== 'docker') throw new Error('not a docker config');
  return cfg.typeOptions;
}

describe('createDockerHealRunner', () => {
  it('does nothing when the setting is disabled', async () => {
    const h = mkHarness(
      {
        configs: [mkDocker({ containerName: 'myapp-api' })],
        containers: [mkSummary({ id: NEW_A })],
      },
      { isEnabled: () => false },
    );

    await createDockerHealRunner(h.deps)();

    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.notifyRelinked).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('relinks a stale id and notifies once', async () => {
    const h = mkHarness({
      configs: [mkDocker({ containerName: 'myapp-api' })],
      containers: [mkSummary({ id: NEW_A })],
    });

    await createDockerHealRunner(h.deps)();

    expect(h.updateConfig).toHaveBeenCalledTimes(1);
    const [folderKey, written] = h.updateConfig.mock.calls[0] as [string, RunConfig];
    expect(folderKey).toBe('/ws');
    expect(typeOptionsOf(written)).toEqual({ containerId: NEW_A, containerName: 'myapp-api' });

    expect(h.notifyRelinked).toHaveBeenCalledTimes(1);
    const relinked = h.notifyRelinked.mock.calls[0][0];
    expect(relinked).toHaveLength(1);
    expect(relinked[0]).toMatchObject({
      kind: 'relink',
      configId: 'cfg-1',
      oldContainerId: OLD_A,
      newContainerId: NEW_A,
      containerName: 'myapp-api',
    });
  });

  it('backfills the container name silently', async () => {
    const h = mkHarness({
      // Stored id is live, so there is nothing to relink — only the durable
      // name key is missing.
      configs: [mkDocker({ containerId: OLD_A })],
      containers: [mkSummary({ id: OLD_A, name: 'myapp-api' })],
    });

    await createDockerHealRunner(h.deps)();

    expect(h.updateConfig).toHaveBeenCalledTimes(1);
    const written = h.updateConfig.mock.calls[0][1] as RunConfig;
    expect(typeOptionsOf(written)).toEqual({ containerId: OLD_A, containerName: 'myapp-api' });
    // Backfills are silent.
    expect(h.notifyRelinked).not.toHaveBeenCalled();
  });

  // The backfill write itself fires ConfigStore.onChange, which is now a heal
  // trigger. If the second pass planned the same action again this would be an
  // infinite write loop, so pin that it converges to zero writes.
  it('converges: a second pass after a backfill writes nothing', async () => {
    const h = mkHarness({
      configs: [mkDocker({ containerId: OLD_A })],
      containers: [mkSummary({ id: OLD_A, name: 'myapp-api' })],
    });

    const run = createDockerHealRunner(h.deps);
    await run();
    expect(h.updateConfig).toHaveBeenCalledTimes(1);
    // The fake store wrote the name back, exactly as ConfigStore.write does.
    expect(typeOptionsOf(h.configs[0].config).containerName).toBe('myapp-api');

    await run();

    expect(h.updateConfig).toHaveBeenCalledTimes(1);
    expect(h.notifyRelinked).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  // Exercises the attempted-guard prune. The guard key is
  // folder:config:newContainerId, so for pass 3 to be suppressed by a missing
  // prune it must re-plan the SAME target — which happens when run.json is
  // reverted (it is git-tracked, so a branch switch or `git checkout` does
  // exactly this) while the container is still the one we healed to.
  it('re-heals a container that flaps away and back', async () => {
    const configs = [mkDocker({ containerName: 'myapp-api' })];
    const containers: ContainerSummary[] = [mkSummary({ id: NEW_A, name: 'myapp-api' })];
    const h = mkHarness({ configs, containers });
    const run = createDockerHealRunner(h.deps);

    // Pass 1: re-created under NEW_A -> relink applied.
    await run();
    expect(h.updateConfig).toHaveBeenCalledTimes(1);
    expect(typeOptionsOf(configs[0].config).containerId).toBe(NEW_A);

    // Pass 2: the container flaps away -> nothing is planned, so the guard
    // entry for it is pruned.
    containers.length = 0;
    await run();
    expect(h.updateConfig).toHaveBeenCalledTimes(1);

    // Pass 3: the container comes back under the same id (`docker start`
    // preserves it) and run.json has been reverted to the stale id, so the
    // identical action is planned again. Without the prune this is suppressed
    // forever and the config stays broken.
    containers.push(mkSummary({ id: NEW_A, name: 'myapp-api' }));
    configs[0] = mkDocker({ containerName: 'myapp-api' });
    await run();

    expect(h.updateConfig).toHaveBeenCalledTimes(2);
    expect(typeOptionsOf(configs[0].config).containerId).toBe(NEW_A);
  });

  // The reason this module exists. onChanged is edge-triggered, so an event
  // that arrives while a write is in flight must be queued, not dropped: it is
  // never redelivered, and the first pass planned from a snapshot taken before
  // its await, so it cannot cover for the second.
  it('drains work that arrives while a write is in flight', async () => {
    const cfgA = mkDocker({ configId: 'cfg-a', configName: 'API', containerName: 'myapp-api' });
    const cfgB = mkDocker({
      configId: 'cfg-b',
      configName: 'DB',
      containerId: OLD_B,
      containerName: 'myapp-db',
    });
    const configs = [cfgA, cfgB];
    // A is already re-created; B's container is still alive under its stored
    // id, so the first pass has nothing to do for B.
    const containers = [
      mkSummary({ id: NEW_A, name: 'myapp-api' }),
      mkSummary({ id: OLD_B, name: 'myapp-db' }),
    ];

    let releaseFirstWrite!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    let gated = true;
    const updateConfig = jest.fn(async (folderKey: string, cfg: RunConfig) => {
      if (gated) {
        gated = false;
        await gate;
      }
      const i = configs.findIndex(c => c.config.id === cfg.id);
      if (i >= 0) configs[i] = { folderKey, config: cfg };
    });

    const h = mkHarness({ configs, containers }, { updateConfig });
    const run = createDockerHealRunner(h.deps);

    // First event: plans A's relink, blocks inside the write.
    const first = run();
    expect(updateConfig).toHaveBeenCalledTimes(1);

    // Second event lands mid-write: B's container has now been re-created too.
    containers[1] = mkSummary({ id: NEW_B, name: 'myapp-db' });
    const second = run();

    releaseFirstWrite();
    await Promise.all([first, second]);

    // A drop-instead-of-drain implementation loses this second event forever:
    // the container list is settled, so onChanged never fires again.
    expect(updateConfig).toHaveBeenCalledTimes(2);
    const bWrite = updateConfig.mock.calls.find(c => (c[1] as RunConfig).id === 'cfg-b');
    expect(bWrite).toBeDefined();
    expect(typeOptionsOf(bWrite![1] as RunConfig)).toEqual({
      containerId: NEW_B,
      containerName: 'myapp-db',
    });
    expect(typeOptionsOf(configs[1].config).containerId).toBe(NEW_B);
  });

  it('attempts a permanently failing write only once', async () => {
    const h = mkHarness(
      {
        configs: [mkDocker({ containerName: 'myapp-api' })],
        containers: [mkSummary({ id: NEW_A })],
      },
      {
        updateConfig: jest.fn(async () => {
          throw new Error('EROFS: read-only file system');
        }),
      },
    );

    const run = createDockerHealRunner(h.deps);
    await run();
    // Identical inputs — the write failed, so the config is still stale and the
    // same action is planned again.
    await run();

    expect(h.deps.updateConfig).toHaveBeenCalledTimes(1);
    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(h.notifyError).toHaveBeenCalledWith('API Server', 'EROFS: read-only file system');
    expect(h.notifyRelinked).not.toHaveBeenCalled();
  });

  it('skips the write when the stored id no longer matches the planned one', async () => {
    const planned = mkDocker({ containerName: 'myapp-api' });
    // The user re-pointed the config at a third container while the heal was
    // queued. getConfig sees that edit; the plan does not.
    const edited = mkDocker({ containerId: 'e'.repeat(64), containerName: 'myapp-api' });
    const h = mkHarness(
      { configs: [planned], containers: [mkSummary({ id: NEW_A })] },
      { getConfig: () => ({ folderKey: '/ws', config: edited.config }) },
    );

    await createDockerHealRunner(h.deps)();

    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.notifyRelinked).not.toHaveBeenCalled();
  });

  it('skips the write when the resolved folder differs from the planned one', async () => {
    const planned = mkDocker({ containerName: 'myapp-api' });
    const h = mkHarness(
      { configs: [planned], containers: [mkSummary({ id: NEW_A })] },
      // Duplicate id in another root; getById returns the first match, which is
      // not the config the planner reasoned about.
      { getConfig: () => ({ folderKey: '/other-ws', config: planned.config }) },
    );

    await createDockerHealRunner(h.deps)();

    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.notifyRelinked).not.toHaveBeenCalled();
  });

  it('coalesces multiple relinks in one pass into a single notification', async () => {
    const h = mkHarness({
      configs: [
        mkDocker({ configId: 'cfg-a', configName: 'API', containerName: 'myapp-api' }),
        mkDocker({
          configId: 'cfg-b',
          configName: 'DB',
          containerId: OLD_B,
          containerName: 'myapp-db',
        }),
      ],
      containers: [
        mkSummary({ id: NEW_A, name: 'myapp-api' }),
        mkSummary({ id: NEW_B, name: 'myapp-db' }),
      ],
    });

    await createDockerHealRunner(h.deps)();

    expect(h.updateConfig).toHaveBeenCalledTimes(2);
    expect(h.notifyRelinked).toHaveBeenCalledTimes(1);
    const relinked = h.notifyRelinked.mock.calls[0][0];
    expect(relinked).toHaveLength(2);
    expect(relinked.map((r: { configId: string }) => r.configId)).toEqual(['cfg-a', 'cfg-b']);
  });
});
