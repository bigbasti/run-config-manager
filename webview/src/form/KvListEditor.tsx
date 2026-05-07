import { useEffect, useRef, useState } from 'react';

// Same row shape as HttpKvRow in src/shared/types.ts. Kept inline here
// so the webview doesn't pull the extension's types module just for one
// shape (vite would cope, but keeping the boundary clean is cheap).
export interface KvListRow {
  key: string;
  value: string;
  enabled: boolean;
}

interface Props {
  value: KvListRow[];
  onChange: (next: KvListRow[]) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
}

// Like KvEditor, but the underlying value is an ordered list with per-row
// enabled flags — needed for HTTP request headers / query params / form
// fields where Postman/Bruno's UX is "keep this row, just don't send it
// this time". Local state holds rows with stable ids so React keys don't
// remount inputs when the user clears a key field; cf. KvEditor's same
// trick. Empty rows aren't filtered out (rows are explicitly the user's
// list — we shouldn't drop them mid-edit), only published unchanged.

interface InternalRow extends KvListRow {
  id: number;
}

let nextId = 1;
const freshId = () => nextId++;

function rowsFromList(list: KvListRow[]): InternalRow[] {
  return list.map(r => ({ id: freshId(), key: r.key, value: r.value, enabled: r.enabled !== false }));
}

function listFromRows(rows: InternalRow[]): KvListRow[] {
  return rows.map(r => ({ key: r.key, value: r.value, enabled: r.enabled }));
}

function sameList(a: KvListRow[], b: KvListRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].value !== b[i].value || a[i].enabled !== b[i].enabled) return false;
  }
  return true;
}

export function KvListEditor({ value, onChange, onFocus, onBlur, placeholder }: Props) {
  const [rows, setRows] = useState<InternalRow[]>(() => rowsFromList(value));
  const lastSynced = useRef<KvListRow[]>(value);

  // Re-seed when the value prop changes from outside (init / config
  // switch / configPatch) so rows from the previous edit don't bleed
  // into the next. Mirrors the KvEditor trick.
  useEffect(() => {
    if (!sameList(value, lastSynced.current)) {
      lastSynced.current = value;
      setRows(rowsFromList(value));
    }
  }, [value]);

  // Publish upward whenever the local rows produce a different list
  // shape than what we last emitted.
  useEffect(() => {
    const projected = listFromRows(rows);
    if (!sameList(projected, lastSynced.current)) {
      lastSynced.current = projected;
      onChange(projected);
    }
  }, [rows, onChange]);

  const updateKey = (id: number, key: string) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, key } : r));
  const updateValue = (id: number, val: string) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, value: val } : r));
  const toggleEnabled = (id: number, enabled: boolean) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, enabled } : r));
  const remove = (id: number) =>
    setRows(prev => prev.filter(r => r.id !== id));
  const add = () =>
    setRows(prev => [...prev, { id: freshId(), key: '', value: '', enabled: true }]);

  return (
    <div>
      {rows.map(row => (
        <div
          key={row.id}
          className="kv-row"
          // Override .kv-row's 3-col grid; we want [checkbox][key][value][trash].
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr 1fr auto',
            gap: 6,
            marginBottom: 4,
            alignItems: 'center',
          }}
        >
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={e => toggleEnabled(row.id, e.target.checked)}
            title={row.enabled ? 'Disable this row (kept but not sent)' : 'Enable this row'}
          />
          <input
            value={row.key}
            onChange={e => updateKey(row.id, e.target.value)}
            placeholder={placeholder ?? 'KEY'}
            onFocus={onFocus}
            onBlur={onBlur}
            // Visually mute disabled rows. They're not ignored on the
            // wire — that's what the checkbox above is for; this just
            // makes the row state obvious at a glance.
            style={row.enabled ? undefined : { opacity: 0.5 }}
          />
          <input
            value={row.value}
            onChange={e => updateValue(row.id, e.target.value)}
            placeholder="value"
            onFocus={onFocus}
            onBlur={onBlur}
            style={row.enabled ? undefined : { opacity: 0.5 }}
          />
          <button type="button" className="secondary" onClick={() => remove(row.id)}>−</button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={add}>+ Add row</button>
    </div>
  );
}
