import { RunStateStore, type PersistedRunState } from '../src/services/RunStateStore';

// Minimal in-memory Memento for testing persistence.
function fakeMemento() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string, def?: T): T | undefined => (map.has(key) ? (map.get(key) as T) : def),
    update: (key: string, value: unknown) => { map.set(key, value); return Promise.resolve(); },
    keys: () => [...map.keys()],
    // expose for assertions
    __raw: map,
  } as any;
}

const entry = (ports: number[], pid: number): PersistedRunState => ({
  ports, pid, name: 'App', type: 'npm', startedAt: 1,
});

describe('RunStateStore', () => {
  test('set/get round-trips and persists to the Memento', () => {
    const mem = fakeMemento();
    const store = new RunStateStore(mem);
    store.set('a', entry([3000], 111));
    expect(store.get('a')).toEqual(entry([3000], 111));
    // Persisted under the versioned key.
    expect(mem.__raw.get('rcm.runState.v1')).toEqual({ a: entry([3000], 111) });
  });

  test('reloads existing state from the Memento on construction', () => {
    const mem = fakeMemento();
    mem.update('rcm.runState.v1', { x: entry([8080], 222) });
    const store = new RunStateStore(mem);
    expect(store.get('x')).toEqual(entry([8080], 222));
  });

  test('all() returns a copy that cannot mutate the backing map', () => {
    const store = new RunStateStore(fakeMemento());
    store.set('a', entry([3000], 1));
    const snap = store.all();
    delete (snap as any).a;
    expect(store.get('a')).toBeDefined();
  });

  test('setPid updates pid; no-op when unchanged or missing', () => {
    const mem = fakeMemento();
    const store = new RunStateStore(mem);
    store.set('a', entry([3000], 0));
    store.setPid('a', 999);
    expect(store.get('a')!.pid).toBe(999);
    // missing id is a no-op (does not throw / create)
    store.setPid('missing', 5);
    expect(store.get('missing')).toBeUndefined();
  });

  test('delete removes the entry and persists', () => {
    const mem = fakeMemento();
    const store = new RunStateStore(mem);
    store.set('a', entry([3000], 1));
    store.delete('a');
    expect(store.get('a')).toBeUndefined();
    expect(mem.__raw.get('rcm.runState.v1')).toEqual({});
  });
});
