import { ExecutionService } from '../src/services/ExecutionService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import * as PortScanner from '../src/services/PortScanner';

jest.mock('../src/services/PortScanner', () => ({
  scanPorts: jest.fn().mockResolvedValue([]),
  killProcess: jest.fn().mockResolvedValue(undefined),
  inferConfigPortsDetailed: jest.fn().mockReturnValue({ explicit: [], defaultPorts: [] }),
}));

const killProcess = PortScanner.killProcess as jest.MockedFunction<typeof PortScanner.killProcess>;

// In-memory RunStateStore stub.
function fakeRunState() {
  const map = new Map<string, any>();
  return {
    all: () => Object.fromEntries(map),
    get: (id: string) => map.get(id),
    set: (id: string, v: any) => { map.set(id, v); },
    setPid: (id: string, pid: number) => { const e = map.get(id); if (e) e.pid = pid; },
    delete: (id: string) => { map.delete(id); },
    __map: map,
  } as any;
}

describe('ExecutionService — reattach / external process tracking', () => {
  let svc: ExecutionService;
  let runState: ReturnType<typeof fakeRunState>;

  beforeEach(() => {
    killProcess.mockClear();
    const reg = new AdapterRegistry();
    reg.register(new NpmAdapter());
    runState = fakeRunState();
    svc = new ExecutionService(reg, undefined, undefined, runState);
  });

  test('reattach() marks the config running + reattached and persists state', () => {
    const fired: string[] = [];
    svc.onRunningChanged(id => fired.push(id));
    svc.reattach('cfg1', 4242, [8080]);
    expect(svc.isRunning('cfg1')).toBe(true);
    expect(svc.isReattached('cfg1')).toBe(true);
    expect(svc.isStarted('cfg1')).toBe(false); // not a real readiness signal
    expect(fired).toContain('cfg1');
    expect(runState.get('cfg1')).toMatchObject({ ports: [8080], pid: 4242 });
  });

  test('reattach() is a no-op if already external', () => {
    svc.reattach('cfg1', 1, [8080]);
    svc.reattach('cfg1', 2, [9090]);
    // first wins
    expect(runState.get('cfg1').pid).toBe(1);
  });

  test('stop() on a reattached config kills the live pid and clears state', async () => {
    svc.reattach('cfg1', 4242, [8080]);
    await svc.stop('cfg1');
    expect(killProcess).toHaveBeenCalledWith(4242);
    expect(svc.isRunning('cfg1')).toBe(false);
    expect(svc.isReattached('cfg1')).toBe(false);
    expect(runState.get('cfg1')).toBeUndefined();
  });

  test('reattach() preserves existing persisted name/type/startedAt', () => {
    runState.set('cfg1', { ports: [8080], pid: 0, name: 'Web', type: 'npm', startedAt: 7 });
    svc.reattach('cfg1', 555, [8080]);
    expect(runState.get('cfg1')).toMatchObject({ name: 'Web', type: 'npm', startedAt: 7, pid: 555 });
  });
});
