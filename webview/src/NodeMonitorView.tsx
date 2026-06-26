import { useEffect, useMemo, useState } from 'react';
import type {
  NodeHello, NodeMetricsTick, NodeHeapSpaces, NodeGcEvent,
} from '../../src/services/monitoring/NodeAgentMessage';

const HISTORY_CAP_BY_WINDOW: Record<string, number> = { '60s': 60, '5min': 300, '30min': 1800 };
type TabKey = 'memory' | 'loop' | 'runtime';

declare const acquireVsCodeApi: any;
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };
const MB = 1024 * 1024;
const mb = (n: number) => `${(n / MB).toFixed(0)} MB`;

export function NodeMonitorView({ configId, configName }: { configId: string; configName: string }) {
  const [history, setHistory] = useState<NodeMetricsTick[]>([]);
  const [heapSpaces, setHeapSpaces] = useState<NodeHeapSpaces | null>(null);
  const [gcEvents, setGcEvents] = useState<NodeGcEvent[]>([]);
  const [hello, setHello] = useState<NodeHello | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [windowKey, setWindowKey] = useState<keyof typeof HISTORY_CAP_BY_WINDOW>('60s');
  const [tab, setTab] = useState<TabKey>('memory');
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m?.configId !== configId) return;
      if (m.cmd === 'monitor.node.tick') {
        if (typeof m.startTime === 'number') setStartTime(m.startTime);
        setHistory(h => [...h, m.metrics].slice(-HISTORY_CAP_BY_WINDOW[windowKey]));
      } else if (m.cmd === 'monitor.node.heapSpaces') {
        setHeapSpaces(m.heapSpaces);
      } else if (m.cmd === 'monitor.node.gc') {
        setGcEvents(prev => {
          const key = `${m.gc.t}-${m.gc.kind}`;
          if (prev.some(g => `${g.t}-${g.kind}` === key)) return prev;
          const cutoff = Date.now() - 60_000;
          return [...prev, m.gc].filter(g => g.t >= cutoff);
        });
      } else if (m.cmd === 'monitor.node.hello') {
        setHello(m.hello);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [configId, windowKey]);

  const last = history[history.length - 1];
  const uptime = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const gcLast60 = gcEvents.reduce((s, g) => s + g.durationMs, 0);

  return (
    <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)' }}>
      <h2 style={{ marginTop: 0 }}>{configName}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Window:</span>
        {(['60s', '5min', '30min'] as const).map(w => (
          <button key={w} onClick={() => setWindowKey(w)} style={{ fontWeight: w === windowKey ? 'bold' : 'normal' }}>{w}</button>
        ))}
        <button title="Write a V8 heap snapshot (.heapsnapshot) you can open in Chrome DevTools or VS Code."
          onClick={() => vscode.postMessage({ cmd: 'monitor.node.saveSnapshot', configId })}>
          Save heap snapshot
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>
          Run duration: {Math.floor(uptime / 60)}m {uptime % 60}s
        </div>
      </div>

      <MemChart history={history} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginTop: 12, marginBottom: 12 }}>
        <Tile label="Heap" value={last ? mb(last.heapUsed) : '—'} sub={last && last.heapLimit > 0 ? `of ${mb(last.heapLimit)}` : ''} title="V8 heap used / limit." />
        <Tile label="RSS" value={last ? mb(last.rss) : '—'} sub="resident set" title="Resident set size — total memory held by the process." />
        <Tile label="CPU" value={last ? `${last.cpuPercent.toFixed(1)}%` : '—'} sub="process" title="Process CPU usage over the last second (can exceed 100% across cores)." />
        <Tile label="Loop lag" value={last ? `${last.loopLagP99.toFixed(1)} ms` : '—'} sub="p99" title="Event-loop delay p99 — high values mean the loop is blocked." />
        <Tile label="Handles" value={last ? String(last.activeHandles) : '—'} sub="active" title="Active libuv handles (sockets, timers, servers)." />
        <Tile label="GC" value={`${gcLast60.toFixed(0)} ms`} sub="last 60s" title="Cumulative GC pause time over the last 60 seconds." />
      </div>

      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--vscode-editorWidget-border, #444)' }}>
        {([['memory', 'Memory'], ['loop', 'Event loop'], ['runtime', 'Runtime']] as Array<[TabKey, string]>).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            border: 'none', background: 'transparent', padding: '6px 12px', cursor: 'pointer',
            borderBottom: tab === k ? '2px solid var(--vscode-focusBorder, #007acc)' : '2px solid transparent',
            color: tab === k ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
            fontWeight: tab === k ? 600 : 400,
          }}>{l}</button>
        ))}
      </div>

      <div style={{ padding: '12px 0' }}>
        {tab === 'memory' && <MemoryTab last={last} heapSpaces={heapSpaces} gcEvents={gcEvents} history={history} />}
        {tab === 'loop' && <LoopTab history={history} />}
        {tab === 'runtime' && <RuntimeTab hello={hello} last={last} uptime={uptime} />}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, title }: { label: string; value: string; sub: string; title: string }) {
  return (
    <div title={title} style={{ border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4, padding: 8 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 10, opacity: 0.6 }}>{sub}</div>
    </div>
  );
}

function MemChart({ history }: { history: NodeMetricsTick[] }) {
  if (history.length === 0) return <div style={{ height: 140, opacity: 0.6, padding: 8 }}>No data yet</div>;
  const w = 800, h = 140, pT = 16, pB = 18, pL = 56, pR = 12;
  const plotW = w - pL - pR, plotH = h - pT - pB;
  const vals = history.flatMap(m => [m.rss, m.heapUsed]);
  const lo = Math.min(...vals), hi = Math.max(...vals) || 1;
  const range = (hi - lo) || 1;
  const x = (i: number) => pL + (i / (history.length - 1 || 1)) * plotW;
  const y = (v: number) => pT + plotH - ((v - lo) / range) * plotH;
  const line = (sel: (m: NodeMetricsTick) => number) => history.map((m, i) => `${x(i)},${y(sel(m))}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}>
      <text x={pL - 4} y={pT + 4} textAnchor="end" fontSize="10" fill="var(--vscode-descriptionForeground, #888)">{mb(hi)}</text>
      <text x={pL - 4} y={pT + plotH} textAnchor="end" fontSize="10" fill="var(--vscode-descriptionForeground, #888)">{mb(lo)}</text>
      <polyline points={line(m => m.rss)} fill="none" stroke="var(--vscode-charts-orange, #d18616)" strokeWidth={1.5} />
      <polyline points={line(m => m.heapUsed)} fill="none" stroke="var(--vscode-charts-blue, #4080ff)" strokeWidth={1.5} />
      <text x={pL} y={12} fontSize="10" fill="var(--vscode-descriptionForeground, #888)">RSS (orange) · Heap used (blue)</text>
    </svg>
  );
}

function MemoryTab({ last, heapSpaces, gcEvents, history }: {
  last?: NodeMetricsTick; heapSpaces: NodeHeapSpaces | null; gcEvents: NodeGcEvent[]; history: NodeMetricsTick[];
}) {
  const allocRate = useMemo(() => {
    if (history.length < 2) return 0;
    let sum = 0, n = 0;
    for (let i = 1; i < history.length; i++) {
      const d = history[i].heapUsed - history[i - 1].heapUsed;
      if (d > 0) { sum += d; n++; }
    }
    return n ? sum / n : 0;
  }, [history]);
  return (
    <div>
      <h3>V8 heap spaces</h3>
      {!heapSpaces ? <div style={{ opacity: 0.6 }}>No data yet</div> : (
        <div style={{ display: 'grid', gap: 6 }}>
          {heapSpaces.spaces.map(s => {
            const pct = s.size > 0 ? (s.used / s.size) * 100 : 0;
            return (
              <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 140px', gap: 8, alignItems: 'center' }}>
                <span title={s.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                <div style={{ background: 'var(--vscode-editorWidget-background)', height: 12, borderRadius: 3 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--vscode-charts-blue, #4080ff)', borderRadius: 3 }} />
                </div>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{mb(s.used)} / {mb(s.size)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>External</div><div>{last ? mb(last.external) : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>ArrayBuffers</div><div>{last ? mb(last.arrayBuffers) : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Alloc rate</div><div>{(allocRate / MB).toFixed(2)} MB/s</div></div>
      </div>
      <h3 style={{ marginTop: 16 }}>GC timeline (last 60s)</h3>
      <NodeGcTimeline events={gcEvents} now={Date.now()} />
    </div>
  );
}

// Full-width 60s strip of GC events, positioned by event time (mirrors the JVM
// GcTimeline). Node GC is infrequent, so packing fixed-width bars left-to-right
// squashed them into the corner — here each event sits at its real timestamp
// and bar height is log-scaled so a 50ms major pause stands out next to a
// sub-ms minor one.
function NodeGcTimeline({ events, now }: { events: NodeGcEvent[]; now: number }) {
  const w = 800, h = 60;
  const windowMs = 60_000;
  const xFor = (t: number) => ((t - (now - windowMs)) / windowMs) * w;
  const heightFor = (durationMs: number) => Math.min(h, 8 + Math.log10(Math.max(1, durationMs)) * 14);
  const colorFor = (kind: string) =>
    kind === 'major' ? 'var(--vscode-charts-red, #f14c4c)'
      : kind === 'minor' ? 'var(--vscode-charts-green, #16825d)'
        : 'var(--vscode-charts-orange, #d18616)';
  if (events.length === 0) {
    return <div style={{ height: h, opacity: 0.6, padding: 8, fontSize: 12 }}>No GC events in the last 60s.</div>;
  }
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}>
      {events.map(ev => {
        const x = xFor(ev.t);
        const barH = heightFor(ev.durationMs);
        return (
          <g key={`${ev.t}-${ev.kind}`}>
            <title>{`${ev.kind} · ${ev.durationMs} ms`}</title>
            <rect x={x - 1.5} y={h - barH} width={3} height={barH} fill={colorFor(ev.kind)} />
          </g>
        );
      })}
    </svg>
  );
}

function LoopTab({ history }: { history: NodeMetricsTick[] }) {
  const last = history[history.length - 1];
  return (
    <div>
      <h3>Event-loop lag</h3>
      <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Mean</div><div>{last ? `${last.loopLagMean.toFixed(2)} ms` : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>p99</div><div>{last ? `${last.loopLagP99.toFixed(2)} ms` : '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Max</div><div>{last ? `${last.loopLagMax.toFixed(2)} ms` : '—'}</div></div>
      </div>
      <Spark values={history.map(m => m.loopLagP99)} label="p99 lag (ms)" />
      <h3 style={{ marginTop: 16 }}>Active resources</h3>
      <div style={{ display: 'flex', gap: 24 }}>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Handles</div><div>{last?.activeHandles ?? '—'}</div></div>
        <div><div style={{ opacity: 0.7, fontSize: 12 }}>Requests</div><div>{last?.activeRequests ?? '—'}</div></div>
      </div>
    </div>
  );
}

function Spark({ values, label }: { values: number[]; label: string }) {
  if (values.length === 0) return <div style={{ opacity: 0.6 }}>No data yet</div>;
  const w = 600, h = 60;
  const hi = Math.max(...values) || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1 || 1)) * w},${h - (v / hi) * h}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}>
      <polyline points={pts} fill="none" stroke="var(--vscode-charts-purple, #b180d7)" strokeWidth={1.5} />
      <text x={4} y={12} fontSize="10" fill="var(--vscode-descriptionForeground, #888)">{label} · max {hi.toFixed(1)}</text>
    </svg>
  );
}

function RuntimeTab({ hello, last, uptime }: { hello: NodeHello | null; last?: NodeMetricsTick; uptime: number }) {
  if (!hello) return <div style={{ opacity: 0.6 }}>No data yet</div>;
  const Row = ({ k, v }: { k: string; v: string }) => (
    <tr><td style={{ opacity: 0.7, paddingRight: 16 }}>{k}</td><td style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</td></tr>
  );
  return (
    <div>
      <table><tbody>
        <Row k="Node" v={hello.nodeVersion} />
        <Row k="V8" v={hello.v8Version} />
        <Row k="PID" v={String(hello.pid)} />
        <Row k="Platform" v={`${hello.platform} / ${hello.arch}`} />
        <Row k="Exec path" v={hello.execPath} />
        <Row k="CWD" v={hello.cwd} />
        <Row k="Uptime" v={`${Math.floor(uptime / 60)}m ${uptime % 60}s`} />
        <Row k="RSS" v={last ? mb(last.rss) : '—'} />
      </tbody></table>
      <Collapsible title={`argv (${hello.argv.length})`}>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{hello.argv.join('\n')}</pre>
      </Collapsible>
      <Collapsible title={`Environment variables (${Object.keys(hello.env).length})`}>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{Object.entries(hello.env).map(([k, v]) => `${k}=${v}`).join('\n')}</pre>
      </Collapsible>
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: any }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-foreground)' }}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open && <div style={{ marginLeft: 16, fontSize: 12 }}>{children}</div>}
    </div>
  );
}
