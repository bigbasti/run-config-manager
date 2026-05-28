# HTTP Headers Smart Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightning-button (⚡) suggestion menus to the HTTP request headers editor — one for picking a common header key, one for picking a common value for the selected key — so users can fill headers faster without memorizing names.

**Architecture:** A new `httpHeaderSuggestions.ts` provides static catalog data; a new `SuggestionDropdown.tsx` renders the dropdown; a new `HttpHeadersEditor.tsx` replaces `KvListEditor` for the headers field. Plumbing changes add `'httpHeaders'` as a `FormField` kind and wire it through `Field.tsx` and `HttpRequestAdapter.ts`. `KvListEditor.tsx` is not touched.

**Tech Stack:** React (webview), TypeScript, VS Code CSS variables for theming.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `webview/src/form/httpHeaderSuggestions.ts` | Create | Static catalog: 10 common headers + per-header value presets + lookup helper |
| `webview/src/form/SuggestionDropdown.tsx` | Create | Generic absolute-positioned dropdown, auto-closes on outside click or item pick |
| `webview/src/form/HttpHeadersEditor.tsx` | Create | KvList editor with ⚡ buttons per row, wraps the two components above |
| `src/shared/formSchema.ts` | Modify | Add `'httpHeaders'` union member (identical shape to `kvList`) |
| `webview/src/form/Field.tsx` | Modify | Add `case 'httpHeaders'` dispatching to `HttpHeadersEditor` |
| `src/adapters/http-request/HttpRequestAdapter.ts` | Modify | Change headers field `kind` from `'kvList'` to `'httpHeaders'` |
| `test/httpHeaderSuggestions.test.ts` | Create | Unit tests for `valueSuggestionsForKey` and `COMMON_HEADERS` |

---

## Task 1: Create the suggestion catalog

**Files:**
- Create: `webview/src/form/httpHeaderSuggestions.ts`
- Create: `test/httpHeaderSuggestions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/httpHeaderSuggestions.test.ts`:

```ts
import { COMMON_HEADERS, HEADER_VALUE_SUGGESTIONS, valueSuggestionsForKey } from '../webview/src/form/httpHeaderSuggestions';

describe('COMMON_HEADERS', () => {
  it('has exactly 10 entries', () => {
    expect(COMMON_HEADERS).toHaveLength(10);
  });

  it('includes the most important headers', () => {
    expect(COMMON_HEADERS).toContain('Content-Type');
    expect(COMMON_HEADERS).toContain('Authorization');
    expect(COMMON_HEADERS).toContain('Accept');
  });
});

describe('valueSuggestionsForKey', () => {
  it('returns values for Content-Type', () => {
    const vals = valueSuggestionsForKey('Content-Type');
    expect(vals).toContain('application/json');
    expect(vals.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(valueSuggestionsForKey('content-type')).toEqual(valueSuggestionsForKey('Content-Type'));
    expect(valueSuggestionsForKey('CONTENT-TYPE')).toEqual(valueSuggestionsForKey('Content-Type'));
  });

  it('returns empty array for unknown keys', () => {
    expect(valueSuggestionsForKey('X-Custom-Header')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(valueSuggestionsForKey('')).toEqual([]);
  });

  it('returns empty array for whitespace-only', () => {
    expect(valueSuggestionsForKey('   ')).toEqual([]);
  });

  it('returns Authorization prefixes with trailing space', () => {
    const vals = valueSuggestionsForKey('Authorization');
    expect(vals).toContain('Bearer ');
    expect(vals).toContain('Basic ');
  });

  it('returns values for Accept', () => {
    expect(valueSuggestionsForKey('Accept')).toContain('application/json');
  });

  it('returns values for Cache-Control', () => {
    expect(valueSuggestionsForKey('Cache-Control')).toContain('no-cache');
  });

  it('returns empty for User-Agent (no presets)', () => {
    expect(valueSuggestionsForKey('User-Agent')).toEqual([]);
  });
});

describe('HEADER_VALUE_SUGGESTIONS', () => {
  it('has entries for Content-Type, Accept, Authorization, Cache-Control, Accept-Language, Accept-Encoding', () => {
    expect(HEADER_VALUE_SUGGESTIONS['Content-Type']).toBeDefined();
    expect(HEADER_VALUE_SUGGESTIONS['Accept']).toBeDefined();
    expect(HEADER_VALUE_SUGGESTIONS['Authorization']).toBeDefined();
    expect(HEADER_VALUE_SUGGESTIONS['Cache-Control']).toBeDefined();
    expect(HEADER_VALUE_SUGGESTIONS['Accept-Language']).toBeDefined();
    expect(HEADER_VALUE_SUGGESTIONS['Accept-Encoding']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=httpHeaderSuggestions
```

Expected: fail with `Cannot find module '../webview/src/form/httpHeaderSuggestions'`

- [ ] **Step 3: Create the catalog file**

Create `webview/src/form/httpHeaderSuggestions.ts`:

```ts
// Static catalog of common HTTP header names and per-header value presets.
// All data is compile-time constants — no runtime logic except the
// case-insensitive lookup helper.

export const COMMON_HEADERS: string[] = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Cache-Control',
  'Accept-Language',
  'Accept-Encoding',
  'User-Agent',
  'X-Request-ID',
  'Origin',
  'Referer',
];

// Per-header value presets. Keys use canonical HTTP casing.
// Only headers where a short list of values covers the common cases are
// included — headers like User-Agent or X-Request-ID have free-form values
// and are omitted intentionally.
export const HEADER_VALUE_SUGGESTIONS: Record<string, string[]> = {
  'Content-Type': [
    'application/json',
    'application/x-www-form-urlencoded',
    'text/plain',
    'text/html',
    'multipart/form-data',
    'application/xml',
  ],
  'Accept': [
    'application/json',
    'text/html',
    '*/*',
    'text/plain',
    'application/xml',
  ],
  // Trailing space intentional: cursor lands after "Bearer " / "Basic "
  // so the user can type the token immediately.
  'Authorization': [
    'Bearer ',
    'Basic ',
  ],
  'Cache-Control': [
    'no-cache',
    'no-store',
    'max-age=0',
    'must-revalidate',
  ],
  'Accept-Language': [
    'en-US',
    'en',
    'de',
    'fr',
    '*',
  ],
  'Accept-Encoding': [
    'gzip, deflate, br',
    'identity',
    '*',
  ],
};

// Case-insensitive lookup. Returns the preset values for the given header
// name, or an empty array when none are defined.
export function valueSuggestionsForKey(key: string): string[] {
  const normalized = key.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const match = Object.keys(HEADER_VALUE_SUGGESTIONS).find(
    k => k.toLowerCase() === normalized,
  );
  return match ? HEADER_VALUE_SUGGESTIONS[match] : [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern=httpHeaderSuggestions
```

Expected: all 11 tests pass.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
npm run typecheck && npm test
```

Expected: all existing tests still pass; 11 new tests added.

- [ ] **Step 6: Commit**

```bash
git add webview/src/form/httpHeaderSuggestions.ts test/httpHeaderSuggestions.test.ts
git commit -m "feat(http-request): add HTTP header suggestion catalog"
```

---

## Task 2: Create SuggestionDropdown component

**Files:**
- Create: `webview/src/form/SuggestionDropdown.tsx`

- [ ] **Step 1: Create the component**

Create `webview/src/form/SuggestionDropdown.tsx`:

```tsx
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
      {items.map(item => (
        <button
          key={item}
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
```

- [ ] **Step 2: Run typecheck to verify no type errors**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add webview/src/form/SuggestionDropdown.tsx
git commit -m "feat(http-request): add SuggestionDropdown component"
```

---

## Task 3: Create HttpHeadersEditor component

**Files:**
- Create: `webview/src/form/HttpHeadersEditor.tsx`

- [ ] **Step 1: Create the component**

Create `webview/src/form/HttpHeadersEditor.tsx`:

```tsx
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
                // Empty placeholder keeps the grid column present so key
                // and value inputs stay aligned across all rows.
                <span style={{ display: 'inline-block', width: 28 }} />
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
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add webview/src/form/HttpHeadersEditor.tsx
git commit -m "feat(http-request): add HttpHeadersEditor with lightning suggestion buttons"
```

---

## Task 4: Add `httpHeaders` kind to formSchema.ts

**Files:**
- Modify: `src/shared/formSchema.ts:129`

- [ ] **Step 1: Add the new union member**

In `src/shared/formSchema.ts`, find the `kvList` line (line 129):

```ts
  | ({ kind: 'kvList'; key: string; label: string; placeholder?: string } & BaseFieldMeta)
```

Add the new `httpHeaders` member immediately after it:

```ts
  | ({ kind: 'kvList'; key: string; label: string; placeholder?: string } & BaseFieldMeta)
  // Like `kvList`, but renders the specialized HttpHeadersEditor with ⚡
  // suggestion buttons for common HTTP header names and values. Only the
  // HTTP Request adapter's headers field uses this kind.
  | ({ kind: 'httpHeaders'; key: string; label: string } & BaseFieldMeta)
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/formSchema.ts
git commit -m "feat(http-request): add httpHeaders FormField kind to schema"
```

---

## Task 5: Wire `httpHeaders` into Field.tsx

**Files:**
- Modify: `webview/src/form/Field.tsx`

- [ ] **Step 1: Add the import**

In `webview/src/form/Field.tsx`, add the `HttpHeadersEditor` import alongside the existing imports (line 5 area):

Replace:
```ts
import { KvListEditor, type KvListRow } from './KvListEditor';
```

With:
```ts
import { KvListEditor, type KvListRow } from './KvListEditor';
import { HttpHeadersEditor } from './HttpHeadersEditor';
```

- [ ] **Step 2: Add the case in renderInput**

In `renderInput`, find the `case 'kvList':` block (lines 385–394):

```ts
    case 'kvList':
      return (
        <KvListEditor
          value={(v as KvListRow[]) ?? []}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
          placeholder={field.placeholder}
        />
      );
```

Add the new case immediately after the closing `);` of `kvList`:

```ts
    case 'httpHeaders':
      return (
        <HttpHeadersEditor
          value={(v as KvListRow[]) ?? []}
          onChange={set}
          onFocus={h.focus}
          onBlur={h.blur}
        />
      );
```

- [ ] **Step 3: Run typecheck and tests**

```bash
npm run typecheck && npm test
```

Expected: no type errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add webview/src/form/Field.tsx
git commit -m "feat(http-request): wire httpHeaders kind in Field renderInput"
```

---

## Task 6: Switch HttpRequestAdapter headers field to `httpHeaders` kind

**Files:**
- Modify: `src/adapters/http-request/HttpRequestAdapter.ts:128-137`

- [ ] **Step 1: Change the field kind**

In `src/adapters/http-request/HttpRequestAdapter.ts`, find the headers field definition (around line 128):

```ts
        {
          kind: 'kvList',
          key: 'typeOptions.headers',
          label: 'Headers',
          help:
            'Custom HTTP headers. `Content-Type` is inferred from the body kind below (`application/json`, `application/x-www-form-urlencoded`, etc.) — overriding it here wins.\n\n' +
            '`Authorization` is set automatically from the **Auth** section unless you add it here.\n\n' +
            VAR_SYNTAX_HINT,
        },
```

Change `kind: 'kvList'` to `kind: 'httpHeaders'`:

```ts
        {
          kind: 'httpHeaders',
          key: 'typeOptions.headers',
          label: 'Headers',
          help:
            'Custom HTTP headers. `Content-Type` is inferred from the body kind below (`application/json`, `application/x-www-form-urlencoded`, etc.) — overriding it here wins.\n\n' +
            '`Authorization` is set automatically from the **Auth** section unless you add it here.\n\n' +
            VAR_SYNTAX_HINT,
        },
```

- [ ] **Step 2: Run typecheck and full test suite**

```bash
npm run typecheck && npm test
```

Expected: no type errors, all tests pass (930+ tests, 11 new ones added in Task 1).

- [ ] **Step 3: Run build to verify webview bundles cleanly**

```bash
npm run build
```

Expected: clean build, no warnings about unresolved imports.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/http-request/HttpRequestAdapter.ts
git commit -m "feat(http-request): use httpHeaders field kind for headers editor"
```

---

## Verification

After all tasks are complete, open VS Code with the extension running (`F5` / `npm run watch`), create or open an HTTP request config, and verify:

1. The headers section renders rows with `[☑] [key input] [⚡] [value input] [ ] [−]` layout (value ⚡ placeholder when no key is set)
2. Clicking ⚡ next to the key input opens a dropdown with 10 header names; clicking one fills the key field and closes the dropdown
3. After setting key to `Content-Type`, a ⚡ appears next to the value input; clicking it shows `application/json`, `text/plain`, etc.
4. After setting key to `User-Agent`, no ⚡ appears next to the value input
5. Clicking outside a dropdown closes it
6. Disabled rows (unchecked checkbox) show at 50% opacity on key and value inputs; ⚡ buttons remain functional
7. The `+ Add row` button adds a new empty row
8. Existing headers from a saved config load correctly (re-seed on config switch works)
