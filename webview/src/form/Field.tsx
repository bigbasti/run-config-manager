import { useState, type CSSProperties } from 'react';
import type { FormField } from '../../../src/shared/formSchema';
import { getPath, setPath } from '../state';
import { KvEditor } from './KvEditor';
import { FolderPathInput } from './FolderPathInput';
import { SelectOrCustom } from './SelectOrCustom';
import { CsvChecklist } from './CsvChecklist';
import { InspectDialog } from './InspectDialog';
import { DependencyList } from './DependencyList';

interface Props {
  field: FormField;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onPickFolder?: () => void;
  onFocusField?: (key: string | null) => void;
  onFieldAction?: (actionId: string) => void;
  busyActionId?: string | null;
  pending?: Set<string>;
  // Validation results for folderPath fields with `validateBuildPath`.
  // Map key is the field key; value is null when the path is valid,
  // {reason, suggestion?} when not. Undefined means "not validated yet".
  pathWarnings?: Map<string, { reason: string; suggestion?: string } | null>;
  onValidatePath?: (fieldKey: string, buildTool: 'maven' | 'gradle' | 'either', path: string) => void;
  // Server-side field errors from a rejected save or a Fix-invalid open.
  // Lookup by field key. Undefined means "no error"; otherwise the message
  // is rendered below the input and a red border is drawn around the field.
  fieldErrors?: Map<string, string>;
}

export function Field({ field, values, onChange, onPickFolder, onFocusField, onFieldAction, busyActionId, pending, pathWarnings, onValidatePath, fieldErrors }: Props) {
  // Honor dependsOn: hide the field if its dependency's current value doesn't match.
  if (field.dependsOn) {
    const dep = getPath(values, field.dependsOn.key);
    const equals = field.dependsOn.equals;
    const matches = Array.isArray(equals) ? equals.includes(dep as string) : dep === equals;
    if (!matches) return null;
  }

  const v = getPath(values, field.key);
  const set = (next: unknown) => onChange(setPath(values, field.key, next));
  const focus = () => onFocusField?.(field.key);
  // Blur intentionally does NOT clear the focused key. If blur reset the
  // help panel to empty, its height would collapse just as the user moves
  // toward the Save button — shifting the button out from under the cursor
  // and causing a second click. The help text for the last-focused field
  // stays visible until another field GAINS focus.
  const blur = () => { /* keep previous help until next focus */ };

  const action = field.action;
  const actionBusy = action ? busyActionId === action.id : false;
  const isPending = pending?.has(field.key) ?? false;
  const [inspectOpen, setInspectOpen] = useState(false);

  const inspectable = field.inspectable && typeof v === 'string';

  const isRequired = Boolean(field.required);
  const errorMessage = fieldErrors?.get(field.key);

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>
          {field.label}
          {isRequired && (
            <span
              title="Required"
              aria-label="Required"
              style={{
                color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #ff5555))',
                marginLeft: 3,
                fontWeight: 700,
              }}
            >*</span>
          )}
        </span>
        {isPending && <span className="field-spinner" title="Detecting…">⟳</span>}
      </label>
      <div
        className="field-row"
        style={errorMessage ? {
          // A red outline around the whole field-row. Uses VS Code's
          // native input-validation palette so it matches themes.
          outline: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
          outlineOffset: 1,
          borderRadius: 2,
        } : undefined}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {renderInput(field, v, set, {
            onPickFolder,
            focus,
            blur,
            pathWarning: pathWarnings?.get(field.key),
            onValidatePath,
          })}
        </div>
        {inspectable && (
          <button
            type="button"
            className="secondary icon-button"
            title="Split view — see each token on its own line"
            aria-label="Inspect tokens"
            onClick={() => setInspectOpen(true)}
          >
            👁
          </button>
        )}
      </div>
      {errorMessage && (
        <div
          style={{
            marginTop: 4,
            padding: '2px 6px',
            color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #ff5555))',
            background: 'var(--vscode-inputValidation-errorBackground, transparent)',
            fontSize: '0.9em',
          }}
        >
          ✖ {errorMessage}
        </div>
      )}
      {/* Non-blocking advisory warning. Differs from errorMessage (red,
          save-blocking) — this renders yellow and is informational only.
          Adapter-driven: e.g. "DevTools not on the classpath" under
          Rebuild on save. Suppressed when an error is already shown on
          the same field to avoid piling on.
          Also respects `warningDependsOn` — the adapter can defer the
          warning until the feature it's advising about is actually on
          (e.g. don't mention DevTools until the user ticks the box). */}
      {!errorMessage && field.warning && warningDependencyMatches(field, values) && (
        <div
          style={{
            marginTop: 4,
            padding: '4px 8px',
            borderRadius: 2,
            color: 'var(--vscode-inputValidation-warningForeground, inherit)',
            background: 'var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.1))',
            border: '1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.4))',
            fontSize: '0.9em',
          }}
        >
          ⚠ {field.warning}
        </div>
      )}
      {action && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            className="secondary"
            disabled={actionBusy}
            onClick={() => onFieldAction?.(action.id)}
            title={actionBusy ? 'See Output → Run Configurations for progress' : undefined}
          >
            {actionBusy ? `⏳ ${action.busyLabel ?? 'Working…'}` : action.label}
          </button>
        </div>
      )}
      {inspectOpen && inspectable && (
        <InspectDialog
          title={field.label}
          value={String(v ?? '')}
          onClose={() => setInspectOpen(false)}
        />
      )}
    </div>
  );
}

// `field.warning` alone would always render. `warningDependsOn` gates it:
// only show the warning when the value at another field matches. Lets the
// Spring Boot adapter defer the DevTools-missing hint until the user
// actually enables Rebuild on save — a silent default-off checkbox has no
// business flashing a yellow banner at load time.
function warningDependencyMatches(field: FormField, values: Record<string, unknown>): boolean {
  const wd = field.warningDependsOn;
  if (!wd) return true;
  const dep = getPath(values, wd.key);
  const equals = wd.equals;
  if (Array.isArray(equals)) return equals.includes(dep as string);
  return dep === equals;
}

interface RenderHandlers {
  onPickFolder?: () => void;
  focus: () => void;
  blur: () => void;
  pathWarning?: { reason: string; suggestion?: string } | null;
  onValidatePath?: (fieldKey: string, buildTool: 'maven' | 'gradle' | 'either', path: string) => void;
}

function renderInput(field: FormField, v: any, set: (x: any) => void, h: RenderHandlers) {
  switch (field.kind) {
    case 'text':
      return (
        <input
          value={v ?? ''}
          placeholder={field.placeholder ?? ''}
          onChange={e => set(e.target.value)}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'textarea':
      return (
        <textarea
          value={v ?? ''}
          placeholder={field.placeholder ?? ''}
          rows={field.rows ?? 3}
          onChange={e => set(e.target.value)}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={v ?? ''}
          onChange={e => set(e.target.value === '' ? undefined : Number(e.target.value))}
          min={field.min}
          max={field.max}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'select':
      return (
        <select value={v ?? ''} onChange={e => set(e.target.value)} onFocus={h.focus} onBlur={h.blur}>
          {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'selectOrCustom':
      return (
        <SelectOrCustom
          value={(v as string) ?? ''}
          options={field.options}
          placeholder={field.placeholder}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'csvChecklist':
      return (
        <CsvChecklist
          value={(v as string) ?? ''}
          options={field.options}
          placeholder={field.placeholder}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'boolean':
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={Boolean(v)}
            onChange={e => set(e.target.checked)}
            onFocus={h.focus}
            onBlur={h.blur}
            style={{ width: 'auto' }}
          />
          <span style={{ fontSize: 12 }}>Enabled</span>
        </label>
      );
    case 'kv':
      return (
        <KvEditor
          value={(v as Record<string, string>) ?? {}}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'folderPath': {
      const validate = field.validateBuildPath;
      return (
        <FolderPathInput
          value={v ?? ''}
          onChange={set}
          onPick={() => h.onPickFolder?.()}
          onFocus={h.focus}
          onBlur={() => {
            h.blur();
            if (validate && h.onValidatePath) {
              h.onValidatePath(field.key, validate, (v as string) ?? '');
            }
          }}
          warning={h.pathWarning}
          onApplySuggestion={(path) => set(path)}
        />
      );
    }
    case 'info':
      return <InfoPanel content={field.content} />;
    case 'dependencyList':
      return (
        <DependencyList
          value={(v as Array<{ ref: string; delaySeconds?: number }> | undefined) ?? []}
          options={field.options}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
  }
}

function InfoPanel({ content }: { content: import('../../../src/shared/formSchema').InfoContent }) {
  // VS Code palette vars: we pick colors that adapt to light/dark themes
  // automatically. Banner backgrounds lean on inputValidation so they match
  // the existing error-state styling when in warning mode.
  const bannerStyle = (kind: 'muted' | 'running' | 'stopped' | 'warning'): CSSProperties => {
    if (kind === 'warning') {
      return {
        background: 'var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.1))',
        border: '1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.4))',
        color: 'var(--vscode-inputValidation-warningForeground, inherit)',
      };
    }
    if (kind === 'running') {
      return {
        background: 'var(--vscode-notificationCenterHeader-background, rgba(0,128,0,0.1))',
        border: '1px solid var(--vscode-terminal-ansiGreen, rgba(0,128,0,0.4))',
        color: 'var(--vscode-terminal-ansiGreen, inherit)',
      };
    }
    if (kind === 'stopped') {
      return {
        background: 'var(--vscode-editorWidget-background, rgba(128,128,128,0.1))',
        border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.4))',
      };
    }
    return {
      background: 'var(--vscode-editorWidget-background, rgba(128,128,128,0.05))',
      border: '1px dashed var(--vscode-panel-border, rgba(128,128,128,0.3))',
      opacity: 0.85,
    };
  };
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 3,
        fontSize: '0.92em',
        ...(content.banner ? bannerStyle(content.banner.kind) : {
          background: 'var(--vscode-editorWidget-background, transparent)',
          border: '1px solid var(--vscode-panel-border, transparent)',
        }),
      }}
    >
      {content.banner && (
        <div style={{ marginBottom: content.rows || content.lists ? 8 : 0 }}>{content.banner.text}</div>
      )}
      {content.rows && content.rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2 }}>
          {content.rows.map((r, i) => [
            <div key={`k${i}`} style={{ opacity: 0.7 }}>{r.label}</div>,
            <div key={`v${i}`} style={{ wordBreak: 'break-all' }}>{r.value}</div>,
          ])}
        </div>
      )}
      {content.lists?.map((l, i) => (
        <div key={`l${i}`} style={{ marginTop: 8 }}>
          <div style={{ opacity: 0.7, marginBottom: 2 }}>{l.label}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {l.items.map((item, j) => (
              <li key={j} style={{ wordBreak: 'break-all' }}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
