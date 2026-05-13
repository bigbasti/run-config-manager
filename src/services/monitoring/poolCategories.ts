// Canonical buckets the UI renders for memory-pool breakdown. The JVM
// reports pool names that vary across collectors (G1 / Parallel /
// Serial / ZGC / Shenandoah) and JDK versions, so we normalize.
export type PoolCategory = 'young' | 'survivor' | 'old' | 'metaspace' | 'codeCache' | 'other';

// Maps the JVM's reported pool name to a canonical category. Unknown
// names land in 'other' so they show up but stay unlabeled — better
// than hiding data we don't recognize.
export function categorizePool(name: string): PoolCategory {
  const n = name.toLowerCase();
  if (n.includes('eden')) return 'young';
  if (n.includes('survivor')) return 'survivor';
  if (n.includes('old gen') || n.includes('tenured')) return 'old';
  if (n.includes('metaspace') || n.includes('compressed class')) return 'metaspace';
  if (n.includes('codeheap') || n.includes('code cache')) return 'codeCache';
  return 'other';
}
