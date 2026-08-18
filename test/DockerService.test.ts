import { DockerService, summariesChanged, type ContainerSummary } from '../src/services/DockerService';

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

  // Not because these fields are invisible — the tree shows both — but because
  // neither drives any heal or running-state logic. `docker tag` can change the
  // image of a running container with no state or status transition; the row
  // description is simply a poll behind, which is an acceptable trade for not
  // re-rendering the tree on churn that changes nothing actionable.
  it('ignores image and ports churn', () => {
    expect(summariesChanged([mk()], [mk({ image: 'other:1', ports: '80->80/tcp' })])).toBe(false);
  });
});

describe('DockerService.find', () => {
  let svc: DockerService;
  afterEach(() => svc?.dispose());

  function withCache(cache: ContainerSummary[]): DockerService {
    svc = new DockerService();
    // Seeding the private cache directly rather than driving poll(): poll()
    // spawns the real `docker` binary, and stubbing child_process here would
    // be a much larger fixture than these delegation tests warrant.
    (svc as unknown as { cache: ContainerSummary[] }).cache = cache;
    // The cast above writes by name with typechecking disabled — if the field
    // is ever renamed this would silently seed nothing and leave the negative
    // assertions below passing vacuously. Fail loudly instead.
    expect(svc.list()).toBe(cache);
    return svc;
  }

  // The matching RULES are covered in test/containerMatch.test.ts. All this
  // layer adds is that find delegates to them and picks the right row out of
  // the cache, so seed two rows and check we get the intended one.
  it('finds the cache row whose full id the stored short id prefixes', () => {
    withCache([mk({ id: 'b'.repeat(64), name: 'other' }), mk()]);
    expect(svc.find('a'.repeat(12))?.name).toBe('myapp-api');
  });

  // A `docker ps` row whose JSON has no ID key yields id: ''. Before
  // containerIdMatches gained its non-empty guard, storedId.startsWith('')
  // was true, so such a row matched EVERY config — rendering them all as
  // "found but stopped" instead of "not found".
  it('does not match a blank-id row against an arbitrary stored id', () => {
    withCache([mk({ id: '' })]);
    expect(svc.find('a'.repeat(12))).toBeUndefined();
  });
});
