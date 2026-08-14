import { depIconState } from '../src/ui/RunConfigTreeProvider';

// The bug this guards: a dependency that failed during an orchestration kept
// its red "error" icon forever, even after the user fixed it and started it
// by hand from the dependency row. The orchestration snapshot is a record of
// ONE run — once that run is over it must not outrank live runtime state.

describe('depIconState — no orchestration record', () => {
  test('idle dep with no status shows its own type icon', () => {
    expect(depIconState(undefined, false, false)).toBe('default');
  });

  test('running dep with no status shows running', () => {
    expect(depIconState(undefined, true, false)).toBe('running');
  });
});

describe('depIconState — orchestration in flight (snapshot not finished)', () => {
  // While the orchestrator is walking the graph its recorded status is the
  // only thing that can express "queued", "start issued", "waiting out the
  // edge delay" — live state cannot. It must win here.
  test('waiting wins over live state', () => {
    expect(depIconState('waiting', false, false)).toBe('waiting');
  });

  test('starting wins over live state', () => {
    expect(depIconState('starting', false, false)).toBe('starting');
  });

  test('delaying wins even though the dep is already up', () => {
    expect(depIconState('delaying', true, false)).toBe('delaying');
  });

  test('failed shows failed', () => {
    expect(depIconState('failed', false, false)).toBe('failed');
  });

  test('idle status falls back to the type icon', () => {
    expect(depIconState('idle', false, false)).toBe('default');
  });
});

describe('depIconState — finished orchestration (post-mortem snapshot)', () => {
  test('failed dep the user has since started shows running, not failed', () => {
    expect(depIconState('failed', true, true)).toBe('running');
  });

  test('skipped dep the user has since started shows running, not skipped', () => {
    expect(depIconState('skipped', true, true)).toBe('running');
  });

  test('failed dep that is still down keeps the failure visible', () => {
    expect(depIconState('failed', false, true)).toBe('failed');
  });

  test('skipped dep that is still down keeps the skip marker visible', () => {
    expect(depIconState('skipped', false, true)).toBe('skipped');
  });

  // Mirror image of the reported bug: a dep the orchestration DID start
  // successfully, recorded as 'running', that the user has since stopped.
  test('stale running record for a stopped dep falls back to the type icon', () => {
    expect(depIconState('running', false, true)).toBe('default');
  });

  test('stale in-flight record for a stopped dep falls back to the type icon', () => {
    expect(depIconState('starting', false, true)).toBe('default');
    expect(depIconState('delaying', false, true)).toBe('default');
    expect(depIconState('waiting', false, true)).toBe('default');
  });
});
