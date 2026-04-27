import { useEffect, useMemo, useRef, useState } from 'react';

interface Entry {
  ref: string;
  delaySeconds?: number;
}

interface Option {
  value: string;
  label: string;
  group?: string;
  description?: string;
}

interface Props {
  value: Entry[];
  options: Option[];
  onChange: (next: Entry[]) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// A list of {ref, delaySeconds} picked from an options pool. Used exclusively
// for the "Depends on" field on every adapter. Entries stay in user order
// since the orchestrator walks them in sequence — the up/down buttons let
// the user express that ordering.
export function DependencyList({ value, options, onChange, onFocus, onBlur }: Props) {
  const [candidateFilter, setCandidateFilter] = useState('');
  // The dropdown can open either by typing in the filter input OR by
  // clicking the caret. Tracked separately from the filter so the user can
  // browse the full list with an empty search string.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickedRefs = useMemo(() => new Set(value.map(v => v.ref)), [value]);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Close the picker on outside click so it behaves like a native select.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  // Group options by their `group` field — makes "Run configs (this folder)"
  // / "Launch configs" / "Tasks" distinguishable when the user opens the
  // picker. Filters by the label / description substring the user typed.
  const grouped = useMemo(() => {
    const filter = candidateFilter.toLowerCase().trim();
    const match = (o: Option) =>
      !filter ||
      o.label.toLowerCase().includes(filter) ||
      (o.description ?? '').toLowerCase().includes(filter);
    const out = new Map<string, Option[]>();
    for (const o of options) {
      if (pickedRefs.has(o.value)) continue;
      if (!match(o)) continue;
      const g = o.group ?? '';
      const arr = out.get(g) ?? [];
      arr.push(o);
      out.set(g, arr);
    }
    return out;
  }, [options, candidateFilter, pickedRefs]);

  const labelFor = (ref: string) =>
    options.find(o => o.value === ref)?.label ?? ref;
  const groupFor = (ref: string) =>
    options.find(o => o.value === ref)?.group ?? '';

  const addEntry = (ref: string) => {
    onChange([...value, { ref }]);
    setCandidateFilter('');
    setPickerOpen(false);
  };
  const removeEntry = (i: number) => {
    const next = value.slice();
    next.splice(i, 1);
    onChange(next);
  };
  const moveEntry = (i: number, direction: -1 | 1) => {
    const target = i + direction;
    if (target < 0 || target >= value.length) return;
    const next = value.slice();
    [next[i], next[target]] = [next[target], next[i]];
    onChange(next);
  };
  const setDelay = (i: number, seconds: number) => {
    const next = value.slice();
    const clamped = Math.min(600, Math.max(0, Math.floor(seconds)));
    next[i] = { ...next[i], delaySeconds: clamped > 0 ? clamped : undefined };
    onChange(next);
  };

  return (
    <div>
      {value.length === 0 && (
        <div style={{ fontStyle: 'italic', opacity: 0.7, marginBottom: 6 }}>
          No dependencies.
        </div>
      )}
      {value.map((entry, i) => (
        <div
          key={`${entry.ref}-${i}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 80px auto auto auto',
            gap: 6,
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <div
            title={entry.ref}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            <span>{labelFor(entry.ref)}</span>
            {groupFor(entry.ref) && (
              <span style={{ opacity: 0.6, marginLeft: 6, fontSize: '0.9em' }}>
                ({groupFor(entry.ref)})
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <input
              type="number"
              min={0}
              max={600}
              value={entry.delaySeconds ?? 0}
              onChange={e => setDelay(i, Number(e.target.value) || 0)}
              onFocus={onFocus}
              onBlur={onBlur}
              title="Delay (seconds) after this dependency reaches running state"
              style={{ width: 60 }}
            />
            <span style={{ fontSize: '0.85em', opacity: 0.7 }}>s</span>
          </div>
          <button
            type="button"
            className="secondary icon-button"
            disabled={i === 0}
            onClick={() => moveEntry(i, -1)}
            title="Move up"
          >↑</button>
          <button
            type="button"
            className="secondary icon-button"
            disabled={i === value.length - 1}
            onClick={() => moveEntry(i, 1)}
            title="Move down"
          >↓</button>
          <button
            type="button"
            className="secondary icon-button"
            onClick={() => removeEntry(i)}
            title="Remove"
          >−</button>
        </div>
      ))}

      <div ref={pickerRef} style={{ marginTop: 8, position: 'relative' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={candidateFilter}
            placeholder="Search for config / launch / task… (or click the arrow)"
            onChange={e => { setCandidateFilter(e.target.value); if (!pickerOpen) setPickerOpen(true); }}
            onFocus={() => { setPickerOpen(true); onFocus?.(); }}
            onBlur={onBlur}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            className="secondary icon-button"
            onClick={() => setPickerOpen(o => !o)}
            title={pickerOpen ? 'Close picker' : 'Browse available dependencies'}
            aria-label="Toggle dependency picker"
            aria-expanded={pickerOpen}
          >
            {pickerOpen ? '▲' : '▼'}
          </button>
        </div>

        {pickerOpen && grouped.size === 0 && (
          <div style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 4 }}>
            {candidateFilter
              ? 'No matches. Already-picked items are hidden; clear the filter to see the rest.'
              : 'Nothing to pick — no run configs, launches, or workspace tasks are available in this folder.'}
          </div>
        )}

        {pickerOpen && grouped.size > 0 && (
          <div
            style={{
              marginTop: 4,
              maxHeight: 220,
              overflowY: 'auto',
              border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
              background: 'var(--vscode-dropdown-background, var(--vscode-editorWidget-background, inherit))',
              borderRadius: 3,
            }}
          >
            {[...grouped.entries()].map(([group, opts]) => (
              <div key={group || '(ungrouped)'}>
                {group && (
                  <div
                    style={{
                      padding: '4px 8px',
                      background: 'var(--vscode-editorWidget-background, rgba(128,128,128,0.08))',
                      fontSize: '0.85em',
                      opacity: 0.8,
                      fontWeight: 600,
                    }}
                  >
                    {group}
                  </div>
                )}
                {opts.map(o => (
                  <div
                    key={o.value}
                    onMouseDown={e => { e.preventDefault(); addEntry(o.value); }}
                    style={{
                      padding: '4px 8px',
                      cursor: 'pointer',
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: 6,
                    }}
                    className="dep-candidate"
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.label}
                    </div>
                    {o.description && (
                      <div style={{ opacity: 0.6, fontSize: '0.85em' }}>{o.description}</div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
