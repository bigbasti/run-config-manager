# HTTP Headers Smart Suggestions — Design

**Date:** 2026-05-28  
**Status:** Approved

## Overview

The HTTP request config's headers editor (`KvListEditor` rendered for `typeOptions.headers`) gains two "lightning" (⚡) suggestion buttons per row:

1. **Key lightning** — always visible next to the key input. Opens a dropdown of the 10 most common HTTP header names.
2. **Value lightning** — visible next to the value input only when the current key has known common values. Opens a dropdown of preset values for that header.

Both dropdowns close automatically when the user picks an item (auto-close on pick) or clicks anywhere outside.

## Data Layer

**File:** `webview/src/form/httpHeaderSuggestions.ts`

Exports two constants. No runtime logic — pure static data.

### `COMMON_HEADERS: string[]`

Ten header names in priority order, shown in the key lightning dropdown:

```ts
export const COMMON_HEADERS = [
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
```

### `HEADER_VALUE_SUGGESTIONS: Record<string, string[]>`

Per-header value presets. Keys are canonical casing; lookup must be case-insensitive at call sites.

| Header | Values |
|---|---|
| `Content-Type` | `application/json`, `application/x-www-form-urlencoded`, `text/plain`, `text/html`, `multipart/form-data`, `application/xml` |
| `Accept` | `application/json`, `text/html`, `*/*`, `text/plain`, `application/xml` |
| `Authorization` | `Bearer ` (trailing space), `Basic ` (trailing space) |
| `Cache-Control` | `no-cache`, `no-store`, `max-age=0`, `must-revalidate` |
| `Accept-Language` | `en-US`, `en`, `de`, `fr`, `*` |
| `Accept-Encoding` | `gzip, deflate, br`, `identity`, `*` |

Headers not present in this map (`User-Agent`, `X-Request-ID`, `Origin`, `Referer`) have no value suggestions — the value ⚡ button is simply not rendered for those rows.

**Case-insensitive lookup helper** exported alongside:

```ts
export function valueSuggestionsForKey(key: string): string[] {
  const normalized = key.trim().toLowerCase();
  const match = Object.keys(HEADER_VALUE_SUGGESTIONS).find(k => k.toLowerCase() === normalized);
  return match ? HEADER_VALUE_SUGGESTIONS[match] : [];
}
```

## Components

### `SuggestionDropdown.tsx`

`webview/src/form/SuggestionDropdown.tsx` — small, self-contained, reusable.

**Props:**
```ts
interface Props {
  items: string[];
  onSelect: (item: string) => void;
  onClose: () => void;
}
```

**Behavior:**
- Renders an absolute-positioned `<div>` (parent must be `position: relative`)
- One `<button type="button">` per item, `width: 100%`
- Clicking an item calls `onSelect(item)` then `onClose()`
- A `useEffect` attaches a `mousedown` listener on `document`; if the click target is outside the dropdown `<div>` (checked via `ref.current.contains`), calls `onClose()`
- Cleanup removes the listener on unmount

**Styling** — VS Code CSS variables for theming:
- Background: `--vscode-dropdown-background`
- Foreground: `--vscode-dropdown-foreground`
- Border: `1px solid var(--vscode-dropdown-border)`
- Border radius: `4px`
- Box shadow: `0 2px 8px rgba(0,0,0,0.3)`
- Item hover: `background: var(--vscode-list-hoverBackground)`
- Z-index: `100`
- No scroll (max 10 items fits without overflow)

### `HttpHeadersEditor.tsx`

`webview/src/form/HttpHeadersEditor.tsx` — replaces `KvListEditor` for the headers field.

**External interface:** identical to `KvListEditor`:
```ts
interface Props {
  value: KvListRow[];
  onChange: (next: KvListRow[]) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}
```

**Internal state:**
```ts
const [rows, setRows] = useState<InternalRow[]>(...);  // stable-id rows, same as KvListEditor
const [openDropdown, setOpenDropdown] = useState<{ rowId: number; which: 'key' | 'value' } | null>(null);
```

Row sync logic (stable ids, `lastSynced` ref, re-seed on external prop change, publish upward on local change) is copied directly from `KvListEditor` — same invariants apply.

**Grid layout per row:**
```
[checkbox] [key input] [⚡ key btn] [value input] [⚡ value btn] [− trash btn]
```
CSS: `grid-template-columns: auto 1fr auto 1fr auto auto`

The value-⚡ cell is always present in the grid but only renders the button when `valueSuggestionsForKey(row.key).length > 0`. When there are no suggestions, the cell is empty (an empty `<span>` or `<div>`), keeping column alignment stable across all rows.

**Key lightning (⚡) click:** sets `openDropdown` to `{ rowId: row.id, which: 'key' }`. If already open for this row+which, toggles closed.

**Value lightning (⚡) click:** sets `openDropdown` to `{ rowId: row.id, which: 'value' }`. Same toggle behavior.

**Dropdown rendering:** when `openDropdown` matches a row, render `<SuggestionDropdown>` inside a `position: relative` wrapper around the button. `onSelect` for key dropdown: calls `updateKey(rowId, item)`. `onSelect` for value dropdown: calls `updateValue(rowId, item)`. Both call `setOpenDropdown(null)` via `onClose`.

**Disabled row opacity:** same as `KvListEditor` — `opacity: 0.5` on key/value inputs when `!row.enabled`.

**Add row:** `+ Add row` button at the bottom, same as `KvListEditor`.

## Plumbing Changes

### `src/shared/formSchema.ts`

Add `'httpHeaders'` to the `FormField` kind union. The shape is identical to `kvList` (no extra props) — it's purely a dispatch signal.

```ts
// before
kind: 'kvList'
// after (new union member)
| { kind: 'httpHeaders'; key: string; label: string; help?: string; ... }
```

The existing `kvList` shape is kept unchanged.

### `webview/src/form/Field.tsx`

Add a `case 'httpHeaders':` branch in `renderInput` that renders `<HttpHeadersEditor>` with the same prop mapping as the existing `'kvList'` case. Import `HttpHeadersEditor` at the top.

### `src/adapters/http-request/HttpRequestAdapter.ts`

Change the headers field definition:
```ts
// before
{ kind: 'kvList', key: 'typeOptions.headers', label: 'Headers', help: '...' }
// after
{ kind: 'httpHeaders', key: 'typeOptions.headers', label: 'Headers', help: '...' }
```

No other adapter or field uses `typeOptions.headers`, so the change is local.

## Data Flow

```
User clicks ⚡ (key column)
  → openDropdown = { rowId, which: 'key' }
  → SuggestionDropdown renders with COMMON_HEADERS
  → User picks "Content-Type"
  → updateKey(rowId, "Content-Type")
  → openDropdown = null (auto-close)
  → valueSuggestionsForKey("Content-Type") = [...] → value ⚡ appears

User clicks ⚡ (value column)
  → openDropdown = { rowId, which: 'value' }
  → SuggestionDropdown renders with ["application/json", ...]
  → User picks "application/json"
  → updateValue(rowId, "application/json")
  → openDropdown = null

User clicks outside any dropdown
  → SuggestionDropdown mousedown listener fires
  → onClose() → openDropdown = null
```

## Error Handling

- No async operations — all data is static. No error states needed.
- If `valueSuggestionsForKey` receives an empty string or whitespace-only key, it returns `[]` — the value ⚡ is not rendered. No error.

## Testing

The suggestion data (`httpHeaderSuggestions.ts`) is pure functions with no imports — unit-testable directly.

Suggested test file: `test/httpHeaderSuggestions.test.ts`
- `valueSuggestionsForKey` returns correct values for known keys
- Case-insensitive lookup works (`content-type` → same as `Content-Type`)
- Unknown keys return `[]`
- `COMMON_HEADERS` has exactly 10 items

`HttpHeadersEditor` and `SuggestionDropdown` are React components — no Jest tests needed for visual behavior (no existing React component tests in the project). Manual verification against the running webview is sufficient.

## Files Changed

| File | Change |
|---|---|
| `webview/src/form/httpHeaderSuggestions.ts` | **New** — suggestion catalog |
| `webview/src/form/SuggestionDropdown.tsx` | **New** — generic dropdown component |
| `webview/src/form/HttpHeadersEditor.tsx` | **New** — headers-specific KvList with ⚡ buttons |
| `webview/src/form/Field.tsx` | Add `'httpHeaders'` case in `renderInput` |
| `src/shared/formSchema.ts` | Add `'httpHeaders'` to `FormField` kind union |
| `src/adapters/http-request/HttpRequestAdapter.ts` | Change headers field `kind` to `'httpHeaders'` |

No changes to `KvListEditor.tsx`, extension-side services, or any non-HTTP adapter.
