import type { FormField } from '../../../src/shared/formSchema';
import { getPath, setPath } from '../state';
import { KvEditor } from './KvEditor';
import { FolderPathInput } from './FolderPathInput';

interface Props {
  field: FormField;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onPickFolder?: () => void;
  onFocusField?: (key: string | null) => void;
}

export function Field({ field, values, onChange, onPickFolder, onFocusField }: Props) {
  const v = getPath(values, field.key);
  const set = (next: unknown) => onChange(setPath(values, field.key, next));
  const focus = () => onFocusField?.(field.key);
  const blur = () => onFocusField?.(null);

  return (
    <div>
      <label>{field.label}{'required' in field && field.required ? ' *' : ''}</label>
      {renderInput(field, v, set, { onPickFolder, focus, blur })}
    </div>
  );
}

interface RenderHandlers {
  onPickFolder?: () => void;
  focus: () => void;
  blur: () => void;
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
    case 'kv':
      return (
        <KvEditor
          value={(v as Record<string, string>) ?? {}}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
    case 'folderPath':
      return (
        <FolderPathInput
          value={v ?? ''}
          onChange={set}
          onPick={() => h.onPickFolder?.()}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
  }
}
