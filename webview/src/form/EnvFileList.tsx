import { useState } from 'react';
import { EnvFilePreviewDialog } from './EnvFilePreviewDialog';

// Per-file load status as reported by the extension. Fed in via props
// (App.tsx subscribes to the `envFilesLoaded` inbound and forwards the
// metadata down). Variables come along so the eye-icon dialog renders
// without an extra round-trip per click.
export interface EnvFileStatus {
  path: string;
  loaded: boolean;
  count: number;
  variables: Record<string, string>;
  error?: 'missing' | 'parse-error' | 'read-error';
  errorDetail?: string;
}

interface Props {
  files: string[];
  // Status keyed by path so multiple identical-path entries (rare but
  // possible) all render their state. Length-mismatched arrays would be
  // brittle, hence the keyed shape.
  status: Map<string, EnvFileStatus>;
  onAdd: () => void;
  onRemove: (index: number) => void;
  // Wired to Field's focus/blur callbacks so this composite control can
  // drive the help panel the same way the regular text inputs do —
  // clicking inside the list (or the Add button) surfaces the
  // envFileList field's help text. Without these, focus lived on
  // <button>s the help panel ignored.
  onFocus?: () => void;
  onBlur?: () => void;
}

// Render block that lives directly above the env-vars KV editor. Each
// added file shows up as a pill: [.env] [path] [N vars] [👁] [🗑].
// Missing files render orange with a hint instead of a count, so the user
// can see at a glance which files would silently be skipped at run time.
export function EnvFileList({ files, status, onAdd, onRemove, onFocus, onBlur }: Props) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  return (
    // onFocus/onBlur on the wrapper catch focus from any child button —
    // they bubble in React. That covers Add, trash, eye, and any other
    // future affordance without per-element wiring.
    <div
      style={{ marginBottom: 8 }}
      onFocus={onFocus}
      onBlur={onBlur}
      // Clicking on the row strip (e.g. the path text) doesn't move
      // browser focus; nudge the help panel so users see docs even when
      // they only click rather than tab.
      onClick={onFocus}
    >
      {files.map((p, idx) => {
        const s = status.get(p);
        const missing = s?.error === 'missing';
        const errored = s?.error && s.error !== 'missing';
        // The row uses the same `.kv-row` class as the env table just
        // below so the heights align — the path takes a single line and
        // ellipses when long. Status pills, eye, trash stay flush right.
        return (
          <div
            key={`${idx}-${p}`}
            className="kv-row"
            style={{
              // Override .kv-row's 3-col grid (1fr 1fr auto) — that grid
              // is sized for the env table below; for an env-files row we
              // want a single flex strip so everything stays inline and
              // the buttons hug the right edge.
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              ...(missing ? {
                background: 'var(--vscode-inputValidation-warningBackground, rgba(255,165,0,0.12))',
                borderLeft: '3px solid var(--vscode-inputValidation-warningBorder, orange)',
                paddingLeft: 6,
                borderRadius: 2,
              } : {}),
              ...(errored ? {
                background: 'var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.12))',
                borderLeft: '3px solid var(--vscode-inputValidation-errorBorder, #be1100)',
                paddingLeft: 6,
                borderRadius: 2,
              } : {}),
            }}
          >
            <span
              title={p}
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {p}
            </span>
            <span style={{ flexShrink: 0, fontSize: '0.85em', opacity: 0.85 }}>
              {missing ? '⚠ file not found'
                : errored ? `⚠ ${s?.error ?? 'error'}`
                : s ? `${s.count} variable${s.count === 1 ? '' : 's'}`
                : 'loading…'}
            </span>
            <button
              type="button"
              className="secondary icon-button"
              title="Remove this .env file"
              aria-label="Remove .env file"
              onClick={() => onRemove(idx)}
            >
              🗑
            </button>
            <button
              type="button"
              className="secondary icon-button"
              title={s?.loaded
                ? 'Show variables loaded from this file (values masked by default for secret-looking keys)'
                : 'No variables to show — file is missing or unreadable'}
              aria-label="Show variables"
              disabled={!s?.loaded}
              onClick={() => setPreviewIdx(idx)}
            >
              👁
            </button>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, marginTop: files.length ? 4 : 0 }}>
        <button type="button" className="secondary" onClick={onAdd}>
          + Add .env file
        </button>
      </div>
      {previewIdx !== null && files[previewIdx] && (() => {
        const s = status.get(files[previewIdx]);
        return s?.loaded ? (
          <EnvFilePreviewDialog
            filePath={files[previewIdx]}
            variables={s.variables}
            onClose={() => setPreviewIdx(null)}
          />
        ) : null;
      })()}
    </div>
  );
}
