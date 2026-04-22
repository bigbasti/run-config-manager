import { useMemo } from 'react';

interface Props {
  value: string;                                   // comma-separated
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  onChange: (next: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// A comma-separated string edited via checkboxes (for known options) plus a
// free-form text input (for custom values not in the list). Both sources
// merge into one `value` string.
export function CsvChecklist({ value, options, placeholder, onChange, onFocus, onBlur }: Props) {
  const { selectedSet, customText } = useMemo(() => {
    const parts = value.split(',').map(s => s.trim()).filter(Boolean);
    const known = new Set(options.map(o => o.value));
    const sel = new Set<string>();
    const custom: string[] = [];
    for (const p of parts) {
      if (known.has(p)) sel.add(p);
      else custom.push(p);
    }
    return { selectedSet: sel, customText: custom.join(', ') };
  }, [value, options]);

  const writeBack = (sel: Set<string>, custom: string) => {
    const ordered: string[] = [];
    for (const o of options) if (sel.has(o.value)) ordered.push(o.value);
    for (const c of custom.split(',').map(s => s.trim()).filter(Boolean)) ordered.push(c);
    // Preserve order: known options first (in the order they appear), then custom.
    onChange(ordered.join(','));
  };

  const toggle = (val: string) => {
    const next = new Set(selectedSet);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    writeBack(next, customText);
  };

  return (
    <div onFocus={onFocus} onBlur={onBlur}>
      {options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: 6 }}>
          {options.map(o => {
            const id = `csv-${o.value}`;
            return (
              <label key={o.value} htmlFor={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={selectedSet.has(o.value)}
                  onChange={() => toggle(o.value)}
                  style={{ width: 'auto' }}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      )}
      <input
        value={customText}
        placeholder={placeholder ?? (options.length > 0 ? 'Custom profiles (comma-separated)' : '')}
        onChange={e => writeBack(selectedSet, e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </div>
  );
}
