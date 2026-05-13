import { useEffect, useMemo, useState } from 'react';
import type {
  MetricsTick,
  HistogramSnapshot,
  HistogramRow,
  GcEvent,
  ThreadsSnapshot,
  ActuatorSnapshot,
  RuntimeInfo,
  ThreadDump,
} from '../../src/services/monitoring/AgentMessage';
import { groupByPackage, type HistogramNode } from '../../src/services/monitoring/parseClassHistogram';
import {
  heapStatus,
  gcPauseStatus,
  cpuStatus,
  threadsStatus,
  offHeapStatus,
  fdStatus,
} from '../../src/services/monitoring/healthThresholds';
import { KpiTile } from './monitor/KpiTile';
import { MemoryTab } from './monitor/MemoryTab';
import { ThreadsTab } from './monitor/ThreadsTab';
import { JvmInternalsTab } from './monitor/JvmInternalsTab';
import { AppTab } from './monitor/AppTab';

const HISTORY_CAP_BY_WINDOW: Record<string, number> = { '60s': 60, '5min': 300, '30min': 1800 };
type TabKey = 'memory' | 'threads' | 'jvm' | 'app';

declare const acquireVsCodeApi: any;
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };

export function MonitorView({
  configId,
  configName,
  ownPackage,
}: {
  configId: string;
  configName: string;
  ownPackage: string;
}) {
  const [history, setHistory] = useState<MetricsTick[]>([]);
  const [histogram, setHistogram] = useState<HistogramSnapshot | null>(null);
  const [windowKey, setWindowKey] = useState<keyof typeof HISTORY_CAP_BY_WINDOW>('60s');
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'instances' | 'bytes' | 'className'>('bytes');
  const [paused, setPaused] = useState(false);
  const [onlyOwn, setOnlyOwn] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  // New: monitor extended insight state.
  const [gcEvents, setGcEvents] = useState<GcEvent[]>([]);
  const [threadsDetail, setThreadsDetail] = useState<ThreadsSnapshot | null>(null);
  const [actuator, setActuator] = useState<ActuatorSnapshot | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [threadDumps, setThreadDumps] = useState<Map<number, ThreadDump>>(new Map());
  const [activeTab, setActiveTab] = useState<TabKey>('memory');

  useEffect(() => {
    const id = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.configId !== configId) return;
      if (msg.cmd === 'monitor.tick') {
        if (typeof msg.startTime === 'number') setStartTime(msg.startTime);
        setHistory(h => {
          const cap = HISTORY_CAP_BY_WINDOW[windowKey];
          const next = [...h, msg.metrics];
          return next.slice(-cap);
        });
      } else if (msg.cmd === 'monitor.histogram') {
        setHistogram(msg.histogram);
      } else if (msg.cmd === 'monitor.gc') {
        setGcEvents(prev => {
          const seen = new Set(prev.map(g => `${g.t}-${g.collector}`));
          const key = `${msg.gc.t}-${msg.gc.collector}`;
          if (seen.has(key)) return prev;
          const cutoff = Date.now() - 60_000;
          return [...prev, msg.gc].filter(g => g.t >= cutoff);
        });
      } else if (msg.cmd === 'monitor.threads') {
        setThreadsDetail(msg.threads);
      } else if (msg.cmd === 'monitor.actuator') {
        setActuator(msg.actuator);
      } else if (msg.cmd === 'monitor.runtime') {
        setRuntime(msg.runtime);
      } else if (msg.cmd === 'monitor.threadDump') {
        setThreadDumps(prev => {
          const next = new Map(prev);
          next.set(msg.dump.tid, msg.dump);
          return next;
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [configId, windowKey]);

  const grouped = useMemo(() => {
    if (!histogram) return [];
    let rows = histogram.rows;
    if (onlyOwn && ownPackage) {
      rows = rows.filter(r => r.className.startsWith(ownPackage + '.') || r.className === ownPackage);
    }
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter(r => r.className.toLowerCase().includes(f));
    }
    return groupByPackage(rows);
  }, [histogram, filter, onlyOwn, ownPackage]);

  const last = history[history.length - 1];
  const heapMb = last ? (last.heapUsed / (1024 * 1024)).toFixed(0) : '—';
  const heapMaxMb = last && last.heapMax > 0 ? (last.heapMax / (1024 * 1024)).toFixed(0) : '—';
  const uptime = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const offHeapBytes = (last?.directBuffer?.memoryUsed ?? 0) + (last?.mappedBuffer?.memoryUsed ?? 0);
  const gcPauseLast60s = gcEvents.reduce((s, ev) => s + ev.duration, 0);
  const blockedCount = threadsDetail?.states.BLOCKED ?? 0;
  const deadlocked = threadsDetail?.deadlock != null;
  const heapMaxRaw = last?.heapMax ?? -1;
  const heapUsedRaw = last?.heapUsed ?? 0;
  const cpuLoad = last?.cpuLoad ?? -1;
  const openFds = last?.openFds ?? -1;
  const maxFds = last?.maxFds ?? -1;

  const requestThreadDump = (tid: number) => {
    vscode.postMessage({ cmd: 'monitor.requestThreadDump', configId, tid });
  };
  const setLogLevel = (name: string, level: string) => {
    vscode.postMessage({ cmd: 'monitor.setLogLevel', configId, name, level });
  };

  return (
    <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)' }}>
      <h2 style={{ marginTop: 0 }}>{configName}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {(['60s', '5min', '30min'] as const).map(w => (
          <button key={w} onClick={() => setWindowKey(w)} style={{ fontWeight: w === windowKey ? 'bold' : 'normal' }}>{w}</button>
        ))}
        <button onClick={() => vscode.postMessage({ cmd: 'monitor.saveHeapDump', configId })}>Save heap dump</button>
        <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7, alignSelf: 'center' }}>
          Run duration: {Math.floor(uptime / 60)}m {uptime % 60}s
        </div>
      </div>

      <ChartStrip history={history} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginTop: 12, marginBottom: 12 }}>
        <KpiTile
          label="Heap" value={`${heapMb} MB`}
          secondary={heapMaxMb !== '—' ? `of ${heapMaxMb} MB` : 'unbounded'}
          status={heapStatus(heapUsedRaw, heapMaxRaw)}
          tooltip="Heap used / max. Yellow ≥ 70% · Red ≥ 90%."
          onClick={() => setActiveTab('memory')}
        />
        <KpiTile
          label="GC pause" value={`${gcPauseLast60s} ms`}
          secondary="last 60s"
          status={gcPauseStatus(gcPauseLast60s)}
          tooltip="Cumulative GC pause time over the last 60s. Yellow ≥ 100ms · Red ≥ 500ms."
          onClick={() => setActiveTab('memory')}
        />
        <KpiTile
          label="CPU" value={cpuLoad >= 0 ? `${(cpuLoad * 100).toFixed(1)}%` : 'n/a'}
          secondary={cpuLoad >= 0 ? 'process load' : 'unavailable'}
          status={cpuStatus(cpuLoad)}
          tooltip="Process CPU load. Yellow ≥ 70% · Red ≥ 90%."
          onClick={() => setActiveTab('threads')}
        />
        <KpiTile
          label="Threads" value={String(last?.threadCount ?? '—')}
          secondary={blockedCount > 0 ? `${blockedCount} BLOCKED` : (deadlocked ? 'deadlock!' : 'OK')}
          status={threadsStatus(blockedCount, deadlocked)}
          tooltip="Total threads + BLOCKED count. Yellow when BLOCKED > 0 · Red on deadlock."
          onClick={() => setActiveTab('threads')}
        />
        <KpiTile
          label="Off-heap" value={`${(offHeapBytes / (1024 * 1024)).toFixed(0)} MB`}
          secondary="direct + mapped"
          status={offHeapStatus(offHeapBytes, heapMaxRaw)}
          tooltip="Direct + mapped buffer bytes. Yellow ≥ 2× heapMax · Red ≥ 4× heapMax."
          onClick={() => setActiveTab('memory')}
        />
        <KpiTile
          label="Open FDs" value={openFds >= 0 ? openFds.toLocaleString() : '—'}
          secondary={maxFds > 0 ? `of ${maxFds.toLocaleString()}` : ''}
          status={fdStatus(openFds, maxFds)}
          tooltip="Open file descriptors / max. Yellow ≥ 50% · Red ≥ 80%."
          onClick={() => setActiveTab('jvm')}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--vscode-editorWidget-border, #444)' }}>
        {(
          [
            ['memory', 'Memory'],
            ['threads', 'Threads'],
            ['jvm', 'JVM internals'],
            ['app', 'App'],
          ] as Array<[TabKey, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            style={{
              border: 'none',
              borderBottom: activeTab === key ? '2px solid var(--vscode-focusBorder, #007acc)' : '2px solid transparent',
              background: 'transparent',
              padding: '6px 12px',
              cursor: 'pointer',
              color: activeTab === key ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
              fontWeight: activeTab === key ? 600 : 400,
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ padding: '12px 0' }}>
        {activeTab === 'memory' && <MemoryTab history={history} gcEvents={gcEvents} />}
        {activeTab === 'threads' && (
          <ThreadsTab
            history={history}
            threadsDetail={threadsDetail}
            threadDumps={threadDumps}
            requestThreadDump={requestThreadDump}
          />
        )}
        {activeTab === 'jvm' && <JvmInternalsTab runtime={runtime} history={history} />}
        {activeTab === 'app' && <AppTab actuator={actuator} setLogLevel={setLogLevel} />}
      </div>

      <hr style={{ margin: '16px 0' }} />
      <h3 style={{ marginBottom: 8 }}>Class histogram</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '50% 30% 1fr', gap: 8, marginBottom: 8 }}>
        <input
          placeholder="Filter (substring of class name)"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} style={{ width: '100%', boxSizing: 'border-box' }}>
          <option value="bytes">Sort: Bytes (desc)</option>
          <option value="instances">Sort: Instances (desc)</option>
          <option value="className">Sort: Class name (A→Z)</option>
        </select>
        <button
          onClick={() => {
            const next = !paused;
            setPaused(next);
            vscode.postMessage({ cmd: 'monitor.setHistogramPaused', configId, paused: next });
          }}
          style={{ width: '100%', boxSizing: 'border-box' }}
        >{paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}</button>
      </div>
      {ownPackage && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: '0.9em' }}>
          <input type="checkbox" checked={onlyOwn} onChange={e => setOnlyOwn(e.target.checked)} />
          Show only classes in <code style={{ padding: '0 4px' }}>{ownPackage}.*</code>
          <span style={{ opacity: 0.7 }}>(otherwise highlighted inline below)</span>
        </label>
      )}
      <HistogramTree nodes={grouped} sortBy={sortBy} ownPackage={ownPackage} />
    </div>
  );
}

function ChartStrip({ history }: { history: MetricsTick[] }) {
  if (history.length === 0) {
    return <div style={{ height: 140, opacity: 0.6, padding: 8 }}>No data yet</div>;
  }
  const w = 800, h = 140;
  const padTop = 16, padBottom = 18, padLeft = 56, padRight = 12;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  // Auto-scale to the visible window's heap range — scaling to -Xmx
  // squashes typical 5–10% heap usage to a flat line at the bottom.
  // We pad the range slightly so neither extreme touches the edge.
  const heapVals = history.map(m => m.heapUsed);
  const rawLo = Math.min(...heapVals);
  const rawHi = Math.max(...heapVals);
  const span = rawHi - rawLo;
  const lo = span > 0 ? rawLo - span * 0.1 : Math.max(0, rawLo - 1);
  const hi = span > 0 ? rawHi + span * 0.1 : rawHi + 1;
  const range = hi - lo || 1;

  const xFor = (i: number) => padLeft + (i / (history.length - 1 || 1)) * plotW;
  const yFor = (v: number) => padTop + plotH - ((v - lo) / range) * plotH;

  const usedPoints = history.map((m, i) => `${xFor(i)},${yFor(m.heapUsed)}`).join(' ');
  // Filled area under the heap-used line for a clear "memory" feel.
  const areaPath = [
    `M ${xFor(0)},${padTop + plotH}`,
    ...history.map((m, i) => `L ${xFor(i)},${yFor(m.heapUsed)}`),
    `L ${xFor(history.length - 1)},${padTop + plotH}`,
    'Z',
  ].join(' ');

  // Heap-committed as a secondary line if it varies meaningfully against
  // the visible range — gives the user a sense of how close used is to
  // committed.
  const committedVisible = history.some(m => m.heapCommitted >= lo && m.heapCommitted <= hi);
  const committedPoints = committedVisible
    ? history.map((m, i) => `${xFor(i)},${yFor(m.heapCommitted)}`).join(' ')
    : null;

  const fmt = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}
    >
      {/* y-axis grid + labels: top = hi, bottom = lo */}
      <line x1={padLeft} y1={padTop} x2={w - padRight} y2={padTop}
        stroke="var(--vscode-editorWidget-border, #888)" strokeOpacity="0.3" />
      <line x1={padLeft} y1={padTop + plotH} x2={w - padRight} y2={padTop + plotH}
        stroke="var(--vscode-editorWidget-border, #888)" strokeOpacity="0.3" />
      <text x={padLeft - 4} y={padTop + 4} textAnchor="end" fontSize="10"
        fill="var(--vscode-descriptionForeground, #888)">{fmt(hi)}</text>
      <text x={padLeft - 4} y={padTop + plotH} textAnchor="end" fontSize="10"
        fill="var(--vscode-descriptionForeground, #888)">{fmt(lo)}</text>
      <text x={padLeft} y={12} fontSize="10"
        fill="var(--vscode-descriptionForeground, #888)">Heap used (auto-scaled)</text>
      {/* filled area = heap used */}
      <path d={areaPath} fill="var(--vscode-charts-blue, #4080ff)" fillOpacity="0.2" />
      {/* heap-used line */}
      <polyline points={usedPoints} fill="none"
        stroke="var(--vscode-charts-blue, #4080ff)" strokeWidth={1.5} />
      {/* heap-committed line (dashed) */}
      {committedPoints && (
        <polyline points={committedPoints} fill="none"
          stroke="var(--vscode-charts-orange, #d18616)" strokeWidth={1}
          strokeDasharray="4 3" opacity="0.7" />
      )}
    </svg>
  );
}

function HistogramTree({
  nodes,
  sortBy,
  ownPackage,
}: {
  nodes: HistogramNode[];
  sortBy: 'instances' | 'bytes' | 'className';
  ownPackage: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sorted = useMemo(() => {
    const cmp = (a: HistogramNode, b: HistogramNode) => {
      if (sortBy === 'className') return a.name.localeCompare(b.name);
      const key = sortBy === 'bytes' ? 'totalBytes' : 'totalInstances';
      return b[key] - a[key];
    };
    function rec(list: HistogramNode[]): HistogramNode[] {
      const copy = [...list].sort(cmp);
      return copy.map(n => ({ ...n, children: rec(n.children) }));
    }
    return rec(nodes);
  }, [nodes, sortBy]);

  // Cumulative totals across the visible (filtered) tree — we use these
  // for the percentage column on each row.
  const totalBytes = sorted.reduce((s, n) => s + n.totalBytes, 0);
  const totalInstances = sorted.reduce((s, n) => s + n.totalInstances, 0);
  const ownSegments = ownPackage ? ownPackage.split('.') : [];

  if (sorted.length === 0) {
    return (
      <div style={{ padding: 12, opacity: 0.6, fontStyle: 'italic' }}>
        No classes match the current filter.
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: '0.9em',
        border: '1px solid var(--vscode-editorWidget-border, #444)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 110px 110px 70px',
          gap: 0,
          padding: '6px 12px',
          background: 'var(--vscode-editorWidget-background, #2a2a2a)',
          borderBottom: '1px solid var(--vscode-editorWidget-border, #444)',
          fontWeight: 600,
          fontSize: '0.85em',
          color: 'var(--vscode-descriptionForeground, #aaa)',
          letterSpacing: '0.02em',
        }}
      >
        <span>Class / package</span>
        <span style={{ textAlign: 'right' }}>Instances</span>
        <span style={{ textAlign: 'right' }}>Size</span>
        <span style={{ textAlign: 'right' }}>% of bytes</span>
      </div>
      {sorted.map((node, i) => (
        <Row
          key={node.name}
          node={node}
          depth={0}
          expanded={expanded}
          setExpanded={setExpanded}
          prefix=""
          totalBytes={totalBytes}
          totalInstances={totalInstances}
          ownSegments={ownSegments}
          ownSegmentDepth={0}
          striped={i % 2 === 1}
        />
      ))}
    </div>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function Row({
  node,
  depth,
  expanded,
  setExpanded,
  prefix,
  totalBytes,
  totalInstances,
  ownSegments,
  ownSegmentDepth,
  striped,
}: {
  node: HistogramNode;
  depth: number;
  expanded: Set<string>;
  setExpanded: (updater: (s: Set<string>) => Set<string>) => void;
  prefix: string;
  totalBytes: number;
  totalInstances: number;
  ownSegments: string[];
  ownSegmentDepth: number;
  striped: boolean;
}) {
  const id = `${prefix}/${node.name}`;
  const isOpen = expanded.has(id);
  const hasChildren = node.children.length > 0;
  const pct = totalBytes > 0 ? (node.totalBytes / totalBytes) * 100 : 0;

  // Track depth-into-ownSegments to decide highlight state.
  // - matchProgress < ownSegments.length: still on the prefix path.
  // - matchProgress === ownSegments.length: this row (or an ancestor) IS
  //   inside the own-package — highlight as "ours".
  // The check uses the row's `name` against the next expected segment.
  const onOwnPath =
    ownSegments.length > 0 &&
    ownSegmentDepth < ownSegments.length &&
    node.name === ownSegments[ownSegmentDepth];
  const insideOwnPackage =
    ownSegments.length > 0 && ownSegmentDepth >= ownSegments.length;
  const childOwnDepth = onOwnPath ? ownSegmentDepth + 1 : ownSegmentDepth;
  const isOwn = insideOwnPackage;

  // Row background — subtle stripe + own-package tint.
  const baseBg = striped
    ? 'var(--vscode-list-evenBackground, transparent)'
    : 'transparent';
  const bg = isOwn
    ? 'color-mix(in srgb, var(--vscode-charts-green, #16825d) 14%, transparent)'
    : baseBg;

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 110px 110px 70px',
          gap: 0,
          padding: '4px 12px',
          paddingLeft: 12 + depth * 14,
          cursor: hasChildren ? 'pointer' : 'default',
          background: bg,
          borderLeft: isOwn
            ? '3px solid var(--vscode-charts-green, #16825d)'
            : '3px solid transparent',
          alignItems: 'center',
        }}
        onClick={() => {
          if (!hasChildren) return;
          setExpanded(s => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: isOwn ? 600 : 400,
          }}
          title={node.name}
        >
          <span
            style={{
              display: 'inline-block',
              width: 12,
              opacity: hasChildren ? 1 : 0,
              flex: 'none',
            }}
          >
            {hasChildren ? (isOpen ? '▾' : '▸') : '·'}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {node.name}
          </span>
        </span>
        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {node.totalInstances.toLocaleString()}
        </span>
        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmtBytes(node.totalBytes)}
        </span>
        <span
          style={{
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            opacity: pct < 0.1 ? 0.5 : 1,
          }}
        >
          {pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`}
        </span>
      </div>
      {isOpen &&
        node.children.map((c, i) => (
          <Row
            key={c.name}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            setExpanded={setExpanded}
            prefix={id}
            totalBytes={totalBytes}
            totalInstances={totalInstances}
            ownSegments={ownSegments}
            ownSegmentDepth={childOwnDepth}
            striped={i % 2 === 1}
          />
        ))}
    </>
  );
}
