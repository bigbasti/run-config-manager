// Status of a KPI tile derived from the spec's threshold table. The UI
// uses this to tint the tile background and pick its border color.
// 'ok' → green, 'warn' → yellow, 'critical' → red.
export type HealthStatus = 'ok' | 'warn' | 'critical';

// Heap: 70% warn, 90% critical. heapMax === -1 means unbounded — we
// can't compute a fraction, so render as ok.
export function heapStatus(used: number, max: number): HealthStatus {
  if (max <= 0) return 'ok';
  const ratio = used / max;
  if (ratio >= 0.9) return 'critical';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

// Cumulative GC pause time in the last 60s. 100ms warn, 500ms critical.
export function gcPauseStatus(totalMs: number): HealthStatus {
  if (totalMs >= 500) return 'critical';
  if (totalMs >= 100) return 'warn';
  return 'ok';
}

// Process CPU load. Negative input means "not available" — render ok.
// 70% warn, 90% critical.
export function cpuStatus(load: number): HealthStatus {
  if (load < 0) return 'ok';
  if (load >= 0.9) return 'critical';
  if (load >= 0.7) return 'warn';
  return 'ok';
}

// Threads tile: warn when any BLOCKED threads, critical on deadlock.
export function threadsStatus(blockedCount: number, deadlocked: boolean): HealthStatus {
  if (deadlocked) return 'critical';
  if (blockedCount > 0) return 'warn';
  return 'ok';
}

// Off-heap (direct + mapped buffers) compared against heapMax.
// 2× heapMax warn, 4× heapMax critical. Skip when heapMax unknown.
export function offHeapStatus(offHeapBytes: number, heapMax: number): HealthStatus {
  if (heapMax <= 0) return 'ok';
  if (offHeapBytes >= 4 * heapMax) return 'critical';
  if (offHeapBytes >= 2 * heapMax) return 'warn';
  return 'ok';
}

// Open file descriptors. 50% warn, 80% critical.
export function fdStatus(open: number, max: number): HealthStatus {
  if (max <= 0) return 'ok';
  const ratio = open / max;
  if (ratio >= 0.8) return 'critical';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}
