import { useEffect, useRef, useState } from 'react';

interface Props {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// Internal row shape. We track a stable id per row (the React `key`) so
// React doesn't remount inputs when the user clears a key field — the old
// implementation used the array index, which shifted on every re-render
// caused by the `.filter(empty-keys)` step and triggered a cascade:
//
//   1. User clicks "Add variable" (row seeded with KEY_2).
//   2. User Ctrl+A in the key field, then Ctrl+V (paste).
//   3. Paste fires onChange('') first, then onChange(pastedText).
//   4. The empty-string intermediate made filter() drop the row.
//   5. Parent re-rendered with one fewer row; React reused key=0 for the
//      surviving row, remounting its inputs on the wrong data.
//   6. The follow-up onChange hit the now-missing row index, corrupting
//      everything.
//
// Solution: keep rows in local state with stable ids, only push to the
// parent as a Record when keys look valid. Duplicate keys inside the
// editor are allowed locally (the last one wins in the emitted Record)
// so the user can finish typing before we collapse.
interface Row {
  id: number;
  k: string;
  v: string;
}

let nextId = 1;
const freshId = () => nextId++;

function rowsFromRecord(r: Record<string, string>): Row[] {
  return Object.entries(r).map(([k, v]) => ({ id: freshId(), k, v }));
}

function recordFromRows(rows: Row[]): Record<string, string> {
  // Drop rows with empty keys when publishing upward. Later duplicates
  // win over earlier ones — matches how `Object.fromEntries` behaves.
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.k.length === 0) continue;
    out[r.k] = r.v;
  }
  return out;
}

// Cheap structural equality — avoids an upward onChange when the emitted
// record hasn't changed (e.g. user typed in an empty-key row).
function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export function KvEditor({ value, onChange, onFocus, onBlur }: Props) {
  // Seed rows from the initial value. We deliberately don't re-sync when
  // `value` changes later — the user is editing in this component, so its
  // state is the source of truth. If the form reloads (init message), the
  // parent reconstructs the component, which resets local state.
  const [rows, setRows] = useState<Row[]>(() => rowsFromRecord(value));

  // When rows change, emit upward — but only when the projected record
  // differs, so transient empty-key states don't churn the parent.
  const lastEmitted = useRef(value);
  useEffect(() => {
    const projected = recordFromRows(rows);
    if (!sameRecord(projected, lastEmitted.current)) {
      lastEmitted.current = projected;
      onChange(projected);
    }
  }, [rows, onChange]);

  const updateKey = (id: number, k: string) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, k } : r));
  const updateValue = (id: number, v: string) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, v } : r));
  const remove = (id: number) =>
    setRows(prev => prev.filter(r => r.id !== id));
  const add = () =>
    setRows(prev => [...prev, { id: freshId(), k: '', v: '' }]);

  return (
    <div>
      {rows.map(row => (
        <div key={row.id} className="kv-row">
          <input
            value={row.k}
            onChange={e => updateKey(row.id, e.target.value)}
            placeholder="KEY"
            onFocus={onFocus}
            onBlur={onBlur}
          />
          <input
            value={row.v}
            onChange={e => updateValue(row.id, e.target.value)}
            placeholder="value"
            onFocus={onFocus}
            onBlur={onBlur}
          />
          <button type="button" className="secondary" onClick={() => remove(row.id)}>−</button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={add}>+ Add variable</button>
    </div>
  );
}
