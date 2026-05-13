import { useState } from 'react';
import type { ReactNode } from 'react';
import type { MetricsTick, RuntimeInfo } from '../../../src/services/monitoring/AgentMessage';

// JVM internals drill-down — vendor / version / args / class loading /
// JIT / OS signals / collapsible static info.
export function JvmInternalsTab({ runtime, history }: { runtime: RuntimeInfo | null; history: MetricsTick[] }) {
  const last = history[history.length - 1];
  const first = history[0];
  const loadedDelta = first?.loadedClasses != null && last?.loadedClasses != null
    ? last.loadedClasses - first.loadedClasses
    : null;
  const uptimeSec = runtime ? Math.floor((Date.now() - runtime.startTime) / 1000) : 0;
  const uptimeStr = `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Runtime">
          {runtime ? (
            <KeyVals rows={[
              ['Vendor', runtime.vendor],
              ['VM', runtime.vmName],
              ['Version', runtime.version],
              ['PID', String(runtime.pid)],
              ['Uptime', uptimeStr],
            ]} />
          ) : <div style={{ opacity: 0.6 }}>Reading…</div>}
        </Card>
        <Card title="Class loading">
          <KeyVals rows={[
            ['Loaded', last?.loadedClasses?.toLocaleString() ?? '—'],
            ['Total ever loaded', last?.totalLoadedClasses?.toLocaleString() ?? '—'],
            ['Unloaded', last?.unloadedClasses?.toLocaleString() ?? '—'],
            ['Δ over visible window', loadedDelta !== null ? (loadedDelta > 0 ? `+${loadedDelta} ⚠` : String(loadedDelta)) : '—'],
          ]} />
        </Card>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="JIT">
          <KeyVals rows={[
            ['Compile time', last?.compileTimeMs != null ? `${last.compileTimeMs.toLocaleString()} ms` : '—'],
          ]} />
        </Card>
        <Card title="OS">
          <KeyVals rows={[
            ['System load', last?.systemLoad != null && last.systemLoad >= 0 ? last.systemLoad.toFixed(2) : '—'],
            ['Free RAM', last?.freePhysicalMemory && last?.totalPhysicalMemory
              ? `${fmtGb(last.freePhysicalMemory)} / ${fmtGb(last.totalPhysicalMemory)}`
              : '—'],
            ['Free swap', last?.freeSwap != null ? fmtGb(last.freeSwap) : '—'],
            ['Open FDs', last?.openFds != null && last.openFds >= 0
              ? `${last.openFds.toLocaleString()} of ${last.maxFds && last.maxFds > 0 ? last.maxFds.toLocaleString() : '—'}`
              : '—'],
          ]} />
        </Card>
      </section>

      {runtime && (
        <>
          <Collapsible title={`JVM args (${runtime.inputArgs.length})`}>
            <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}>{runtime.inputArgs.join('\n')}</pre>
          </Collapsible>
          <Collapsible title={`System properties (${Object.keys(runtime.systemProperties).length})`}>
            <KeyVals rows={Object.entries(runtime.systemProperties).sort((a, b) => a[0].localeCompare(b[0]))} />
          </Collapsible>
          <Collapsible title={`Environment (${Object.keys(runtime.environment).length})`}>
            <KeyVals rows={Object.entries(runtime.environment).sort((a, b) => a[0].localeCompare(b[0]))} />
          </Collapsible>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--vscode-editorWidget-border, #444)',
      borderRadius: 4,
      padding: 10,
    }}>
      <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground, #aaa)', textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.04em' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function KeyVals({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 3, fontSize: 12 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ color: 'var(--vscode-descriptionForeground, #aaa)' }}>{k}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4 }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: '6px 12px', cursor: 'pointer', userSelect: 'none', fontSize: 12 }}>
        {open ? '▾ ' : '▸ '}{title}
      </div>
      {open && <div style={{ padding: '0 12px 10px' }}>{children}</div>}
    </div>
  );
}

function fmtGb(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}
