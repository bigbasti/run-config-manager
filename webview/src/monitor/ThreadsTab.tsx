import { useState } from 'react';
import type { MetricsTick, ThreadsSnapshot, ThreadInfo, ThreadDump } from '../../../src/services/monitoring/AgentMessage';
import { StateDonut } from './StateDonut';

// Threads drill-down. The on-demand thread-dump fetch is dispatched
// through the parent via the `requestThreadDump` callback; the parent
// owns the message round-trip with the extension.
export function ThreadsTab({
  history,
  threadsDetail,
  threadDumps,
  requestThreadDump,
}: {
  history: MetricsTick[];
  threadsDetail: ThreadsSnapshot | null;
  threadDumps: Map<number, ThreadDump>;
  requestThreadDump: (tid: number) => void;
}) {
  if (!threadsDetail) {
    return <div style={{ opacity: 0.6 }}>Waiting for first thread snapshot (5s tick)…</div>;
  }
  const blockedCount = threadsDetail.states.BLOCKED ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 16 }}>
        <StateDonut states={threadsDetail.states} />
        <CountHistory history={history} />
      </section>

      {threadsDetail.deadlock && (
        <section style={{
          background: 'color-mix(in srgb, #f44747 14%, transparent)',
          border: '1px solid #f44747',
          borderRadius: 4,
          padding: 12,
          fontSize: 13,
        }}>
          <strong style={{ color: '#f44747' }}>⚠ Deadlock detected</strong>
          <div style={{ marginTop: 6 }}>
            {threadsDetail.deadlock.summary} — threads: {threadsDetail.deadlock.names.join(', ')}
          </div>
        </section>
      )}

      <section>
        <h3
          title="The 10 threads that consumed the most CPU time in the last 5-second measurement window. Click any row to fetch its full stack trace. Use this to identify threads doing heavy computation or busy-waiting."
          style={{ marginTop: 0, marginBottom: 8, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
        >
          Top threads by CPU (last 5s)
        </h3>
        {blockedCount > 0 && (
          <span
            title="BLOCKED threads are waiting to acquire a monitor lock held by another thread. Multiple blocked threads on the same lock may indicate a contention hotspot."
            style={{ color: '#f44747', marginLeft: 8, fontSize: 13 }}
          >
            · {blockedCount} BLOCKED
          </span>
        )}
        <TopByCpu threads={threadsDetail.topByCpu} threadDumps={threadDumps} requestThreadDump={requestThreadDump} />
      </section>
    </div>
  );
}

function CountHistory({ history }: { history: MetricsTick[] }) {
  if (history.length === 0) return null;
  const w = 300, h = 60;
  const max = Math.max(...history.map(m => m.threadCount));
  const points = history.map((m, i) => {
    const x = (i / (history.length - 1 || 1)) * w;
    const y = h - (m.threadCount / max) * h;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      <div
        title="Total number of live threads (all states) sampled once per second. A steadily rising thread count that never decreases may indicate a thread leak — threads are being created but not shut down."
        style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)', marginBottom: 4, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
      >
        Total thread count over time
      </div>
      <svg width={w} height={h} style={{ background: 'var(--vscode-editorWidget-background)' }}>
        <polyline points={points} fill="none" stroke="var(--vscode-charts-blue, #4080ff)" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function TopByCpu({
  threads,
  threadDumps,
  requestThreadDump,
}: {
  threads: ThreadInfo[];
  threadDumps: Map<number, ThreadDump>;
  requestThreadDump: (tid: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return (
    <div style={{
      fontFamily: 'var(--vscode-editor-font-family, monospace)',
      fontSize: 12,
      border: '1px solid var(--vscode-editorWidget-border, #444)',
      borderRadius: 4,
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 110px 70px 1fr',
        gap: 0,
        padding: '6px 12px',
        background: 'var(--vscode-editorWidget-background, #2a2a2a)',
        fontWeight: 600,
        fontSize: 11,
        color: 'var(--vscode-descriptionForeground, #aaa)',
      }}>
        <span title="Thread name as assigned by the application or JVM framework.">Name</span>
        <span title="Thread state: RUNNABLE (executing), BLOCKED (waiting for a lock), WAITING (parked indefinitely), TIMED_WAITING (sleeping for a fixed duration), NEW, or TERMINATED.">State</span>
        <span
          style={{ textAlign: 'right', cursor: 'help', textDecoration: 'underline dotted' }}
          title="CPU time consumed by this thread during the last 5-second measurement interval. High values here point to threads doing heavy computation or busy-waiting."
        >
          CPU Δ
        </span>
        <span title="Top frame of the thread's call stack at the time of the last snapshot. Click a row to fetch the full stack trace.">Stack snippet</span>
      </div>
      {threads.map(t => {
        const isOpen = expanded.has(t.id);
        const dump = threadDumps.get(t.id);
        return (
          <div key={t.id}>
            <div
              onClick={() => {
                setExpanded(s => {
                  const next = new Set(s);
                  if (next.has(t.id)) next.delete(t.id);
                  else { next.add(t.id); if (!dump) requestThreadDump(t.id); }
                  return next;
                });
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 110px 70px 1fr',
                gap: 0,
                padding: '4px 12px',
                cursor: 'pointer',
                borderTop: '1px solid var(--vscode-editorWidget-border, #444)',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {isOpen ? '▾ ' : '▸ '}{t.name}
              </span>
              <span style={{ color: t.state === 'BLOCKED' ? '#f44747' : 'inherit' }}>{t.state}</span>
              <span style={{ textAlign: 'right' }}>{(t.cpuDeltaNs / 1_000_000).toFixed(1)} ms</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.85 }}>
                {t.stackSnippet[0] ?? ''}
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '6px 24px', background: 'var(--vscode-editor-background)', fontSize: 11, lineHeight: 1.4 }}>
                {dump ? dump.stack.map((f, i) => <div key={i}>{f}</div>) : <div style={{ opacity: 0.6 }}>Loading stack…</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
