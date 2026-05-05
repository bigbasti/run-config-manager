import { useState } from 'react';

interface Props {
  filePath: string;
  variables: Record<string, string>;
  onClose: () => void;
}

// Modal preview of variables loaded from one .env file. Secret-looking
// keys (PASSWORD/TOKEN/SECRET/KEY/...) start as ***; clicking a row
// toggles between masked and plain. Clicking again on a non-secret row
// also toggles, so users can mask a value by hand if their screen is
// being shared. Mirror the eye-icon UX from the inspect dialog used by
// vmArgs / programArgs.
export function EnvFilePreviewDialog({ filePath, variables, onClose }: Props) {
  const entries = Object.entries(variables);
  // Per-row visibility override. Initial state isn't stored — the
  // `looksLikeSecret` check on each row drives the default masked state,
  // and the `revealed` set records "user clicked this row to flip it".
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setRevealed(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Variables in ${filePath}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)',
          maxHeight: '80vh',
          overflowY: 'auto',
          background: 'var(--vscode-editor-background)',
          color: 'var(--vscode-editor-foreground)',
          border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.5))',
          borderRadius: 4,
          padding: 16,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Variables in {filePath}</h3>
          <span style={{ opacity: 0.7, fontSize: '0.85em' }}>{entries.length} variable{entries.length === 1 ? '' : 's'}</span>
        </div>
        <p style={{ marginTop: 0, marginBottom: 10, fontSize: '0.85em', opacity: 0.75 }}>
          Click any value to toggle between masked and plain text. Keys that look
          like secrets (PASSWORD, TOKEN, SECRET, KEY, …) start masked.
        </p>
        {entries.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No variables.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '0.92em' }}>
            {entries.map(([k, value]) => {
              const isSecret = looksLikeSecret(k);
              const showPlain = isSecret ? revealed.has(k) : !revealed.has(k);
              return (
                <Row key={k} k={k} value={value} showPlain={showPlain} onToggle={() => toggle(k)} />
              );
            })}
          </div>
        )}
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, value, showPlain, onToggle }: {
  k: string;
  value: string;
  showPlain: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <div style={{ opacity: 0.85 }}>{k}</div>
      <div
        onClick={onToggle}
        title={showPlain ? 'Click to mask' : 'Click to reveal'}
        style={{ cursor: 'pointer', wordBreak: 'break-all' }}
      >
        {showPlain ? (value === '' ? <span style={{ opacity: 0.5 }}>(empty)</span> : value) : maskValue(value)}
      </div>
    </>
  );
}

function maskValue(v: string): string {
  if (v.length === 0) return '(empty)';
  // Fixed length so different secrets don't reveal length information.
  return '••••••••';
}

// Mirrors the SECRET_KEY_RE in EnvFileLoader.ts. We intentionally
// duplicate (small literal regex) rather than ship the import path and
// pull more of the extension into the webview bundle.
const SECRET_KEY_RE = /(?:^|_)(PASSWORD|PASSWD|PWD|TOKEN|SECRET|KEY|APIKEY|API_KEY|CREDENTIAL|PRIVATE)(?:_|$)/i;
function looksLikeSecret(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}
