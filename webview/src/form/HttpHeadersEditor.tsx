import { useEffect, useRef, useState } from 'react';
import { type KvListRow } from './KvListEditor';
import { COMMON_HEADERS, valueSuggestionsForKey } from './httpHeaderSuggestions';
import { SuggestionDropdown } from './SuggestionDropdown';

interface Props {
  value: KvListRow[];
  onChange: (next: KvListRow[]) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// Internal row shape with a stable numeric id. Same trick as KvListEditor:
// stable ids prevent React from remounting inputs during intermediate states
// (e.g. when the user clears the key field mid-paste).
interface InternalRow extends KvListRow {
  id: number;
}

let nextId = 1;
const freshId = () => nextId++;

function rowsFromList(list: KvListRow[]): InternalRow[] {
  return list.map(r => ({
    id: freshId(),
    key: r.key,
    value: r.value,
    enabled: r.enabled !== false,
  }));
}

function listFromRows(rows: InternalRow[]): KvListRow[] {
  return rows.map(r => ({ key: r.key, value: r.value, enabled: r.enabled }));
}

function sameList(a: KvListRow[], b: KvListRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].key !== b[i].key ||
      a[i].value !== b[i].value ||
      a[i].enabled !== b[i].enabled
    )
      return false;
  }
  return true;
}

// Which dropdown is currently open. Only one at a time.
type OpenDropdown = { rowId: number; which: 'key' | 'value' } | null;

export function HttpHeadersEditor({ value, onChange, onFocus, onBlur }: Props) {
  const [rows, setRows] = useState<InternalRow[]>(() => rowsFromList(value));
  const lastSynced = useRef<KvListRow[]>(value);
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);

  // Re-seed when the value prop changes from outside (init / config switch /
  // configPatch). Mirrors the same pattern in KvListEditor.
  useEffect(() => {
    if (!sameList(value, lastSynced.current)) {
      lastSynced.current = value;
      setRows(rowsFromList(value));
    }
  }, [value]);

  // Publish upward when local rows produce a different list.
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

  const toggleDropdown = (rowId: number, which: 'key' | 'value') => {
    setOpenDropdown(prev =>
      prev?.rowId === rowId && prev.which === which
        ? null
        : { rowId, which },
    );
  };

  const closeDropdown = () => setOpenDropdown(null);

  return (
    <div>
      {rows.map(row => {
        const valueSuggestions = valueSuggestionsForKey(row.key);
        const hasValueSuggestions = valueSuggestions.length > 0;
        const keyDropdownOpen = openDropdown?.rowId === row.id && openDropdown.which === 'key';
        const valueDropdownOpen = openDropdown?.rowId === row.id && openDropdown.which === 'value';

        return (
          <div
            key={row.id}
            style={{
              display: 'grid',
              // [checkbox] [key input] [⚡ key] [value input] [⚡ value] [− trash]
              gridTemplateColumns: 'auto 1fr auto 1fr auto auto',
              gap: 6,
              marginBottom: 4,
              alignItems: 'center',
            }}
          >
            {/* Enable/disable toggle */}
            <input
              type="checkbox"
              checked={row.enabled}
              onChange={e => toggleEnabled(row.id, e.target.checked)}
              title={row.enabled ? 'Disable this row (kept but not sent)' : 'Enable this row'}
            />

            {/* Key input */}
            <input
              value={row.key}
              onChange={e => updateKey(row.id, e.target.value)}
              placeholder="Header name"
              onFocus={onFocus}
              onBlur={onBlur}
              style={row.enabled ? undefined : { opacity: 0.5 }}
            />

            {/* Key lightning button — always shown */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="secondary"
                title="Pick a common header name"
                onClick={() => toggleDropdown(row.id, 'key')}
                style={{ padding: '0 6px' }}
              >
                ⚡
              </button>
              {keyDropdownOpen && (
                <SuggestionDropdown
                  items={COMMON_HEADERS}
                  onSelect={item => updateKey(row.id, item)}
                  onClose={closeDropdown}
                />
              )}
            </div>

            {/* Value input */}
            <input
              value={row.value}
              onChange={e => updateValue(row.id, e.target.value)}
              placeholder="value"
              onFocus={onFocus}
              onBlur={onBlur}
              style={row.enabled ? undefined : { opacity: 0.5 }}
            />

            {/* Value lightning button — only when there are suggestions for this key */}
            <div style={{ position: 'relative' }}>
              {hasValueSuggestions ? (
                <>
                  <button
                    type="button"
                    className="secondary"
                    title={`Pick a common value for ${row.key}`}
                    onClick={() => toggleDropdown(row.id, 'value')}
                    style={{ padding: '0 6px' }}
                  >
                    ⚡
                  </button>
                  {valueDropdownOpen && (
                    <SuggestionDropdown
                      items={valueSuggestions}
                      onSelect={item => updateValue(row.id, item)}
                      onClose={closeDropdown}
                    />
                  )}
                </>
              ) : (
                // Hidden button — same DOM shape as the visible ⚡ button so the
                // grid column width matches exactly across all rows, regardless of
                // what .secondary adds.
                <button
                  type="button"
                  className="secondary"
                  style={{ padding: '0 6px', visibility: 'hidden' }}
                  aria-hidden="true"
                  tabIndex={-1}
                  disabled
                >
                  ⚡
                </button>
              )}
            </div>

            {/* Remove row */}
            <button
              type="button"
              className="secondary"
              onClick={() => remove(row.id)}
            >
              −
            </button>
          </div>
        );
      })}
      <button type="button" className="secondary" onClick={add}>
        + Add row
      </button>
    </div>
  );
}
