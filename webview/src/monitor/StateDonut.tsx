const STATE_COLOR: Record<string, string> = {
  RUNNABLE: 'var(--vscode-charts-green, #4caf50)',
  BLOCKED: 'var(--vscode-charts-red, #f44747)',
  WAITING: 'var(--vscode-charts-blue, #4080ff)',
  TIMED_WAITING: 'var(--vscode-charts-purple, #b180d7)',
  NEW: 'var(--vscode-charts-yellow, #ffaa33)',
  TERMINATED: 'var(--vscode-descriptionForeground, #888)',
};
const STATE_ORDER = ['RUNNABLE', 'BLOCKED', 'WAITING', 'TIMED_WAITING', 'NEW', 'TERMINATED'];

const STATE_TOOLTIP: Record<string, string> = {
  RUNNABLE: 'RUNNABLE — thread is executing or ready to execute on a CPU core. High counts here are normal under load.',
  BLOCKED: 'BLOCKED — thread is waiting to acquire a monitor lock held by another thread. Elevated counts indicate lock contention.',
  WAITING: 'WAITING — thread is parked indefinitely (e.g. Object.wait(), LockSupport.park()). Normal for thread-pool idle threads.',
  TIMED_WAITING: 'TIMED_WAITING — thread is sleeping for a fixed duration (e.g. Thread.sleep(), Object.wait(timeout)). Normal for scheduled tasks.',
  NEW: 'NEW — thread has been created but not yet started.',
  TERMINATED: 'TERMINATED — thread has finished execution but not yet been garbage-collected.',
};

// Conic-section donut chart for thread state distribution. Render as
// flat 2D ring; mid-point label = total count.
export function StateDonut({ states, size = 120 }: { states: Record<string, number>; size?: number }) {
  const total = Object.values(states).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div style={{ width: size, height: size, opacity: 0.6 }}>No threads</div>;
  }
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 4;
  const inner = r * 0.6;
  let acc = 0;
  const arcs = STATE_ORDER.filter(k => states[k] > 0).map(state => {
    const count = states[state];
    const fraction = count / total;
    const start = acc * 2 * Math.PI - Math.PI / 2;
    const end = (acc + fraction) * 2 * Math.PI - Math.PI / 2;
    acc += fraction;
    const largeArc = fraction > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const ix1 = cx + inner * Math.cos(end);
    const iy1 = cy + inner * Math.sin(end);
    const ix2 = cx + inner * Math.cos(start);
    const iy2 = cy + inner * Math.sin(start);
    const path = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
    return { state, count, path };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg width={size} height={size}>
        {arcs.map(a => (
          <path key={a.state} d={a.path} fill={STATE_COLOR[a.state] ?? STATE_COLOR.TERMINATED}>
            <title>{`${a.state}: ${a.count}\n${STATE_TOOLTIP[a.state] ?? ''}`}</title>
          </path>
        ))}
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={size * 0.18} fill="var(--vscode-foreground, #d4d4d4)">
          {total}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
        {STATE_ORDER.filter(k => states[k] > 0).map(state => (
          <div
            key={state}
            title={STATE_TOOLTIP[state]}
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'help' }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: STATE_COLOR[state] ?? STATE_COLOR.TERMINATED, flex: 'none' }} />
            <span>{state}: {states[state]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
