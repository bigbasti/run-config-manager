import { reattachOnStartup, type ReattachDeps } from '../src/services/reattachOnStartup';
import type { PortEntry } from '../src/services/PortScanner';
import type { PersistedRunState } from '../src/services/RunStateStore';

const port = (p: number, pid: number): PortEntry => ({
  port: p, address: '0.0.0.0', pid, processName: 'java', protocol: 'tcp',
});

function makeDeps(opts: {
  persisted: Record<string, PersistedRunState>;
  rows: PortEntry[];
  exists?: (id: string) => boolean;
}) {
  const deleted: string[] = [];
  const reattached: Array<{ id: string; pid: number; ports: number[] }> = [];
  const deps: ReattachDeps = {
    runState: {
      all: () => ({ ...opts.persisted }),
      delete: (id: string) => { deleted.push(id); delete opts.persisted[id]; },
    } as any,
    reattach: (id, pid, ports) => reattached.push({ id, pid, ports }),
    configExists: opts.exists ?? (() => true),
    scan: async () => opts.rows,
  };
  return { deps, deleted, reattached };
}

const st = (ports: number[], pid: number): PersistedRunState => ({
  ports, pid, name: 'App', type: 'npm', startedAt: 1,
});

describe('reattachOnStartup', () => {
  test('reattaches a config whose recorded port is listening (adopts live pid)', async () => {
    const { deps, reattached } = makeDeps({
      persisted: { a: st([8080], 0) },
      rows: [port(8080, 4242)],
    });
    const n = await reattachOnStartup(deps);
    expect(n).toBe(1);
    expect(reattached).toEqual([{ id: 'a', pid: 4242, ports: [8080] }]);
  });

  test('drops stale entry when no recorded port is listening', async () => {
    const { deps, reattached, deleted } = makeDeps({
      persisted: { a: st([8080], 0) },
      rows: [port(9999, 1)],
    });
    const n = await reattachOnStartup(deps);
    expect(n).toBe(0);
    expect(reattached).toEqual([]);
    expect(deleted).toEqual(['a']);
  });

  test('drops entry whose config no longer exists', async () => {
    const { deps, reattached, deleted } = makeDeps({
      persisted: { gone: st([8080], 0) },
      rows: [port(8080, 5)],
      exists: () => false,
    });
    const n = await reattachOnStartup(deps);
    expect(n).toBe(0);
    expect(reattached).toEqual([]);
    expect(deleted).toEqual(['gone']);
  });

  test('does not reattach when recorded pid differs from the live listener pid', async () => {
    const { deps, reattached, deleted } = makeDeps({
      persisted: { a: st([8080], 111) },
      rows: [port(8080, 222)], // a different process took the port
    });
    const n = await reattachOnStartup(deps);
    expect(n).toBe(0);
    expect(deleted).toEqual(['a']);
  });

  test('reattaches on pid match', async () => {
    const { deps, reattached } = makeDeps({
      persisted: { a: st([8080], 111) },
      rows: [port(8080, 111)],
    });
    const n = await reattachOnStartup(deps);
    expect(n).toBe(1);
    expect(reattached).toEqual([{ id: 'a', pid: 111, ports: [8080] }]);
  });

  test('no persisted entries → no scan needed, returns 0', async () => {
    let scanned = false;
    const deps: ReattachDeps = {
      runState: { all: () => ({}), delete: jest.fn() } as any,
      reattach: jest.fn(),
      configExists: () => true,
      scan: async () => { scanned = true; return []; },
    };
    const n = await reattachOnStartup(deps);
    expect(n).toBe(0);
    expect(scanned).toBe(false);
  });

  test('matches any of multiple recorded ports', async () => {
    const { deps, reattached } = makeDeps({
      persisted: { a: st([3000, 8080], 0) },
      rows: [port(8080, 7)],
    });
    const n = await reattachOnStartup(deps);
    expect(n).toBe(1);
    expect(reattached[0]).toEqual({ id: 'a', pid: 7, ports: [3000, 8080] });
  });
});
