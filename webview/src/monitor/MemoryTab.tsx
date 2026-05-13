import type { MetricsTick, GcEvent } from '../../../src/services/monitoring/AgentMessage';
import { GcTimeline } from './GcTimeline';
import { PoolsBars } from './PoolsBars';

// Memory drill-down: pools breakdown bars, GC event timeline, off-heap
// (direct + mapped) chart, and a derived allocation rate.
export function MemoryTab({ history, gcEvents }: { history: MetricsTick[]; gcEvents: GcEvent[] }) {
  const last = history[history.length - 1];
  const pools = last?.pools ?? null;
  const directBytes = last?.directBuffer?.memoryUsed ?? 0;
  const mappedBytes = last?.mappedBuffer?.memoryUsed ?? 0;
  const allocRate = computeAllocRateMbPerSec(history);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Memory pools</h3>
        {pools ? <PoolsBars pools={pools} /> : <div style={{ opacity: 0.6 }}>No pool data yet.</div>}
      </section>

      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>GC timeline (last 60s)</h3>
        <GcTimeline events={gcEvents} now={Date.now()} />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Direct buffers</div>
          <div style={{ fontSize: 16 }}>{fmtMb(directBytes)}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{last?.directBuffer?.count ?? '—'} buffers</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Mapped buffers</div>
          <div style={{ fontSize: 16 }}>{fmtMb(mappedBytes)}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{last?.mappedBuffer?.count ?? '—'} buffers</div>
        </div>
      </section>

      <section>
        <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Allocation rate</h3>
        <div title="Estimated heap allocation rate over the visible window. Computed from positive heap-used deltas (negative deltas are GC reclaim, not allocation).">
          {allocRate === null ? '—' : `${allocRate.toFixed(1)} MB/s`}
        </div>
      </section>
    </div>
  );
}

// Sum positive heap-used deltas across the visible window, divide by
// the window length in seconds. Negative deltas (GC reclaim) are
// ignored — we want allocation, not net heap movement.
function computeAllocRateMbPerSec(history: MetricsTick[]): number | null {
  if (history.length < 2) return null;
  let alloced = 0;
  for (let i = 1; i < history.length; i++) {
    const delta = history[i].heapUsed - history[i - 1].heapUsed;
    if (delta > 0) alloced += delta;
  }
  const seconds = (history[history.length - 1].t - history[0].t) / 1000;
  if (seconds <= 0) return 0;
  return alloced / seconds / (1024 * 1024);
}

function fmtMb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
