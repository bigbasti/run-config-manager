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

// Not an override bag like mkSummary's: `containerName: undefined` means
// "omit the key entirely", so this is a defaults bag.
function mkDocker(opts: {
  configId?: string;
  configName?: string;
  containerId?: string;
  containerName?: string;
} = {}): { folderKey: string; config: RunConfig } {
  const {
    configId = 'cfg-1',
    configName = 'API Server',
    containerId = OLD_ID,
    containerName,
  } = opts;
  return {
    folderKey: '/ws',
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

  // The `byName.length !== 1` check alone does NOT cover this: with no stored
  // name we would filter for `name === ''`, and a single container reporting a
  // blank name matches exactly once — relinking the config to an arbitrary
  // container. `DockerService.poll` defaults a missing Names key to '', so a
  // blank reported name is reachable, not hypothetical.
  it('does not relink a nameless config to a container with a blank name', () => {
    const actions = planDockerHeal({
      configs: [mkDocker()],
      containers: [mkSummary({ name: '' })],
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
        mkDocker({ configId: 'cfg-1', containerName: 'myapp-api' }),
        mkDocker({ configId: 'cfg-2', configName: 'DB', containerName: 'myapp-db' }),
      ],
      containers: [mkSummary(), mkSummary({ id: 'd'.repeat(64), name: 'myapp-db' })],
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
      {
        kind: 'relink',
        folderKey: '/ws',
        configId: 'cfg-2',
        configName: 'DB',
        oldContainerId: OLD_ID,
        newContainerId: 'd'.repeat(64),
        containerName: 'myapp-db',
      },
    ]);
  });

  // Guards the containerIdMatches extraction: a stored short id and the full id
  // `docker ps --no-trunc` reports are the same container.
  it('treats a stored short id as live against the reported full id', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID.slice(0, 12), containerName: 'myapp-api' })],
      containers: [mkSummary()],
    });
    expect(actions).toEqual([]);
  });
});

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

  // The live branch must terminate the iteration. If its `continue` were
  // removed, this config would fall through and ALSO emit a relink, because
  // its stored name matches a different live container.
  it('plans at most one action per config', () => {
    const actions = planDockerHeal({
      configs: [mkDocker({ containerId: NEW_ID, containerName: 'other-name' })],
      containers: [mkSummary(), mkSummary({ id: 'e'.repeat(64), name: 'other-name' })],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('backfillName');
  });

  it('plans a backfill and a relink across two configs', () => {
    const actions = planDockerHeal({
      configs: [
        mkDocker({ configId: 'cfg-1', containerId: NEW_ID }),
        mkDocker({ configId: 'cfg-2', containerId: OLD_ID, containerName: 'myapp-api' }),
      ],
      containers: [mkSummary()],
    });
    expect(actions).toHaveLength(2);
    expect(actions.find(a => a.configId === 'cfg-1')?.kind).toBe('backfillName');
    expect(actions.find(a => a.configId === 'cfg-2')?.kind).toBe('relink');
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

  // Two configs may legitimately point at the same container. If the key did
  // not include configId they would collide, the caller's dedup guard would
  // swallow the second, and that config would stay broken with no notification.
  it('distinguishes two configs relinking to the same container', () => {
    const base = {
      kind: 'relink' as const,
      folderKey: '/ws',
      configName: 'API Server',
      oldContainerId: OLD_ID,
      newContainerId: NEW_ID,
      containerName: 'myapp-api',
    };
    expect(healActionKey({ ...base, configId: 'cfg-1' })).not.toEqual(
      healActionKey({ ...base, configId: 'cfg-2' }),
    );
  });

  // Rename drift must produce a new key, or the caller's guard would suppress
  // every rename after the first backfill for that config.
  it('changes when the backfilled name changes', () => {
    const base = { kind: 'backfillName' as const, folderKey: '/ws', configId: 'cfg-1' };
    expect(healActionKey({ ...base, containerName: 'old-name' })).not.toEqual(
      healActionKey({ ...base, containerName: 'myapp-api' }),
    );
  });

  // Config ids are only unique within a root. A run.json copied between roots
  // gives two different configs the same id; without the folder in the key the
  // caller's guard would write the first and silently skip the second forever.
  it('distinguishes the same config id in two workspace roots', () => {
    const relink = {
      kind: 'relink' as const,
      configId: 'cfg-1',
      configName: 'API Server',
      oldContainerId: OLD_ID,
      newContainerId: NEW_ID,
      containerName: 'myapp-api',
    };
    expect(healActionKey({ ...relink, folderKey: '/ws-a' })).not.toEqual(
      healActionKey({ ...relink, folderKey: '/ws-b' }),
    );

    const backfill = { kind: 'backfillName' as const, configId: 'cfg-1', containerName: 'myapp-api' };
    expect(healActionKey({ ...backfill, folderKey: '/ws-a' })).not.toEqual(
      healActionKey({ ...backfill, folderKey: '/ws-b' }),
    );
  });
});
