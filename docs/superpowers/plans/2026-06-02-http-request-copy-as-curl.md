# HTTP Request — Copy as curl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Copy as curl" icon button next to the Execute button on the HTTP request form that converts the current form values (with env-variable resolution) into an equivalent `curl` command, shows it in a textarea below the button row, and auto-copies it to the clipboard. When OAuth 2 (`oauth-client-credentials`) is selected, a dropdown offers a second option to also generate the token endpoint curl command.

**Architecture:** A new pure-function module `src/services/buildCurlCommand.ts` generates curl strings from a fully-resolved config. `EditorPanel.ts` handles a new `copyCurl` webview message: it loads env files, resolves variables, calls the builder, and posts a `curlResult` message back. `App.tsx` adds the icon button, dropdown, clipboard write, and curl output textarea. Two new message types are added to `src/shared/protocol.ts`.

**Tech Stack:** TypeScript (extension), React (webview), Node.js built-ins (no new npm deps).

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/services/buildCurlCommand.ts` | Create | Pure functions: `buildRequestCurl` and `buildTokenCurl` |
| `src/shared/protocol.ts` | Modify | Add `copyCurl` (webview→ext) and `curlResult` (ext→webview) message shapes |
| `src/ui/EditorPanel.ts` | Modify | Handle `copyCurl` message: resolve env + vars, call builder, post `curlResult` |
| `webview/src/App.tsx` | Modify | Copy icon button, dropdown (OAuth only), clipboard write, curl textarea + close button |
| `test/buildCurlCommand.test.ts` | Create | Unit tests for both builder functions |

---

## Task 1: Create `buildCurlCommand.ts` with failing tests

**Files:**
- Create: `src/services/buildCurlCommand.ts`
- Create: `test/buildCurlCommand.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/buildCurlCommand.test.ts`:

```ts
import { buildRequestCurl, buildTokenCurl } from '../src/services/buildCurlCommand';
import type { HttpRequestTypeOptions } from '../src/shared/types';

function baseOpts(overrides: Partial<HttpRequestTypeOptions> = {}): HttpRequestTypeOptions {
  return {
    url: 'https://example.com/api',
    method: 'GET',
    customMethod: '',
    queryParams: [],
    headers: [],
    bodyKind: 'none',
    bodyRaw: '',
    bodyForm: [],
    authKind: 'none',
    authBasic: { username: '', password: '' },
    authBearer: { token: '' },
    authApiKey: { name: '', value: '', location: 'header' },
    authOAuthClientCredentials: {
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'my-client',
      clientSecret: 'my-secret',
      scope: '',
      clientAuth: 'header',
    },
    timeoutMs: 30000,
    followRedirects: true,
    verifyTls: true,
    assertScript: '',
    responseSink: 'output',
    ...overrides,
  };
}

// ── buildRequestCurl ──────────────────────────────────────────────────────────

describe('buildRequestCurl', () => {
  it('GET omits -X flag', () => {
    const curl = buildRequestCurl(baseOpts());
    expect(curl).not.toContain('-X');
    expect(curl).toContain('https://example.com/api');
  });

  it('POST includes -X POST', () => {
    const curl = buildRequestCurl(baseOpts({ method: 'POST' }));
    expect(curl).toContain('-X POST');
  });

  it('CUSTOM method uses customMethod value', () => {
    const curl = buildRequestCurl(baseOpts({ method: 'CUSTOM', customMethod: 'PURGE' }));
    expect(curl).toContain('-X PURGE');
  });

  it('appends enabled query params to URL', () => {
    const curl = buildRequestCurl(baseOpts({
      queryParams: [
        { key: 'foo', value: 'bar', enabled: true },
        { key: 'skip', value: 'me', enabled: false },
      ],
    }));
    expect(curl).toContain('foo=bar');
    expect(curl).not.toContain('skip=me');
  });

  it('includes enabled user headers', () => {
    const curl = buildRequestCurl(baseOpts({
      headers: [
        { key: 'X-Custom', value: 'hello', enabled: true },
        { key: 'X-Skip', value: 'bye', enabled: false },
      ],
    }));
    expect(curl).toContain("-H 'X-Custom: hello'");
    expect(curl).not.toContain('X-Skip');
  });

  it('adds Basic auth header', () => {
    const curl = buildRequestCurl(baseOpts({
      authKind: 'basic',
      authBasic: { username: 'user', password: 'pass' },
    }));
    const b64 = Buffer.from('user:pass').toString('base64');
    expect(curl).toContain(`-H 'Authorization: Basic ${b64}'`);
  });

  it('adds Bearer auth header', () => {
    const curl = buildRequestCurl(baseOpts({
      authKind: 'bearer',
      authBearer: { token: 'mytoken' },
    }));
    expect(curl).toContain("-H 'Authorization: Bearer mytoken'");
  });

  it('adds API key header when location is header', () => {
    const curl = buildRequestCurl(baseOpts({
      authKind: 'apiKey',
      authApiKey: { name: 'X-Api-Key', value: 'secret', location: 'header' },
    }));
    expect(curl).toContain("-H 'X-Api-Key: secret'");
  });

  it('appends API key to URL when location is query', () => {
    const curl = buildRequestCurl(baseOpts({
      authKind: 'apiKey',
      authApiKey: { name: 'api_key', value: 'secret', location: 'query' },
    }));
    expect(curl).toContain('api_key=secret');
    expect(curl).not.toContain("-H 'api_key:");
  });

  it('OAuth uses <access_token> placeholder and includes NOTE comment', () => {
    const curl = buildRequestCurl(baseOpts({ authKind: 'oauth-client-credentials' }));
    expect(curl).toContain('Authorization: Bearer <access_token>');
    expect(curl).toContain('# NOTE:');
  });

  it('JSON body uses --data-raw', () => {
    const curl = buildRequestCurl(baseOpts({
      method: 'POST',
      bodyKind: 'json',
      bodyRaw: '{"a":1}',
    }));
    expect(curl).toContain("--data-raw '{\"a\":1}'");
    expect(curl).toContain("Content-Type: application/json");
  });

  it('form-urlencoded body uses --data-urlencode per enabled row', () => {
    const curl = buildRequestCurl(baseOpts({
      method: 'POST',
      bodyKind: 'form-urlencoded',
      bodyForm: [
        { key: 'a', value: '1', enabled: true },
        { key: 'b', value: '2', enabled: false },
      ],
    }));
    expect(curl).toContain("--data-urlencode 'a=1'");
    expect(curl).not.toContain("--data-urlencode 'b=2'");
  });

  it('raw body uses --data-raw', () => {
    const curl = buildRequestCurl(baseOpts({
      method: 'POST',
      bodyKind: 'raw',
      bodyRaw: 'hello world',
    }));
    expect(curl).toContain("--data-raw 'hello world'");
  });

  it('xml body uses --data-raw and Content-Type application/xml', () => {
    const curl = buildRequestCurl(baseOpts({
      method: 'POST',
      bodyKind: 'xml',
      bodyRaw: '<root/>',
    }));
    expect(curl).toContain("--data-raw '<root/>'");
    expect(curl).toContain("Content-Type: application/xml");
  });

  it('verifyTls false adds --insecure', () => {
    const curl = buildRequestCurl(baseOpts({ verifyTls: false }));
    expect(curl).toContain('--insecure');
  });

  it('verifyTls true omits --insecure', () => {
    const curl = buildRequestCurl(baseOpts({ verifyTls: true }));
    expect(curl).not.toContain('--insecure');
  });

  it('followRedirects true adds -L', () => {
    const curl = buildRequestCurl(baseOpts({ followRedirects: true }));
    expect(curl).toContain('-L');
  });

  it('followRedirects false omits -L', () => {
    const curl = buildRequestCurl(baseOpts({ followRedirects: false }));
    expect(curl).not.toContain('-L');
  });

  it('includes --max-time based on timeoutMs', () => {
    const curl = buildRequestCurl(baseOpts({ timeoutMs: 15000 }));
    expect(curl).toContain('--max-time 15');
  });
});

// ── buildTokenCurl ────────────────────────────────────────────────────────────

describe('buildTokenCurl', () => {
  it('posts to tokenUrl', () => {
    const curl = buildTokenCurl(baseOpts());
    expect(curl).toContain('-X POST');
    expect(curl).toContain('https://auth.example.com/token');
  });

  it('sets Content-Type form header', () => {
    const curl = buildTokenCurl(baseOpts());
    expect(curl).toContain("Content-Type: application/x-www-form-urlencoded");
  });

  it('clientAuth header: uses Basic Authorization header', () => {
    const curl = buildTokenCurl(baseOpts({
      authOAuthClientCredentials: {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
        scope: '',
        clientAuth: 'header',
      },
    }));
    const b64 = Buffer.from(`${encodeURIComponent('id')}:${encodeURIComponent('secret')}`).toString('base64');
    expect(curl).toContain(`Authorization: Basic ${b64}`);
    expect(curl).toContain("--data-urlencode 'grant_type=client_credentials'");
    expect(curl).not.toContain('client_id');
    expect(curl).not.toContain('client_secret');
  });

  it('clientAuth body: sends credentials as form fields', () => {
    const curl = buildTokenCurl(baseOpts({
      authOAuthClientCredentials: {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
        scope: '',
        clientAuth: 'body',
      },
    }));
    expect(curl).toContain("--data-urlencode 'grant_type=client_credentials'");
    expect(curl).toContain("--data-urlencode 'client_id=id'");
    expect(curl).toContain("--data-urlencode 'client_secret=secret'");
    expect(curl).not.toContain('Authorization:');
  });

  it('appends scope when non-empty', () => {
    const curl = buildTokenCurl(baseOpts({
      authOAuthClientCredentials: {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
        scope: 'read write',
        clientAuth: 'header',
      },
    }));
    expect(curl).toContain("--data-urlencode 'scope=read write'");
  });

  it('omits scope when empty', () => {
    const curl = buildTokenCurl(baseOpts());
    expect(curl).not.toContain('scope');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest test/buildCurlCommand.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/services/buildCurlCommand'`

- [ ] **Step 3: Implement `buildCurlCommand.ts`**

Create `src/services/buildCurlCommand.ts`:

```ts
import type { HttpRequestTypeOptions } from '../shared/types';

/**
 * Builds a curl command string for the main HTTP request.
 * `to` must already have all variables resolved (no ${...} tokens).
 * When authKind is 'oauth-client-credentials', a <access_token> placeholder
 * is used because the actual token requires a live network call.
 */
export function buildRequestCurl(to: HttpRequestTypeOptions): string {
  const parts: string[] = [];

  // NOTE comment for OAuth so user understands the placeholder
  if (to.authKind === 'oauth-client-credentials') {
    parts.push(
      '# NOTE: This request uses OAuth 2 client credentials. Run the token curl first,',
      '# then replace <access_token> with the access_token value from the response.',
    );
  }

  // Base command
  const method = to.method === 'CUSTOM' ? (to.customMethod || 'GET') : to.method;
  const cmdParts: string[] = ['curl'];
  if (method !== 'GET') {
    cmdParts.push(`-X ${method}`);
  }

  // URL (with query params + API key in query)
  let url = to.url;
  const qp: string[] = [];
  for (const row of to.queryParams) {
    if (row.enabled && row.key) {
      qp.push(`${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`);
    }
  }
  if (to.authKind === 'apiKey' && to.authApiKey.location === 'query' && to.authApiKey.name) {
    qp.push(`${encodeURIComponent(to.authApiKey.name)}=${encodeURIComponent(to.authApiKey.value)}`);
  }
  if (qp.length > 0) {
    url += (url.includes('?') ? '&' : '?') + qp.join('&');
  }
  cmdParts.push(`'${url}'`);

  // Content-Type from body kind
  const contentTypeMap: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    'form-urlencoded': 'application/x-www-form-urlencoded',
  };
  const bodyContentType = contentTypeMap[to.bodyKind];

  // Auth header
  if (to.authKind === 'basic') {
    const b64 = Buffer.from(`${to.authBasic.username}:${to.authBasic.password}`).toString('base64');
    cmdParts.push(`-H 'Authorization: Basic ${b64}'`);
  } else if (to.authKind === 'bearer') {
    cmdParts.push(`-H 'Authorization: Bearer ${to.authBearer.token}'`);
  } else if (to.authKind === 'apiKey' && to.authApiKey.location === 'header' && to.authApiKey.name) {
    cmdParts.push(`-H '${to.authApiKey.name}: ${to.authApiKey.value}'`);
  } else if (to.authKind === 'oauth-client-credentials') {
    cmdParts.push(`-H 'Authorization: Bearer <access_token>'`);
  }

  // Content-Type header (before user headers so user can override)
  if (bodyContentType) {
    cmdParts.push(`-H 'Content-Type: ${bodyContentType}'`);
  }

  // User-defined headers (enabled only)
  for (const row of to.headers) {
    if (row.enabled && row.key) {
      cmdParts.push(`-H '${row.key}: ${row.value}'`);
    }
  }

  // Body
  if (to.bodyKind === 'json' || to.bodyKind === 'raw' || to.bodyKind === 'xml') {
    if (to.bodyRaw) {
      cmdParts.push(`--data-raw '${to.bodyRaw}'`);
    }
  } else if (to.bodyKind === 'form-urlencoded') {
    for (const row of to.bodyForm) {
      if (row.enabled && row.key) {
        cmdParts.push(`--data-urlencode '${row.key}=${row.value}'`);
      }
    }
  }

  // Options
  if (!to.verifyTls) {
    cmdParts.push('--insecure');
  }
  if (to.followRedirects) {
    cmdParts.push('-L');
  }
  cmdParts.push(`--max-time ${Math.floor(to.timeoutMs / 1000)}`);

  parts.push(cmdParts.join(' '));
  return parts.join('\n');
}

/**
 * Builds a curl command string for the OAuth 2 token endpoint request.
 * Only call this when authKind === 'oauth-client-credentials'.
 * `to` must already have all variables resolved.
 */
export function buildTokenCurl(to: HttpRequestTypeOptions): string {
  const oauth = to.authOAuthClientCredentials;
  const cmdParts: string[] = ['curl', '-X POST', `'${oauth.tokenUrl}'`];

  if (oauth.clientAuth === 'header') {
    const encoded = `${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret)}`;
    const b64 = Buffer.from(encoded).toString('base64');
    cmdParts.push(`-H 'Authorization: Basic ${b64}'`);
  }

  cmdParts.push(`-H 'Content-Type: application/x-www-form-urlencoded'`);
  cmdParts.push(`--data-urlencode 'grant_type=client_credentials'`);

  if (oauth.clientAuth === 'body') {
    cmdParts.push(`--data-urlencode 'client_id=${oauth.clientId}'`);
    cmdParts.push(`--data-urlencode 'client_secret=${oauth.clientSecret}'`);
  }

  if (oauth.scope) {
    cmdParts.push(`--data-urlencode 'scope=${oauth.scope}'`);
  }

  return cmdParts.join(' ');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest test/buildCurlCommand.test.ts --no-coverage 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
npm run typecheck && npx jest --no-coverage 2>&1 | tail -20
```

Expected: all existing tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/buildCurlCommand.ts test/buildCurlCommand.test.ts
git commit -m "feat(http-request): add buildCurlCommand pure-function module"
```

---

## Task 2: Add protocol message types

**Files:**
- Modify: `src/shared/protocol.ts`

- [ ] **Step 1: Read current outbound and inbound union types**

Open `src/shared/protocol.ts`. Find the outbound (webview→extension) union type — it will contain `{ cmd: 'executeUnsaved'; config: RunConfig }` — and the inbound (extension→webview) union type. Note the exact type names.

- [ ] **Step 2: Add `copyCurl` to the outbound union**

In the outbound union (webview→extension), add alongside the `executeUnsaved` member:

```ts
| { cmd: 'copyCurl'; config: RunConfig; target: 'request' | 'token' }
```

- [ ] **Step 3: Add `curlResult` to the inbound union**

In the inbound union (extension→webview), add:

```ts
| { cmd: 'curlResult'; curl: string }
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts
git commit -m "feat(http-request): add copyCurl/curlResult protocol message types"
```

---

## Task 3: Handle `copyCurl` in EditorPanel

**Files:**
- Modify: `src/ui/EditorPanel.ts`

- [ ] **Step 1: Add import for buildCurlCommand**

At the top of `src/ui/EditorPanel.ts`, add:

```ts
import { buildRequestCurl, buildTokenCurl } from '../services/buildCurlCommand';
```

Also verify these imports are already present (they should be — used by `executeUnsaved`):
```ts
import { loadEnvFiles } from '../services/EnvFileLoader';
import { makeRunContext, resolveVars } from '../utils/resolveVars';
import { sanitizeConfig } from '...'; // whatever path sanitizeConfig comes from
```

- [ ] **Step 2: Add `copyCurl` case in the message handler**

Find the `case 'executeUnsaved':` block in the webview message handler. Add a new case immediately after it:

```ts
case 'copyCurl': {
  if (msg.config.type !== 'http-request') {
    log.warn(`copyCurl called with non-http-request type: ${msg.config.type}`);
    return;
  }
  const safe = sanitizeConfig(msg.config);
  if (safe.type !== 'http-request') return; // narrowing

  // Resolve env files and variables (same logic as HttpRequestRunner.runHttpRequest)
  const to = safe.typeOptions;
  const envFiles = (safe.envFiles ?? []) as string[];
  let envFromFiles: Record<string, string> = {};
  if (envFiles.length > 0) {
    const { merged } = await loadEnvFiles(envFiles, this.args.folder.uri.fsPath);
    envFromFiles = merged;
  }
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...envFromFiles, ...safe.env };
  const ctx = makeRunContext({
    workspaceFolder: this.args.folder.uri.fsPath,
    cwd: this.args.folder.uri.fsPath,
    env: mergedEnv,
  });
  const resolve = (s: string) => resolveVars(s, ctx).value;

  // Build a resolved copy of typeOptions
  const resolvedTo: typeof to = {
    ...to,
    url: resolve(to.url),
    queryParams: to.queryParams.map(r => ({ ...r, key: resolve(r.key), value: resolve(r.value) })),
    headers: to.headers.map(r => ({ ...r, key: resolve(r.key), value: resolve(r.value) })),
    bodyRaw: resolve(to.bodyRaw),
    bodyForm: to.bodyForm.map(r => ({ ...r, key: resolve(r.key), value: resolve(r.value) })),
    authBasic: { username: resolve(to.authBasic.username), password: resolve(to.authBasic.password) },
    authBearer: { token: resolve(to.authBearer.token) },
    authApiKey: { ...to.authApiKey, name: resolve(to.authApiKey.name), value: resolve(to.authApiKey.value) },
    authOAuthClientCredentials: {
      ...to.authOAuthClientCredentials,
      tokenUrl: resolve(to.authOAuthClientCredentials.tokenUrl),
      clientId: resolve(to.authOAuthClientCredentials.clientId),
      clientSecret: resolve(to.authOAuthClientCredentials.clientSecret),
      scope: resolve(to.authOAuthClientCredentials.scope),
    },
  };

  const curl = msg.target === 'token'
    ? buildTokenCurl(resolvedTo)
    : buildRequestCurl(resolvedTo);

  panel.webview.postMessage({ cmd: 'curlResult', curl });
  return;
}
```

> **Note:** `panel` refers to the `vscode.WebviewPanel` instance held by `EditorPanel`. Check the existing `executeUnsaved` case for the exact variable name used to post messages — it may be `this._panel`, `panel`, or similar. Match it.

- [ ] **Step 3: Type-check**

```bash
npm run typecheck 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/EditorPanel.ts
git commit -m "feat(http-request): handle copyCurl message in EditorPanel"
```

---

## Task 4: Add Copy-as-curl UI to App.tsx

**Files:**
- Modify: `webview/src/App.tsx`

- [ ] **Step 1: Add state variables**

Find the http-request-specific state section in `App.tsx` (search for `executeUnsaved`). Add two new state variables near the top of the `App` component function (or near the http-request execute button logic):

```tsx
const [curlOutput, setCurlOutput] = React.useState<string | null>(null);
const [curlDropdownOpen, setCurlDropdownOpen] = React.useState(false);
```

- [ ] **Step 2: Handle `curlResult` in the inbound message handler**

Find the `switch (msg.cmd)` (or `if/else if`) block that handles messages from the extension. Add a case for `curlResult`:

```tsx
case 'curlResult':
  setCurlOutput(msg.curl);
  navigator.clipboard.writeText(msg.curl).catch(() => {
    // clipboard may be unavailable in some webview contexts; textarea fallback still works
  });
  break;
```

- [ ] **Step 3: Add `useEffect` to close dropdown on outside click**

In the http-request section of `App.tsx`, add an effect that closes the dropdown when the user clicks outside:

```tsx
React.useEffect(() => {
  if (!curlDropdownOpen) return;
  const handler = () => setCurlDropdownOpen(false);
  document.addEventListener('mousedown', handler);
  return () => document.removeEventListener('mousedown', handler);
}, [curlDropdownOpen]);
```

- [ ] **Step 4: Replace the execute button block with the updated UI**

Find the existing http-request button block in `App.tsx`:

```tsx
{values.type === 'http-request' && (
  <div className="side-actions" style={{ marginTop: 6 }}>
    <button
      title="Run this HTTP request now using the current (possibly unsaved) form values."
      onClick={() => {
        setError(null);
        post({ cmd: 'executeUnsaved', config: values as RunConfig });
      }}
    >
      ▶ Execute
    </button>
  </div>
)}
```

Replace it with:

```tsx
{values.type === 'http-request' && (
  <div style={{ marginTop: 6 }}>
    <div className="side-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        title="Run this HTTP request now using the current (possibly unsaved) form values."
        onClick={() => {
          setError(null);
          post({ cmd: 'executeUnsaved', config: values as RunConfig });
        }}
      >
        ▶ Execute
      </button>

      {/* Copy as curl button */}
      <div style={{ position: 'relative' }}>
        {values.typeOptions?.authKind === 'oauth-client-credentials' ? (
          <>
            <button
              title="Copy as curl"
              onClick={(e) => {
                e.stopPropagation();
                setCurlDropdownOpen(open => !open);
              }}
            >
              ⧉
            </button>
            {curlDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  zIndex: 100,
                  background: 'var(--vscode-menu-background)',
                  border: '1px solid var(--vscode-menu-border)',
                  minWidth: 260,
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' }}
                  onClick={() => {
                    setCurlDropdownOpen(false);
                    post({ cmd: 'copyCurl', config: values as RunConfig, target: 'request' });
                  }}
                >
                  Convert Request to curl command
                </button>
                <button
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' }}
                  onClick={() => {
                    setCurlDropdownOpen(false);
                    post({ cmd: 'copyCurl', config: values as RunConfig, target: 'token' });
                  }}
                >
                  Convert Token Request to curl command
                </button>
              </div>
            )}
          </>
        ) : (
          <button
            title="Copy as curl"
            onClick={() => {
              post({ cmd: 'copyCurl', config: values as RunConfig, target: 'request' });
            }}
          >
            ⧉
          </button>
        )}
      </div>
    </div>

    {/* Curl output textarea */}
    {curlOutput !== null && (
      <div style={{ marginTop: 6 }}>
        <textarea
          readOnly
          value={curlOutput}
          rows={6}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
        />
        <div>
          <button onClick={() => setCurlOutput(null)}>Close</button>
        </div>
      </div>
    )}
  </div>
)}
```

> **Note on the copy icon:** The `⧉` Unicode character (U+29C9, two joined squares) is used as the copy icon. If the project uses VS Code codicons instead (check other buttons in App.tsx), replace `⧉` with the appropriate codicon span. Match whatever icon style is already used in the file.

- [ ] **Step 5: Type-check webview**

```bash
npm run typecheck 2>&1 | grep -i error | head -20
```

Expected: no errors.

- [ ] **Step 6: Build webview to confirm no bundler errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: builds successfully.

- [ ] **Step 7: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add webview/src/App.tsx
git commit -m "feat(http-request): add Copy as curl button with dropdown and output textarea"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run full typecheck + test + build**

```bash
npm run typecheck && npm test && npm run build 2>&1 | tail -30
```

Expected: typecheck clean, all tests green, build succeeds.

- [ ] **Step 2: Verify test coverage of new module**

```bash
npx jest test/buildCurlCommand.test.ts --no-coverage --verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all test cases listed as passing.

- [ ] **Step 3: Commit if anything was missed**

If the previous steps left uncommitted changes:

```bash
git add -A
git commit -m "feat(http-request): copy-as-curl final cleanup"
```

---

## Self-Review Notes

- All spec requirements covered: icon button ✓, same row as Execute ✓, dropdown only for OAuth ✓, two dropdown entries ✓, textarea below button row ✓, close button ✓, auto-clipboard ✓, env-var resolution in extension ✓, token curl for OAuth ✓.
- `buildRequestCurl` and `buildTokenCurl` signatures are consistent across Task 1 (implementation), Task 3 (EditorPanel call sites), and the test file.
- The `sanitizeConfig` function is already used in `executeUnsaved` — Task 3 reuses it. If the import path can't be found at implementation time, grep for `sanitizeConfig` in `EditorPanel.ts` to get the exact import.
- The `panel.webview.postMessage` variable name must be verified against the actual EditorPanel code at implementation time (Task 3 Step 2 note covers this).
- The copy icon character `⧉` may need to be swapped for a codicon if the codebase uses codicons — Task 4 Step 4 note covers this.
