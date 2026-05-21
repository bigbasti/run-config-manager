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
        <Card title="Runtime" tooltip="Static JVM identity information read once at agent connect time.">
          {runtime ? (
            <KeyVals rows={[
              ['Vendor', runtime.vendor, 'JVM vendor (e.g. Oracle, Eclipse Adoptium, Azul).'],
              ['VM', runtime.vmName, 'JVM implementation name (e.g. OpenJDK 64-Bit Server VM).'],
              ['Version', runtime.version, 'JVM version string.'],
              ['PID', String(runtime.pid), 'Operating system process ID of this JVM.'],
              ['Uptime', uptimeStr, 'Time elapsed since the JVM process started.'],
            ]} />
          ) : <div style={{ opacity: 0.6 }}>Reading…</div>}
        </Card>
        <Card title="Class loading" tooltip="Counts from ClassLoadingMXBean. A large positive Δ over the visible window while the app is idle may indicate repeated classloader activity or a class-generation hotspot.">
          <KeyVals rows={[
            ['Currently loaded', last?.loadedClasses?.toLocaleString() ?? '—', 'Number of classes currently loaded in this JVM.'],
            ['Total ever loaded', last?.totalLoadedClasses?.toLocaleString() ?? '—', 'Cumulative count of classes loaded since the JVM started. Includes classes that were subsequently unloaded.'],
            ['Unloaded', last?.unloadedClasses?.toLocaleString() ?? '—', 'Cumulative count of classes unloaded since the JVM started. A rising value is normal (OSGi, scripting engines); zero is also normal for simple apps.'],
            ['Δ over window', loadedDelta !== null ? (loadedDelta > 0 ? `+${loadedDelta} ⚠` : String(loadedDelta)) : '—', 'Change in currently-loaded class count over the visible history window. A continuously positive delta while the app is idle may indicate a classloader leak.'],
          ]} />
        </Card>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="JIT compiler" tooltip="HotSpot JIT (Just-In-Time) compiler statistics. The JIT compiles frequently-called bytecode to native machine code for better performance.">
          <KeyVals rows={[
            ['Compile time', last?.compileTimeMs != null ? `${last.compileTimeMs.toLocaleString()} ms` : '—', 'Cumulative wall-clock time spent compiling methods since JVM start. A rapidly rising value means the JIT is working hard — typically during warmup. After warmup this should stabilise.'],
          ]} />
        </Card>
        <Card title="Operating system" tooltip="Host OS metrics as seen by the JVM process.">
          <KeyVals rows={[
            ['System load avg', last?.systemLoad != null && last.systemLoad >= 0 ? last.systemLoad.toFixed(2) : '—', '1-minute system load average (Unix). A value equal to the number of CPU cores means the system is at full utilisation. Values above the core count indicate a queuing situation.'],
            ['Free / total RAM', last?.freePhysicalMemory && last?.totalPhysicalMemory
              ? `${fmtGb(last.freePhysicalMemory)} / ${fmtGb(last.totalPhysicalMemory)}`
              : '—', 'Host physical memory available vs total. Low free RAM may cause the OS to swap JVM pages to disk, leading to latency spikes.'],
            ['Free swap', last?.freeSwap != null ? fmtGb(last.freeSwap) : '—', 'Available swap space on the host. Active swap usage by the JVM process causes severe latency — GC pauses become unpredictable.'],
            ['Open file descriptors', last?.openFds != null && last.openFds >= 0
              ? `${last.openFds.toLocaleString()} of ${last.maxFds && last.maxFds > 0 ? last.maxFds.toLocaleString() : '—'}`
              : '—', 'Number of file descriptors currently open by this JVM process (sockets, files, pipes) vs the OS-imposed limit. Exhausting this limit causes connection-refused and file-open errors.'],
          ]} />
        </Card>
      </section>

      {runtime && (
        <>
          <Collapsible
            title={`JVM args (${runtime.inputArgs.length})`}
            tooltip="Command-line arguments passed to the JVM process itself (e.g. -Xmx, -agentlib, -D flags). These are the flags before the main class or jar name."
          >
            <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}>{runtime.inputArgs.join('\n')}</pre>
          </Collapsible>
          <Collapsible
            title={`System properties (${Object.keys(runtime.systemProperties).length})`}
            tooltip="Java system properties (key=value pairs set via -D flags or System.setProperty). Includes both JVM defaults and application-specific configuration."
          >
            <KeyVals rows={Object.entries(runtime.systemProperties).sort((a, b) => a[0].localeCompare(b[0]))} />
          </Collapsible>
          <Collapsible
            title={`Environment variables (${Object.keys(runtime.environment).length})`}
            tooltip="Environment variables inherited by this JVM process from the shell that started it. Note: this shows the monitoring agent's own environment, which typically mirrors the target JVM's environment."
          >
            <KeyVals rows={Object.entries(runtime.environment).sort((a, b) => a[0].localeCompare(b[0]))} />
          </Collapsible>
        </>
      )}
    </div>
  );
}

function Card({ title, tooltip, children }: { title: string; tooltip?: string; children: ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--vscode-editorWidget-border, #444)',
      borderRadius: 4,
      padding: 10,
    }}>
      <div
        title={tooltip}
        style={{
          fontSize: 11,
          color: 'var(--vscode-descriptionForeground, #aaa)',
          textTransform: 'uppercase',
          marginBottom: 6,
          letterSpacing: '0.04em',
          cursor: tooltip ? 'help' : 'default',
          textDecoration: tooltip ? 'underline dotted' : 'none',
          display: 'inline-block',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

// rows: [label, value, optional tooltip for the label]
function KeyVals({ rows }: { rows: Array<[string, string, string?]> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 3, fontSize: 12 }}>
      {rows.map(([k, v, tip]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span
            title={tip}
            style={{
              color: 'var(--vscode-descriptionForeground, #aaa)',
              cursor: tip ? 'help' : 'default',
              textDecoration: tip ? 'underline dotted' : 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {k}
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Collapsible({ title, tooltip, children }: { title: string; tooltip?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4 }}>
      <div
        onClick={() => setOpen(o => !o)}
        title={tooltip}
        style={{ padding: '6px 12px', cursor: 'pointer', userSelect: 'none', fontSize: 12 }}
      >
        {open ? '▾ ' : '▸ '}{title}
        {tooltip && <span style={{ marginLeft: 6, opacity: 0.5, fontSize: 10 }}>(?)</span>}
      </div>
      {open && <div style={{ padding: '0 12px 10px' }}>{children}</div>}
    </div>
  );
}

function fmtGb(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}
