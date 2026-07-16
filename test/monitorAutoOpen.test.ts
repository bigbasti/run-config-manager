import { decideAutoOpen, AutoOpenAction } from '../src/services/monitorAutoOpen';

describe('decideAutoOpen', () => {
  // enabled, live, alreadyOpened -> expected action
  const cases: Array<[boolean, boolean, boolean, AutoOpenAction]> = [
    // not live -> always clear the guard, regardless of enabled/alreadyOpened
    [true, false, false, 'clear'],
    [true, false, true, 'clear'],
    [false, false, false, 'clear'],
    [false, false, true, 'clear'],
    // live but disabled -> noop
    [false, true, false, 'noop'],
    [false, true, true, 'noop'],
    // live, enabled, already opened -> noop (don't reopen after user closes)
    [true, true, true, 'noop'],
    // live, enabled, not yet opened -> open
    [true, true, false, 'open'],
  ];

  it.each(cases)(
    'enabled=%s live=%s alreadyOpened=%s -> %s',
    (enabled, live, alreadyOpened, expected) => {
      expect(decideAutoOpen({ enabled, live, alreadyOpened })).toBe(expected);
    },
  );
});
