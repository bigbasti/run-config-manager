interface Warning {
  reason: string;
  suggestion?: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  onPick: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  // When the field is opted-in to build-path validation and a check has
  // come back with a problem, the result lives here. Rendered as a
  // warning line under the input plus (when `suggestion` is set) an
  // "Apply suggestion" button that replaces the value.
  warning?: Warning | null;
  onApplySuggestion?: (path: string) => void;
}

export function FolderPathInput({ value, onChange, onPick, onFocus, onBlur, warning, onApplySuggestion }: Props) {
  return (
    <>
      <div className="row-folder">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="(workspace folder)"
          onFocus={onFocus}
          onBlur={onBlur}
        />
        <button type="button" className="secondary" onClick={onPick}>Browse…</button>
      </div>
      {warning && (
        <div
          style={{
            marginTop: 4,
            padding: '4px 8px',
            color: 'var(--vscode-editorWarning-foreground, var(--vscode-inputValidation-warningForeground, #dd8800))',
            background: 'var(--vscode-inputValidation-warningBackground, transparent)',
            border: '1px solid var(--vscode-inputValidation-warningBorder, transparent)',
            borderRadius: 2,
            fontSize: '0.9em',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span>⚠ {warning.reason}</span>
          {warning.suggestion !== undefined && onApplySuggestion && (
            <button
              type="button"
              className="secondary"
              onClick={() => onApplySuggestion(warning.suggestion!)}
              style={{ fontSize: 'inherit' }}
            >
              Use {warning.suggestion || '(workspace root)'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
