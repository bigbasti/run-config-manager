import type { HealthStatus } from '../../../src/services/monitoring/healthThresholds';

// One generic colored tile in the Monitor view's KPI row. Click bubbles
// up to MonitorView to switch tabs.
export function KpiTile({
  label,
  value,
  secondary,
  status,
  tooltip,
  onClick,
}: {
  label: string;
  value: string;
  secondary?: string;
  status: HealthStatus;
  tooltip?: string;
  onClick?: () => void;
}) {
  const palette = paletteFor(status);
  return (
    <div
      onClick={onClick}
      title={tooltip}
      style={{
        background: palette.bg,
        borderLeft: `3px solid ${palette.border}`,
        padding: 10,
        borderRadius: 3,
        color: 'var(--vscode-foreground, #d4d4d4)',
        cursor: onClick ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #aaa)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, margin: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {secondary && (
        <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #888)' }}>
          {secondary}
        </div>
      )}
    </div>
  );
}

function paletteFor(status: HealthStatus): { bg: string; border: string } {
  if (status === 'critical') {
    return { bg: 'color-mix(in srgb, #f44747 14%, transparent)', border: '#f44747' };
  }
  if (status === 'warn') {
    return { bg: 'color-mix(in srgb, #ffaa33 14%, transparent)', border: '#ffaa33' };
  }
  return { bg: 'color-mix(in srgb, #4caf50 14%, transparent)', border: '#4caf50' };
}
