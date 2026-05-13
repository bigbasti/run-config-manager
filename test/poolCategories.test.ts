import { categorizePool, type PoolCategory } from '../src/services/monitoring/poolCategories';

describe('categorizePool', () => {
  test.each<[string, PoolCategory]>([
    ['G1 Eden Space', 'young'],
    ['PS Eden Space', 'young'],
    ['Eden Space', 'young'],
    ['G1 Survivor Space', 'survivor'],
    ['PS Survivor Space', 'survivor'],
    ['G1 Old Gen', 'old'],
    ['PS Old Gen', 'old'],
    ['Tenured Gen', 'old'],
    ['Metaspace', 'metaspace'],
    ['Compressed Class Space', 'metaspace'],
    ["CodeHeap 'non-nmethods'", 'codeCache'],
    ["CodeHeap 'profiled nmethods'", 'codeCache'],
    ["CodeHeap 'non-profiled nmethods'", 'codeCache'],
    ['Code Cache', 'codeCache'],
    ['Some Future Pool', 'other'],
  ])('%s → %s', (name, expected) => {
    expect(categorizePool(name)).toBe(expected);
  });
});
