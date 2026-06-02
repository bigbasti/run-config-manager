# HTTP Request — Copy as curl

**Date:** 2026-06-02  
**Scope:** `http-request` config type only  
**Status:** Approved

## Goal

Add a "Copy as curl" button to the HTTP request editor that converts the current (possibly unsaved) form values into an equivalent `curl` command and displays it in a textarea below the Execute button. Variable resolution (`${env:VAR}`, `${workspaceFolder}`, etc.) and env-file loading happen in the extension so the output reflects real values.

## User-facing behaviour

- A copy icon button appears to the right of the `▶ Execute` button on the same row, with `title="Copy as curl"`.
- When `authKind` is **not** `oauth-client-credentials`: clicking the button immediately generates and shows the curl command for the main HTTP request.
- When `authKind` is `oauth-client-credentials`: clicking the button opens a small dropdown with two entries:
  1. **"Convert Request to curl command"** — generates curl for the main HTTP request (with `<access_token>` placeholder and a comment explaining it requires a live token fetch).
  2. **"Convert Token Request to curl command"** — generates curl for the OAuth client-credentials token endpoint call.
- On generation, the curl string is:
  - Written into a read-only `<textarea>` that appears below the button row (coexists with any open response panel).
  - Also automatically copied to the clipboard via `navigator.clipboard.writeText`.
- A **Close** button below the textarea hides it. Opening a new curl command replaces the previous one.
- Clicking outside the dropdown (when open) closes it without generating a command.

## Architecture

### Protocol (`src/shared/protocol.ts`)

New message shapes:

```ts
// Webview → Extension
{ cmd: 'copyCurl'; config: RunConfig; target: 'request' | 'token' }

// Extension → Webview
{ cmd: 'curlResult'; curl: string }
```

`target: 'token'` is only meaningful when `authKind === 'oauth-client-credentials'`. The extension handler guards this and returns an error curl string if the invariant is violated.

### Curl builder (`src/services/buildCurlCommand.ts`)

Pure-function module, no side effects, fully unit-testable.

```ts
export function buildRequestCurl(cfg: HttpRequestConfig, env: Record<string, string>): string
export function buildTokenCurl(cfg: HttpRequestConfig, env: Record<string, string>): string
```

`cfg` is already fully resolved (vars substituted, env merged) before these functions are called.

#### `buildRequestCurl` rules

| Aspect | Rule |
|---|---|
| Method | `-X METHOD`; omit `-X` for GET (curl default) |
| URL | Base URL + enabled query params appended; API key appended if `authApiKey.location === 'query'` |
| Headers | One `-H 'Name: Value'` per enabled header; auth headers injected exactly as `HttpRequestRunner.buildHeaders()` does |
| OAuth bearer | Auth header uses literal `<access_token>`; a `# NOTE:` comment line above the curl explains a live token is needed |
| Body — json / raw / xml | `--data-raw '...'` with the raw body string |
| Body — form-urlencoded | One `--data-urlencode 'key=value'` per enabled form row |
| Body — none | No body flags |
| TLS | `--insecure` when `verifyTls === false` |
| Redirects | `-L` when `followRedirects === true`; omitted otherwise |
| Timeout | `--max-time <timeoutMs / 1000>` |

#### `buildTokenCurl` rules

Produces the `curl` equivalent of `fetchClientCredentialsToken` in `HttpRequestRunner`:

- `curl -X POST <tokenUrl>`
- `-H 'Content-Type: application/x-www-form-urlencoded'`
- When `clientAuth === 'header'`: `-H 'Authorization: Basic <base64(urlEncode(clientId):urlEncode(clientSecret))>'` + `--data-urlencode 'grant_type=client_credentials'` (+ `--data-urlencode 'scope=<scope>'` if non-empty)
- When `clientAuth === 'body'`: `--data-urlencode 'grant_type=client_credentials'` + `--data-urlencode 'client_id=<clientId>'` + `--data-urlencode 'client_secret=<clientSecret>'` (+ scope if non-empty)
- Resolved values are used directly (no masking).

### EditorPanel handler (`src/ui/EditorPanel.ts`)

New `case 'copyCurl'` alongside the existing `case 'executeUnsaved'`:

```ts
case 'copyCurl': {
  const cfg = msg.config as HttpRequestConfig;
  const env = await loadAndResolveEnv(cfg, folder);   // same helpers as executeUnsaved
  const resolvedCfg = resolveAllFields(cfg, env);
  const curl = msg.target === 'token'
    ? buildTokenCurl(resolvedCfg, env)
    : buildRequestCurl(resolvedCfg, env);
  panel.webview.postMessage({ cmd: 'curlResult', curl });
  break;
}
```

No new services, no changes to `HttpRequestRunner` logic.

### Webview UI (`webview/src/App.tsx`)

**New state:**
```ts
const [curlOutput, setCurlOutput] = useState<string | null>(null);
const [curlDropdownOpen, setCurlDropdownOpen] = useState(false);
```

**Button row** (inside the existing `type === 'http-request'` block):
- `▶ Execute` stays on the left (unchanged).
- Copy icon button added to the right:
  - Non-OAuth: `onClick` fires `copyCurl` with `target: 'request'` directly.
  - OAuth: `onClick` toggles `curlDropdownOpen`; dropdown renders two `<button>` entries.
- `useEffect` closes the dropdown on outside click (standard document `mousedown` listener pattern).

**Incoming message handler** addition:
```ts
case 'curlResult':
  setCurlOutput(msg.curl);
  navigator.clipboard.writeText(msg.curl);
  break;
```

**Curl output area** (rendered below the button row when `curlOutput !== null`):
```tsx
<textarea readOnly value={curlOutput} rows={6} className="curl-output" />
<button onClick={() => setCurlOutput(null)}>Close</button>
```

The textarea is read-only; clipboard was auto-populated on generation.

## Testing

- Unit tests for `buildRequestCurl` and `buildTokenCurl` in `test/buildCurlCommand.test.ts` covering:
  - GET with no body (no `-X`, no body flags)
  - POST with JSON body
  - POST with form-urlencoded body
  - Headers injection (Basic, Bearer, API key header, API key query)
  - OAuth request curl (placeholder + comment)
  - OAuth token curl — `clientAuth: 'header'` and `clientAuth: 'body'` variants
  - `verifyTls: false` → `--insecure`
  - `followRedirects: true` → `-L`
  - Disabled query params / headers are excluded
- `EditorPanel` message routing tested via the existing mock pattern (assert `curlResult` message posted back).

## Out of scope

- Pretty-printing / line-continuation (`\`) of the curl output — single-line output is sufficient.
- Saving curl history.
- Copying directly without showing the textarea.
- Any config type other than `http-request`.
