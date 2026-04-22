import type { FormField } from '../../../src/shared/formSchema';
import { getPath, setPath } from '../state';
import { KvEditor } from './KvEditor';
import { FolderPathInput } from './FolderPathInput';

interface Props {
  field: FormField;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onPickFolder?: () => void;
}

export function Field({ field, values, onChange, onPickFolder }: Props) {
  const v = getPath(values, field.key);
  const set = (next: unknown) => onChange(setPath(values, field.key, next));

  return (
    <div>
      <label>{field.label}{'required' in field && field.required ? ' *' : ''}</label>
      {renderInput(field, v, set, onPickFolder)}
    </div>
  );
}

function renderInput(field: FormField, v: any, set: (x: any) => void, onPickFolder?: () => void) {
  switch (field.kind) {
    case 'text':
      return <input value={v ?? ''} placeholder={field.placeholder ?? ''} onChange={e => set(e.target.value)} />;
    case 'number':
      return <input type="number" value={v ?? ''} onChange={e => set(e.target.value === '' ? undefined : Number(e.target.value))} min={field.min} max={field.max} />;
    case 'select':
      return (
        <select value={v ?? ''} onChange={e => set(e.target.value)}>
          {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'kv':
      return <KvEditor value={(v as Record<string, string>) ?? {}} onChange={set} />;
    case 'folderPath':
      return <FolderPathInput value={v ?? ''} onChange={set} onPick={() => onPickFolder?.()} />;
  }
}
