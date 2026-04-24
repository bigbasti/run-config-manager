import { useState } from 'react';
import type { FormField } from '../../../src/shared/formSchema';
import { getPath, setPath } from '../state';
import { KvEditor } from './KvEditor';
import { FolderPathInput } from './FolderPathInput';
import { SelectOrCustom } from './SelectOrCustom';
import { CsvChecklist } from './CsvChecklist';
import { InspectDialog } from './InspectDialog';

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
}

export function Field({ field, values, onChange, onPickFolder, onFocusField, onFieldAction, busyActionId, pending, pathWarnings, onValidatePath }: Props) {
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

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{field.label}{'required' in field && field.required ? ' *' : ''}</span>
        {isPending && <span className="field-spinner" title="Detecting…">⟳</span>}
      </label>
      <div className="field-row">
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
  }
}
