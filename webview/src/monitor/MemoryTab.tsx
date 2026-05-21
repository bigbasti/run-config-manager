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
        <h3
          title="Memory pools — the JVM heap is divided into regions with different lifetimes. Hover each pool label for details."
          style={{ marginTop: 0, marginBottom: 8, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
        >
          Memory pools
        </h3>
        {pools ? <PoolsBars pools={pools} /> : <div style={{ opacity: 0.6 }}>No pool data yet.</div>}
      </section>

      <section>
        <h3
          title="Each bar represents one GC collection event. Bar height is proportional to log(pause duration) so both sub-millisecond minor and multi-second major pauses are visible. Green = young-generation (minor), red/orange = old-generation or mixed (major). Hover a bar for collector name, pause duration, cause, and action."
          style={{ marginTop: 0, marginBottom: 8, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
        >
          GC timeline (last 60s)
        </h3>
        <GcTimeline events={gcEvents} now={Date.now()} />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div
            title="Direct buffers — off-heap memory allocated via ByteBuffer.allocateDirect(). Used by NIO channels, Netty, and database drivers. Not subject to GC pressure but does count against native memory limits. A continuously rising count without a corresponding drop may indicate a buffer leak."
            style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)', cursor: 'help', textDecoration: 'underline dotted' }}
          >
            Direct buffers
          </div>
          <div style={{ fontSize: 16 }}>{fmtMb(directBytes)}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{last?.directBuffer?.count ?? '—'} buffers</div>
        </div>
        <div>
          <div
            title="Mapped buffers — off-heap memory backed by memory-mapped files (FileChannel.map()). Common in databases and message queues (e.g. Kafka). The OS manages eviction; it does not appear in heap but does consume virtual address space."
            style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)', cursor: 'help', textDecoration: 'underline dotted' }}
          >
            Mapped buffers
          </div>
          <div style={{ fontSize: 16 }}>{fmtMb(mappedBytes)}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{last?.mappedBuffer?.count ?? '—'} buffers</div>
        </div>
      </section>

      <section>
        <h3
          title="Estimated heap allocation rate over the visible window. Computed from positive heap-used deltas between ticks (negative deltas are GC reclaim events, not allocation). High allocation rates increase GC frequency and may cause latency spikes."
          style={{ marginTop: 0, marginBottom: 8, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
        >
          Allocation rate
        </h3>
        <div>
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
