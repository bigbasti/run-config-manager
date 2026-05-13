import type { GcEvent } from '../../../src/services/monitoring/AgentMessage';

// 60s strip of GC events. Each bar is rendered at its event time; height
// uses log(duration) so a 1s pause stands out next to a 5ms one.
export function GcTimeline({ events, now }: { events: GcEvent[]; now: number }) {
  const w = 800, h = 60;
  const windowMs = 60_000;
  const xFor = (t: number) => ((t - (now - windowMs)) / windowMs) * w;
  const heightFor = (durationMs: number) => {
    const logged = Math.log10(Math.max(1, durationMs)); // 0..3 for 1..1000ms
    return Math.min(h, 8 + logged * 14);
  };
  const colorFor = (collector: string) => {
    const c = collector.toLowerCase();
    if (c.includes('young')) return 'var(--vscode-charts-green, #4caf50)';
    if (c.includes('old') || c.includes('mark')) return 'var(--vscode-charts-red, #f44747)';
    if (c.includes('major')) return 'var(--vscode-charts-red, #f44747)';
    return 'var(--vscode-charts-orange, #ffaa33)';
  };

  if (events.length === 0) {
    return (
      <div style={{ height: h, opacity: 0.6, padding: 8, fontSize: 12 }}>
        No GC events in the last 60s.
      </div>
    );
  }

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ background: 'var(--vscode-editorWidget-background)', display: 'block' }}
    >
      {events.map(ev => {
        const x = xFor(ev.t);
        const barH = heightFor(ev.duration);
        const tooltip = `${ev.collector} · ${ev.duration}ms · ${ev.cause} (${ev.action})`;
        return (
          <g key={`${ev.t}-${ev.collector}`}>
            <title>{tooltip}</title>
            <rect
              x={x - 1.5}
              y={h - barH}
              width={3}
              height={barH}
              fill={colorFor(ev.collector)}
            />
          </g>
        );
      })}
    </svg>
  );
}
