import {
  heapStatus,
  gcPauseStatus,
  cpuStatus,
  threadsStatus,
  offHeapStatus,
  fdStatus,
  type HealthStatus,
} from '../src/services/monitoring/healthThresholds';

describe('healthThresholds', () => {
  describe('heapStatus', () => {
    test.each<[number, number, HealthStatus]>([
      [100, 1000, 'ok'],   // 10%
      [700, 1000, 'warn'], // 70%
      [800, 1000, 'warn'], // 80%
      [900, 1000, 'critical'],
      [950, 1000, 'critical'],
      [100, -1,   'ok'],   // unbounded heap
    ])('%i / %i → %s', (used, max, expected) => {
      expect(heapStatus(used, max)).toBe(expected);
    });
  });

  describe('gcPauseStatus', () => {
    test.each<[number, HealthStatus]>([
      [0, 'ok'],
      [50, 'ok'],
      [100, 'warn'],
      [400, 'warn'],
      [500, 'critical'],
      [1500, 'critical'],
    ])('%i ms → %s', (totalMs, expected) => {
      expect(gcPauseStatus(totalMs)).toBe(expected);
    });
  });

  describe('cpuStatus', () => {
    test.each<[number, HealthStatus]>([
      [0,    'ok'],
      [0.5,  'ok'],
      [0.7,  'warn'],
      [0.85, 'warn'],
      [0.9,  'critical'],
      [-1,   'ok'],     // -1 means "not available"
    ])('%f → %s', (load, expected) => {
      expect(cpuStatus(load)).toBe(expected);
    });
  });

  describe('threadsStatus', () => {
    test('ok when no BLOCKED, no deadlock', () => {
      expect(threadsStatus(0, false)).toBe('ok');
    });
    test('warn when BLOCKED > 0', () => {
      expect(threadsStatus(3, false)).toBe('warn');
    });
    test('critical on deadlock', () => {
      expect(threadsStatus(0, true)).toBe('critical');
      expect(threadsStatus(3, true)).toBe('critical');
    });
  });

  describe('offHeapStatus', () => {
    test('ok when off-heap < 2× heapMax', () => {
      expect(offHeapStatus(100, 1000)).toBe('ok');
    });
    test('warn when off-heap >= 2× heapMax', () => {
      expect(offHeapStatus(2000, 1000)).toBe('warn');
    });
    test('critical when off-heap >= 4× heapMax', () => {
      expect(offHeapStatus(4000, 1000)).toBe('critical');
    });
    test('ok when heapMax unknown (-1)', () => {
      expect(offHeapStatus(1_000_000_000, -1)).toBe('ok');
    });
  });

  describe('fdStatus', () => {
    test.each<[number, number, HealthStatus]>([
      [10,  100, 'ok'],
      [50,  100, 'warn'],
      [60,  100, 'warn'],
      [80,  100, 'critical'],
      [10,  -1,  'ok'],
    ])('%i / %i → %s', (open, max, expected) => {
      expect(fdStatus(open, max)).toBe(expected);
    });
  });
});
