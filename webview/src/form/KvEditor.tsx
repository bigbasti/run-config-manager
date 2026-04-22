import { useCallback } from 'react';

interface Props {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function KvEditor({ value, onChange }: Props) {
  const rows = Object.entries(value);

  const update = useCallback((idx: number, k: string, v: string) => {
    const next = rows.map((r, i) => (i === idx ? [k, v] as [string, string] : r));
    onChange(Object.fromEntries(next.filter(([kk]) => kk.length > 0)));
  }, [rows, onChange]);

  const remove = useCallback((idx: number) => {
    onChange(Object.fromEntries(rows.filter((_, i) => i !== idx)));
  }, [rows, onChange]);

  const add = useCallback(() => {
    const nextKey = `KEY_${rows.length + 1}`;
    onChange({ ...value, [nextKey]: '' });
  }, [rows, value, onChange]);

  return (
    <div>
      {rows.map(([k, v], idx) => (
        <div key={idx} className="kv-row">
          <input value={k} onChange={e => update(idx, e.target.value, v)} placeholder="KEY" />
          <input value={v} onChange={e => update(idx, k, e.target.value)} placeholder="value" />
          <button type="button" className="secondary" onClick={() => remove(idx)}>−</button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={add}>+ Add variable</button>
    </div>
  );
}
