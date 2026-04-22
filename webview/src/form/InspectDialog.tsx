import { useEffect, useMemo } from 'react';

interface Props {
  title: string;
  value: string;
  onClose: () => void;
}

// Minimal modal that lists each whitespace-separated token on its own row.
// Respects simple double-quote grouping so `-Dkey="value with spaces"` stays
// one token. Rendered as a centered overlay; backdrop click and Escape close.
export function InspectDialog({ title, value, onClose }: Props) {
  const tokens = useMemo(() => splitTokens(value), [value]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="inspect-backdrop" onClick={onClose}>
      <div className="inspect-dialog" onClick={e => e.stopPropagation()}>
        <div className="inspect-header">
          <h3 style={{ margin: 0 }}>Inspect: {title}</h3>
          <button type="button" className="secondary icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {tokens.length === 0 ? (
          <p className="empty">(empty)</p>
        ) : (
          <table className="inspect-table">
            <thead>
              <tr><th>#</th><th>Token</th></tr>
            </thead>
            <tbody>
              {tokens.map((t, i) => (
                <tr key={i}>
                  <td className="inspect-index">{i + 1}</td>
                  <td className="inspect-token"><code>{t}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Simple shell-style splitter: whitespace separates, double quotes group.
// Mirrors `splitArgs` in npm/splitArgs.ts but duplicated here so the webview
// doesn't need to reach into extension-side code.
function splitTokens(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < input.length) { cur += input[++i]; }
      else if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
    } else if (/\s/.test(c)) {
      if (cur.length) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
    i++;
  }
  if (cur.length) out.push(cur);
  return out;
}
