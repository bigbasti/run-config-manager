import { useEffect, useRef } from 'react';

interface Props {
  items: string[];
  onSelect: (item: string) => void;
  onClose: () => void;
}

// Generic suggestion dropdown. Renders absolutely positioned relative to
// its nearest `position: relative` parent (the caller wraps the trigger
// button in such a container). Closes when the user clicks outside or
// picks an item.
export function SuggestionDropdown({ items, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside mousedown. Using mousedown (not click) so the
  // dismissal fires before a potential focusout on the input, which keeps
  // the interaction order consistent.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 100,
        minWidth: '100%',
        background: 'var(--vscode-dropdown-background)',
        color: 'var(--vscode-dropdown-foreground)',
        border: '1px solid var(--vscode-dropdown-border)',
        borderRadius: 4,
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        // Nudge down 2px so the dropdown doesn't overlap the button border
        marginTop: 2,
      }}
    >
      {items.map((item, index) => (
        <button
          key={`${index}-${item}`}
          type="button"
          onMouseDown={e => {
            // Prevent the document mousedown handler from firing first
            // (which would close the dropdown before onSelect runs).
            e.stopPropagation();
            onSelect(item);
            onClose();
          }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '4px 10px',
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.95em',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'var(--vscode-list-hoverBackground)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
