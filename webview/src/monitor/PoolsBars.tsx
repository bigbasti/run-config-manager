import type { PoolUsage } from '../../../src/services/monitoring/AgentMessage';
import { categorizePool, type PoolCategory } from '../../../src/services/monitoring/poolCategories';

const CATEGORY_LABEL: Record<PoolCategory, string> = {
  young: 'Young',
  survivor: 'Survivor',
  old: 'Old',
  metaspace: 'Metaspace',
  codeCache: 'Code Cache',
  other: 'Other',
};
const CATEGORY_COLOR: Record<PoolCategory, string> = {
  young: 'var(--vscode-charts-green, #4caf50)',
  survivor: 'var(--vscode-charts-yellow, #ffaa33)',
  old: 'var(--vscode-charts-blue, #4080ff)',
  metaspace: 'var(--vscode-charts-orange, #d18616)',
  codeCache: 'var(--vscode-charts-purple, #b180d7)',
  other: 'var(--vscode-charts-foreground, #888)',
};
const CATEGORY_ORDER: PoolCategory[] = ['young', 'survivor', 'old', 'metaspace', 'codeCache', 'other'];

// Renders one row per pool category, each a horizontal bar showing
// used / committed / max with a tooltip that lists the underlying pools.
export function PoolsBars({ pools }: { pools: Record<string, PoolUsage> }) {
  const grouped = groupPools(pools);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {CATEGORY_ORDER.filter(c => grouped[c].pools.length > 0).map(category => {
        const g = grouped[category];
        const ratio = g.maxBytes > 0 ? g.usedBytes / g.maxBytes : 0;
        const barFill = `${Math.min(100, ratio * 100)}%`;
        const tooltipLines = g.pools.map(([name, u]) =>
          `${name}: ${fmtMb(u.used)} / ${fmtMb(u.committed)} (max ${u.max > 0 ? fmtMb(u.max) : '∞'})`
        );
        return (
          <div key={category} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 220px', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <div style={{ color: 'var(--vscode-descriptionForeground, #aaa)' }}>{CATEGORY_LABEL[category]}</div>
            <div
              title={tooltipLines.join('\n')}
              style={{
                position: 'relative',
                height: 16,
                background: 'var(--vscode-editorWidget-background, #2a2a2a)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: barFill,
                  height: '100%',
                  background: CATEGORY_COLOR[category],
                  opacity: 0.85,
                }}
              />
            </div>
            <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--vscode-descriptionForeground, #aaa)' }}>
              {fmtMb(g.usedBytes)} / {g.maxBytes > 0 ? fmtMb(g.maxBytes) : '∞'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function groupPools(pools: Record<string, PoolUsage>): Record<PoolCategory, { pools: Array<[string, PoolUsage]>; usedBytes: number; maxBytes: number }> {
  const out: Record<PoolCategory, { pools: Array<[string, PoolUsage]>; usedBytes: number; maxBytes: number }> = {
    young: { pools: [], usedBytes: 0, maxBytes: 0 },
    survivor: { pools: [], usedBytes: 0, maxBytes: 0 },
    old: { pools: [], usedBytes: 0, maxBytes: 0 },
    metaspace: { pools: [], usedBytes: 0, maxBytes: 0 },
    codeCache: { pools: [], usedBytes: 0, maxBytes: 0 },
    other: { pools: [], usedBytes: 0, maxBytes: 0 },
  };
  for (const [name, u] of Object.entries(pools)) {
    const cat = categorizePool(name);
    out[cat].pools.push([name, u]);
    out[cat].usedBytes += Math.max(0, u.used);
    if (u.max > 0) out[cat].maxBytes += u.max;
  }
  return out;
}

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
