import { useState } from 'react';

interface Props {
  value: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  onChange: (next: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// A dropdown with a trailing "Custom…" option. When the user picks Custom the
// input swaps to a text field pre-filled with the current value; when they
// pick an option from the dropdown the text input is hidden again.
export function SelectOrCustom({ value, options, placeholder, onChange, onFocus, onBlur }: Props) {
  // We're in "custom" mode if the stored value isn't one of the options.
  const storedIsOption = options.some(o => o.value === value);
  const [customMode, setCustomMode] = useState(!storedIsOption && value !== '');

  if (customMode) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={value}
          placeholder={placeholder ?? 'Enter custom value'}
          onChange={e => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          style={{ flex: 1 }}
        />
        <button type="button" className="secondary" onClick={() => setCustomMode(false)}>Use list</button>
      </div>
    );
  }

  return (
    <select
      value={storedIsOption ? value : ''}
      onChange={e => {
        if (e.target.value === '__custom__') {
          setCustomMode(true);
          // Keep current value so the text input starts populated.
        } else {
          onChange(e.target.value);
        }
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {!storedIsOption && <option value="">(select)</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      <option value="__custom__">Custom…</option>
    </select>
  );
}
