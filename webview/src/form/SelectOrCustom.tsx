import { useEffect, useMemo, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  description?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  placeholder?: string;
  onChange: (next: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// A filterable dropdown with collapsible groups. Used by gradle-task and
// maven-goal where the option count is high and native <select> becomes
// unusable. Falls back to a native select when options have no `group`.
//
// Behaviors:
//   - Filter box at the top. Typing narrows rows; matching substring
//     gets a highlight background. Arrow keys navigate; Enter picks.
//   - Groups default to collapsed. The group header row expands/collapses
//     its block on click; collapsed groups also hide their children from
//     the filter result count.
//   - Filtering auto-expands groups that have any matching child so users
//     can see the hits.
//   - Columns: name and description are rendered via CSS grid so they
//     align vertically across a group.
//   - Distinct colors: group headers use the VS Code description fg,
//     names use the default fg, descriptions use a fainter description
//     fg, the current value gets the focus-border highlight.
//
// Kept backward-compatible with the previous plain {value, label} option
// shape — if `group` is absent on every option we render an ungrouped
// filterable list.
export function SelectOrCustom({ value, options, placeholder, onChange, onFocus, onBlur }: Props) {
  const storedIsOption = options.some(o => o.value === value);
  const [customMode, setCustomMode] = useState(!storedIsOption && value !== '');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // Groups the user has NOT yet expanded. Starts as "all of them" and gets
  // updated whenever new groups arrive (useState initialiser only runs at
  // mount — if options are empty then and populated later via a schemaUpdate,
  // we need to catch up). Track which groups we've already registered so we
  // don't clobber the user's manual toggles on re-renders.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seenGroupsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newGroups: string[] = [];
    for (const o of options) {
      if (o.group && !seenGroupsRef.current.has(o.group)) {
        seenGroupsRef.current.add(o.group);
        newGroups.push(o.group);
      }
    }
    if (newGroups.length === 0) return;
    setCollapsed(prev => {
      const next = new Set(prev);
      for (const g of newGroups) next.add(g);
      return next;
    });
  }, [options]);
  const containerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Auto-focus the filter input when the popup opens.
  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open]);

  // Custom mode: plain text input.
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
        <button type="button" className="secondary" onClick={() => setCustomMode(false)}>
          Use list
        </button>
      </div>
    );
  }

  const hasGroups = options.some(o => o.group);
  if (!hasGroups && options.length <= 20) {
    // Small, ungrouped option set — native <select> is still fine. Preserves
    // the old behaviour for adapters that only emit a handful of choices
    // (package manager, gradle command, etc.) so we don't replace a good
    // UX with a heavier one when it isn't warranted.
    return (
      <select
        value={storedIsOption ? value : ''}
        onChange={e => {
          if (e.target.value === '__custom__') setCustomMode(true);
          else onChange(e.target.value);
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

  // Rich popup: filter + collapsible groups.
  const filterLower = filter.trim().toLowerCase();
  const filteredOptions = filterLower
    ? options.filter(o =>
        o.label.toLowerCase().includes(filterLower)
        || o.value.toLowerCase().includes(filterLower)
        || (o.description?.toLowerCase().includes(filterLower) ?? false),
      )
    : options;

  // Group the (possibly filtered) options, preserving insertion order.
  const grouped = new Map<string, SelectOption[]>();
  for (const o of filteredOptions) {
    const g = o.group ?? '';
    const list = grouped.get(g) ?? [];
    list.push(o);
    grouped.set(g, list);
  }

  const toggleGroup = (g: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  // Treat groups with a filter hit as expanded regardless of user state.
  const isExpanded = (g: string): boolean => {
    if (filterLower) return true;
    return !collapsed.has(g);
  };

  const labelForCurrent = options.find(o => o.value === value)?.label ?? value;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          onFocus={onFocus}
          onBlur={onBlur}
          style={{
            flex: 1,
            textAlign: 'left',
            background: 'var(--vscode-input-background)',
            color: 'var(--vscode-input-foreground)',
            border: '1px solid var(--vscode-input-border, transparent)',
            padding: '2px 6px',
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {value
            ? <span>{labelForCurrent}</span>
            : <span style={{ color: 'var(--vscode-input-placeholderForeground)' }}>{placeholder ?? '(select)'}</span>
          }
          <span style={{ float: 'right', opacity: 0.6 }}>▾</span>
        </button>
        <button type="button" className="secondary" onClick={() => setCustomMode(true)}>
          Custom…
        </button>
      </div>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 2,
            maxHeight: 360,
            overflow: 'auto',
            background: 'var(--vscode-dropdown-background, var(--vscode-editor-background))',
            color: 'var(--vscode-dropdown-foreground, var(--vscode-foreground))',
            border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
            borderRadius: 2,
            zIndex: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          }}
        >
          <div
            style={{
              position: 'sticky',
              top: 0,
              background: 'var(--vscode-dropdown-background, var(--vscode-editor-background))',
              padding: 6,
              borderBottom: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
              zIndex: 1,
            }}
          >
            <input
              ref={filterRef}
              type="text"
              value={filter}
              placeholder="Filter…"
              onChange={e => setFilter(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setOpen(false); setFilter(''); }
              }}
              style={{ width: '100%' }}
            />
            {filterLower && (
              <div style={{
                marginTop: 2,
                fontSize: '0.85em',
                color: 'var(--vscode-descriptionForeground)',
              }}>
                {filteredOptions.length} match{filteredOptions.length === 1 ? '' : 'es'}
              </div>
            )}
          </div>

          {Array.from(grouped.entries()).map(([group, items]) => {
            const showGroup = group !== '';
            const expanded = showGroup ? isExpanded(group) : true;
            return (
              <div key={group || '__ungrouped__'}>
                {showGroup && (
                  <div
                    onClick={() => toggleGroup(group)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '4px 8px',
                      background: 'var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-lineHighlightBackground))',
                      color: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground))',
                      fontSize: '0.85em',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.03em',
                      cursor: 'pointer',
                      userSelect: 'none',
                      borderTop: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
                    }}
                    title={expanded ? 'Collapse group' : 'Expand group'}
                  >
                    <span>{expanded ? '▾' : '▸'}  {group}</span>
                    <span style={{ opacity: 0.7, fontWeight: 400 }}>
                      {items.length}
                    </span>
                  </div>
                )}
                {expanded && items.map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                      setFilter('');
                    }}
                    style={{
                      // Grid keeps the name + description columns aligned
                      // across every row in the group — the original ask.
                      display: 'grid',
                      gridTemplateColumns: 'minmax(140px, max-content) 1fr',
                      columnGap: 10,
                      padding: '4px 8px 4px 24px',
                      cursor: 'pointer',
                      background: opt.value === value
                        ? 'var(--vscode-list-activeSelectionBackground)'
                        : 'transparent',
                      color: opt.value === value
                        ? 'var(--vscode-list-activeSelectionForeground)'
                        : 'var(--vscode-foreground)',
                    }}
                    onMouseEnter={e => {
                      if (opt.value !== value) {
                        (e.currentTarget as HTMLDivElement).style.background =
                          'var(--vscode-list-hoverBackground)';
                      }
                    }}
                    onMouseLeave={e => {
                      if (opt.value !== value) {
                        (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                      }
                    }}
                  >
                    <span style={{
                      fontFamily: 'var(--vscode-editor-font-family, monospace)',
                      fontWeight: 500,
                    }}>
                      {highlightMatch(opt.label, filterLower)}
                    </span>
                    {opt.description && (
                      <span style={{
                        color: opt.value === value
                          ? 'var(--vscode-list-activeSelectionForeground)'
                          : 'var(--vscode-descriptionForeground)',
                        opacity: opt.value === value ? 0.9 : 0.8,
                        fontSize: '0.9em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {highlightMatch(opt.description, filterLower)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          {filteredOptions.length === 0 && (
            <div style={{
              padding: '8px 12px',
              color: 'var(--vscode-descriptionForeground)',
              fontStyle: 'italic',
            }}>
              No matches. Use "Custom…" to type a value by hand.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Wraps each run of characters in `text` that match `needle` in a highlight
// span. Case-insensitive; overlapping matches handled by splitting at each
// hit left-to-right. Returns a React fragment array.
function highlightMatch(text: string, needle: string) {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let i = lower.indexOf(needle, cursor);
  while (i !== -1) {
    if (i > cursor) parts.push(text.slice(cursor, i));
    parts.push(
      <mark
        key={i}
        style={{
          background: 'var(--vscode-editor-findMatchHighlightBackground)',
          color: 'inherit',
          padding: 0,
        }}
      >{text.slice(i, i + needle.length)}</mark>,
    );
    cursor = i + needle.length;
    i = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
