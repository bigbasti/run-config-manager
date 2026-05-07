import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as vm from 'vm';
import type { RunConfig, HttpRequestTypeOptions, HttpKvRow } from '../shared/types';
import { log } from '../utils/logger';
import { makeRunContext, resolveVars } from '../utils/resolveVars';
import { loadEnvFiles } from './EnvFileLoader';

// Runs an http-request configuration: builds the URL, headers, and body
// from the saved typeOptions, performs the request via Node's http(s)
// module, runs the user's assert script in a vm sandbox, and emits a
// neat run-log to the user's chosen sink (Output channel or a side
// panel webview). Returns the status class so ExecutionService can flash
// the right tree-row icon.

export type HttpRunOutcome =
  | { kind: 'success'; status: number }       // 2xx
  | { kind: 'client-error'; status: number }  // 4xx
  | { kind: 'server-error'; status: number }  // 5xx
  | { kind: 'failed'; error: string };        // network / timeout / assert throw

export interface HttpRunResult {
  outcome: HttpRunOutcome;
}

// Public entry point. The caller is responsible for resolving common
// fields (env, projectPath, etc.) — we only resolve the http-specific
// strings against the merged var bag.
export async function runHttpRequest(
  cfg: Extract<RunConfig, { type: 'http-request' }>,
  folder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel,
): Promise<HttpRunResult> {
  const to = cfg.typeOptions;

  // Variable resolution: merge .env files (loaded fresh) → cfg.env, then
  // expand ${VAR}/${env:VAR}/${workspaceFolder} in every string field.
  // ExecutionService does this for normal configs; here we do it
  // ourselves because http-request bypasses ExecutionService's
  // ShellExecution path.
  const envFiles = (cfg.envFiles ?? []) as string[];
  let envFromFiles: Record<string, string> = {};
  if (envFiles.length > 0) {
    const { merged, files } = await loadEnvFiles(envFiles, folder.uri.fsPath);
    envFromFiles = merged;
    const missing = files.filter(f => !f.loaded).map(f => f.path);
    if (missing.length) {
      log.warn(`HTTP run "${cfg.name}": .env file(s) missing/unreadable: ${missing.join(', ')}`);
    }
  }
  // Form table wins over .env, both win over process.env (matches the
  // shell-launch precedence in ExecutionService). The merged map is
  // passed via the resolver context's `env` so ${env:NAME} resolves
  // against it.
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...envFromFiles, ...cfg.env };
  const ctx = makeRunContext({
    workspaceFolder: folder.uri.fsPath,
    cwd: folder.uri.fsPath,
    env: mergedEnv,
  });

  const resolve = (s: string) => resolveVars(s, ctx).value;

  let url: URL;
  try {
    url = new URL(buildUrl(resolve(to.url), to.queryParams, to.authKind === 'apiKey' ? to.authApiKey : undefined, resolve));
  } catch (e) {
    const msg = `Invalid URL after variable expansion: ${(e as Error).message}`;
    output.appendLine(`✖ ${msg}`);
    log.error(msg);
    return { outcome: { kind: 'failed', error: msg } };
  }

  const method = to.method === 'CUSTOM' ? (to.customMethod ?? 'GET') : to.method;
  const { body, contentType } = encodeBody(to, resolve);

  // OAuth 2 client_credentials: hit the token endpoint, get an
  // access_token, and pass it to buildHeaders so the actual request
  // ships with Authorization: Bearer <token>. We deliberately log the
  // token-fetch leg before the main request so users can see both
  // round-trips in the Output.
  let oauthToken: string | undefined;
  if (to.authKind === 'oauth-client-credentials') {
    output.appendLine('');
    output.appendLine(`OAuth 2 client_credentials → fetching token from ${resolve(to.authOAuthClientCredentials.tokenUrl)}`);
    try {
      oauthToken = await fetchClientCredentialsToken(to, resolve, opts => {
        output.appendLine(opts);
      });
      output.appendLine(`OAuth: token acquired (${oauthToken.length} chars)`);
    } catch (e) {
      const msg = `OAuth token fetch failed: ${(e as Error).message}`;
      output.appendLine(`✖ ${msg}`);
      log.warn(`HTTP run "${cfg.name}": ${msg}`);
      return { outcome: { kind: 'failed', error: msg } };
    }
  }

  const headers = buildHeaders(to, resolve, contentType, oauthToken);

  // ------- Output: request side ----------------------------------------
  output.show(true);
  output.appendLine('');
  output.appendLine(`→ ${method} ${url.toString()}`);
  for (const [k, v] of Object.entries(headers)) {
    // Mask Authorization for safety. The actual value still ships on
    // the wire — this is only what we print.
    const display = /^authorization$/i.test(k) ? maskAuthHeader(v) : v;
    output.appendLine(`  ${k}: ${display}`);
  }
  if (body) {
    output.appendLine('  Body:');
    output.appendLine(indent(truncate(typeof body === 'string' ? body : body.toString('utf8'), 8 * 1024), '    '));
  }

  // ------- Network call ------------------------------------------------
  const startedAt = Date.now();
  let response: { status: number; headers: Record<string, string>; body: Buffer } | undefined;
  try {
    response = await sendRequest(url, method, headers, body, {
      timeoutMs: to.timeoutMs,
      followRedirects: to.followRedirects,
      verifyTls: to.verifyTls,
    });
  } catch (e) {
    const msg = (e as Error).message;
    output.appendLine(`✖ Request failed: ${msg}`);
    log.warn(`HTTP run "${cfg.name}" failed: ${msg}`);
    return { outcome: { kind: 'failed', error: msg } };
  }
  const durationMs = Date.now() - startedAt;

  // ------- Output: response side --------------------------------------
  const sizeLabel = formatBytes(response.body.length);
  output.appendLine('');
  output.appendLine(`← ${response.status} ${statusText(response.status)} in ${durationMs}ms (size: ${sizeLabel})`);
  for (const [k, v] of Object.entries(response.headers)) {
    output.appendLine(`  ${k}: ${v}`);
  }
  const bodyText = response.body.toString('utf8');
  const isJson = /\bjson\b/i.test(response.headers['content-type'] ?? '');
  output.appendLine('  Body:');
  output.appendLine(indent(prettifyBody(bodyText, isJson), '    '));

  // ------- Assert script ----------------------------------------------
  let assertFailed = false;
  if (to.assertScript.trim()) {
    try {
      const parsed = isJson ? safeParseJson(bodyText) : bodyText;
      const ret = runAssertScript(to.assertScript, {
        $response: parsed,
        $rawBody: bodyText,
        $headers: lowerCaseKeys(response.headers),
        $status: response.status,
      });
      output.appendLine('');
      output.appendLine(`Assert: ${formatAssertResult(ret)}`);
      // `return false` is treated as a failure.
      if (ret === false) assertFailed = true;
    } catch (e) {
      assertFailed = true;
      const msg = (e as Error).message;
      output.appendLine('');
      output.appendLine(`✖ Assert failed: ${msg}`);
    }
  }

  if (to.responseSink === 'panel') {
    showResponsePanel(cfg, method, url.toString(), response, durationMs, bodyText, isJson);
  }

  // Status-class mapping for tree-icon flash.
  if (assertFailed) return { outcome: { kind: 'failed', error: 'Assert failed' } };
  if (response.status >= 500) return { outcome: { kind: 'server-error', status: response.status } };
  if (response.status >= 400) return { outcome: { kind: 'client-error', status: response.status } };
  return { outcome: { kind: 'success', status: response.status } };
}

// ---------------------------------------------------------------------------
// URL + headers + body builders (exported for testing)
// ---------------------------------------------------------------------------

export function buildUrl(
  base: string,
  queryParams: HttpKvRow[],
  authApiKey: HttpRequestTypeOptions['authApiKey'] | undefined,
  resolve: (s: string) => string,
): string {
  const u = new URL(base);
  for (const row of queryParams) {
    if (!row.enabled) continue;
    if (!row.key) continue;
    u.searchParams.append(resolve(row.key), resolve(row.value));
  }
  if (authApiKey && authApiKey.location === 'query' && authApiKey.name && authApiKey.value) {
    u.searchParams.append(resolve(authApiKey.name), resolve(authApiKey.value));
  }
  return u.toString();
}

export function buildHeaders(
  to: HttpRequestTypeOptions,
  resolve: (s: string) => string,
  bodyContentType: string | undefined,
  // Pre-fetched OAuth bearer token (when authKind ===
  // 'oauth-client-credentials'). Caller is responsible for the token
  // round-trip; this function just slots it into Authorization.
  oauthBearer?: string,
): Record<string, string> {
  // Lowercased keys internally so user overrides can win regardless of
  // case. We re-emit with canonical capitalization on the wire (Node's
  // http will normalize).
  const out = new Map<string, string>();
  if (bodyContentType) out.set('content-type', bodyContentType);
  // Auth → Authorization header (or query param, handled in buildUrl).
  if (to.authKind === 'basic' && to.authBasic.username) {
    const u = resolve(to.authBasic.username);
    const p = resolve(to.authBasic.password);
    out.set('authorization', `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`);
  } else if (to.authKind === 'bearer' && to.authBearer.token) {
    out.set('authorization', `Bearer ${resolve(to.authBearer.token)}`);
  } else if (to.authKind === 'apiKey' && to.authApiKey.location === 'header'
             && to.authApiKey.name && to.authApiKey.value) {
    out.set(resolve(to.authApiKey.name).toLowerCase(), resolve(to.authApiKey.value));
  } else if (to.authKind === 'oauth-client-credentials' && oauthBearer) {
    out.set('authorization', `Bearer ${oauthBearer}`);
  }
  // User-defined headers last — they win over auth/content-type defaults.
  for (const row of to.headers) {
    if (!row.enabled) continue;
    if (!row.key) continue;
    out.set(resolve(row.key).toLowerCase(), resolve(row.value));
  }
  // Re-emit with the user's casing where available, otherwise canonical.
  // We just preserve lowercase; Node normalizes anyway.
  return Object.fromEntries(out);
}

export function encodeBody(
  to: HttpRequestTypeOptions,
  resolve: (s: string) => string,
): { body: Buffer | string | undefined; contentType: string | undefined } {
  switch (to.bodyKind) {
    case 'none':
      return { body: undefined, contentType: undefined };
    case 'json':
      return { body: resolve(to.bodyRaw), contentType: 'application/json' };
    case 'raw':
      return { body: resolve(to.bodyRaw), contentType: 'text/plain' };
    case 'xml':
      return { body: resolve(to.bodyRaw), contentType: 'application/xml' };
    case 'form-urlencoded': {
      const params = new URLSearchParams();
      for (const row of to.bodyForm) {
        if (!row.enabled) continue;
        if (!row.key) continue;
        params.append(resolve(row.key), resolve(row.value));
      }
      return {
        body: params.toString(),
        contentType: 'application/x-www-form-urlencoded',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth 2 — client_credentials grant
// ---------------------------------------------------------------------------

// Posts to the configured token endpoint with grant_type=client_credentials,
// honors the chosen `clientAuth` placement (header = HTTP Basic, body =
// form fields), and returns the access_token. Logs each side via the
// `log` callback so the Output channel shows both round-trips.
async function fetchClientCredentialsToken(
  to: HttpRequestTypeOptions,
  resolve: (s: string) => string,
  log: (line: string) => void,
): Promise<string> {
  const oc = to.authOAuthClientCredentials;
  const tokenUrl = new URL(resolve(oc.tokenUrl));
  const clientId = resolve(oc.clientId);
  const clientSecret = resolve(oc.clientSecret);
  const scope = resolve(oc.scope).trim();

  const formParts = new URLSearchParams();
  formParts.set('grant_type', 'client_credentials');
  if (scope) formParts.set('scope', scope);
  if (oc.clientAuth === 'body') {
    if (clientId) formParts.set('client_id', clientId);
    if (clientSecret) formParts.set('client_secret', clientSecret);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'accept': 'application/json',
  };
  if (oc.clientAuth === 'header') {
    // RFC 6749 §2.3.1: HTTP Basic with id:secret URL-encoded then
    // base64-encoded. `application/x-www-form-urlencoded` requires the
    // pre-encoding step.
    const enc = (s: string) => encodeURIComponent(s);
    const basic = Buffer
      .from(`${enc(clientId)}:${enc(clientSecret)}`)
      .toString('base64');
    headers['authorization'] = `Basic ${basic}`;
  }

  log(`  → POST ${tokenUrl.toString()}`);
  log(`  Content-Type: application/x-www-form-urlencoded`);
  log(`  Body: grant_type=client_credentials${scope ? ' scope=' + scope : ''}`);

  const res = await sendRequest(
    tokenUrl,
    'POST',
    headers,
    formParts.toString(),
    {
      // Token endpoints follow same network knobs as the main request.
      timeoutMs: to.timeoutMs,
      followRedirects: false, // explicit POST should never silently follow
      verifyTls: to.verifyTls,
    },
  );
  log(`  ← ${res.status} ${statusText(res.status)} (${res.body.length} B)`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Token endpoint returned HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 500)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(res.body.toString('utf8')); }
  catch { throw new Error('Token endpoint did not return JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Token endpoint returned an unexpected JSON shape');
  }
  const token = (parsed as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || !token) {
    throw new Error('Token endpoint response is missing `access_token`');
  }
  return token;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

interface SendOptions {
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
}

function sendRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | string | undefined,
  opts: SendOptions,
  redirectsLeft = 5,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        // verifyTls: false → accept self-signed / mismatched / expired.
        // Only kicks in for https.
        rejectUnauthorized: opts.verifyTls,
      },
      res => {
        // Follow redirects manually so we control the hop limit.
        const status = res.statusCode ?? 0;
        if (opts.followRedirects && status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          const next = new URL(res.headers.location, url);
          res.resume();
          // 303 forces GET; otherwise preserve method (per RFC 7231).
          const nextMethod = status === 303 ? 'GET' : method;
          const nextBody = status === 303 ? undefined : body;
          sendRequest(next, nextMethod, headers, nextBody, opts, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const lower: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            lower[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
          }
          resolve({ status, headers: lower, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${opts.timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Assert sandbox
// ---------------------------------------------------------------------------

interface AssertContext {
  $response: unknown;
  $rawBody: string;
  $headers: Record<string, string>;
  $status: number;
}

// Runs the user script in a fresh vm context with no `require()`, no
// fs/network globals, and a 5-second cap. The script is wrapped in an
// IIFE so a top-level `return` is legal — matches Postman/Insomnia's
// "test script" surface area, just narrower.
export function runAssertScript(script: string, ctx: AssertContext): unknown {
  const sandbox: Record<string, unknown> = {
    ...ctx,
    // Useful primitives — no side effects, no I/O.
    JSON,
    console: { log: (...a: unknown[]) => log.info(`assert: ${a.map(String).join(' ')}`) },
  };
  const wrapped = `(function() { ${script}\n })()`;
  return vm.runInNewContext(wrapped, sandbox, { timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function showResponsePanel(
  cfg: Extract<RunConfig, { type: 'http-request' }>,
  method: string,
  url: string,
  response: { status: number; headers: Record<string, string>; body: Buffer },
  durationMs: number,
  bodyText: string,
  isJson: boolean,
): void {
  const panel = vscode.window.createWebviewPanel(
    'rcm.httpResponse',
    `Response: ${cfg.name}`,
    vscode.ViewColumn.Beside,
    // Scripts on — the body section is interactive (JSON tree with
    // click-to-collapse). Stays sandboxed by VS Code's webview CSP.
    { enableScripts: true, retainContextWhenHidden: false },
  );
  const sizeLabel = formatBytes(response.body.length);
  const headerRows = Object.entries(response.headers)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  // Try to parse JSON for the tree view. If parsing fails (truncated
  // response, content-type lied, etc.) we fall back to syntax-
  // highlighted plain text — better than dumping unstyled bytes.
  let parsedJson: unknown = undefined;
  if (isJson) {
    try { parsedJson = JSON.parse(bodyText); } catch { /* fall through */ }
  }

  const bodyHtml = parsedJson !== undefined
    ? `<div id="json-root" class="json-root"></div>`
    : isJson
      ? `<pre class="code lang-json">${highlightedHtml(prettifyBody(bodyText, true), 'json')}</pre>`
      : `<pre class="code">${escapeHtml(bodyText)}</pre>`;

  // The script renders the JSON tree client-side so users can collapse
  // / expand objects and arrays. The tree is built once from the
  // serialized payload; nothing else runs in this webview, so no
  // vscode.postMessage round-trips needed.
  const scriptBlock = parsedJson !== undefined
    ? `<script>
const data = ${JSON.stringify(parsedJson).replace(/</g, '\\u003c')};
${JSON_TREE_RENDERER}
document.getElementById('json-root').appendChild(renderJsonTree(data));
</script>`
    : '';

  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${PANEL_STYLES}</style></head><body>
<h2>${escapeHtml(method)} ${escapeHtml(url)}</h2>
<div class="meta">
  <span class="status-${Math.floor(response.status / 100)}xx">${response.status} ${escapeHtml(statusText(response.status))}</span>
  · ${durationMs} ms · ${sizeLabel}
</div>
<h3>Headers</h3>
<table>${headerRows}</table>
<h3>Body</h3>
${bodyHtml}
${scriptBlock}
</body></html>`;
}

// CSS for the response panel. Token classes mirror the names emitted
// by CodeHighlight.ts in the form's CodeTextarea so the same VS Code
// editor variables apply, themes follow.
const PANEL_STYLES = `
body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; color: var(--vscode-foreground); }
h2 { margin: 0 0 4px 0; font-size: 1.2em; word-break: break-all; }
h3 { margin: 12px 0 6px 0; font-size: 1em; opacity: 0.9; }
.meta { opacity: 0.8; margin-bottom: 12px; }
table { border-collapse: collapse; margin-bottom: 4px; }
td { padding: 2px 8px; vertical-align: top; }
td:first-child { opacity: 0.7; }
.code { background: var(--vscode-editorWidget-background); padding: 8px; white-space: pre-wrap; word-break: break-word; border-radius: 2px; }
.json-root { background: var(--vscode-editorWidget-background); padding: 8px; border-radius: 2px; line-height: 1.4em; }
.json-row { display: block; }
.json-toggle {
  display: inline-block; width: 1em; cursor: pointer; user-select: none;
  text-align: center; opacity: 0.7;
}
.json-toggle:hover { opacity: 1; }
.json-children { padding-left: 1.4em; border-left: 1px dotted var(--vscode-panel-border, rgba(128,128,128,0.3)); margin-left: 0.4em; }
.json-collapsed > .json-children { display: none; }
.json-summary { opacity: 0.6; margin-left: 4px; font-style: italic; }
.tok-string   { color: var(--vscode-debugTokenExpression-string,  var(--vscode-editor-foreground)); }
.tok-number   { color: var(--vscode-debugTokenExpression-number,  #b5cea8); }
.tok-boolean  { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.tok-null     { color: var(--vscode-debugTokenExpression-boolean, #569cd6); font-style: italic; }
.tok-property { color: var(--vscode-debugTokenExpression-name,    #9cdcfe); }
.tok-punctuation { color: var(--vscode-editor-foreground); opacity: 0.85; }
.status-2xx { color: var(--vscode-testing-iconPassed, #5cb85c); }
.status-4xx { color: var(--vscode-editorWarning-foreground, #d9a800); }
.status-5xx { color: var(--vscode-errorForeground, #f48771); }
`;

// Inlined into the panel HTML. Pure DOM, no framework. Recursive
// renderer that emits a clickable toggle for any object/array node.
const JSON_TREE_RENDERER = `
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function span(cls, text) { return el('span', cls, text); }
function renderJsonTree(value) {
  // Top-level row — same as a child row but without the property label.
  const row = el('div', 'json-row');
  row.appendChild(renderValue(value, /*expanded*/true));
  return row;
}
function renderValue(value, expanded) {
  if (value === null) return span('tok-null', 'null');
  if (typeof value === 'string') return span('tok-string', JSON.stringify(value));
  if (typeof value === 'number') return span('tok-number', String(value));
  if (typeof value === 'boolean') return span('tok-boolean', String(value));
  if (Array.isArray(value)) return renderContainer(value, '[', ']', expanded, true);
  if (typeof value === 'object') return renderContainer(value, '{', '}', expanded, false);
  return span('', String(value));
}
function renderContainer(value, open, close, expanded, isArray) {
  const wrap = el('span', 'json-container' + (expanded ? '' : ' json-collapsed'));
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);

  if (entries.length === 0) {
    wrap.appendChild(span('tok-punctuation', open + close));
    return wrap;
  }

  const toggle = el('span', 'json-toggle', expanded ? '▾' : '▸');
  toggle.addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('json-collapsed');
    toggle.textContent = collapsed ? '▸' : '▾';
  });
  wrap.appendChild(toggle);
  wrap.appendChild(span('tok-punctuation', open));

  // Inline summary shown when collapsed (e.g. "{ 3 keys }").
  const summary = span('json-summary',
    isArray ? entries.length + ' item' + (entries.length === 1 ? '' : 's')
            : entries.length + ' key' + (entries.length === 1 ? '' : 's'));
  wrap.appendChild(summary);

  const children = el('div', 'json-children');
  entries.forEach(([k, v], i) => {
    const row = el('div', 'json-row');
    if (!isArray) {
      row.appendChild(span('tok-property', JSON.stringify(k)));
      row.appendChild(span('tok-punctuation', ': '));
    }
    row.appendChild(renderValue(v, true));
    if (i < entries.length - 1) row.appendChild(span('tok-punctuation', ','));
    children.appendChild(row);
  });
  wrap.appendChild(children);
  wrap.appendChild(span('tok-punctuation', close));
  return wrap;
}
`;

// Server-side highlight pass for the non-JSON-but-claims-JSON case.
// We can't share the webview tokenizer (it's webview-only), and we
// don't need exact parity — this is a fallback. Just colorize the
// obvious shapes via regex.
function highlightedHtml(text: string, _lang: 'json'): string {
  return escapeHtml(text)
    .replace(/&quot;((?:\\.|[^&\\])*?)&quot;(\s*:)/g, '<span class="tok-property">&quot;$1&quot;</span>$2')
    .replace(/&quot;((?:\\.|[^&\\])*?)&quot;/g, '<span class="tok-string">&quot;$1&quot;</span>')
    .replace(/\b(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="tok-number">$1</span>')
    .replace(/\b(true|false)\b/g, '<span class="tok-boolean">$1</span>')
    .replace(/\b(null)\b/g, '<span class="tok-null">$1</span>');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lowerCaseKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function safeParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function maskAuthHeader(v: string): string {
  // Show the scheme but mask the credential. "Basic ****" / "Bearer ****".
  const m = v.match(/^(\w+)\s+/);
  return m ? `${m[1]} ••••••••` : '••••••••';
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(l => prefix + l).join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… (truncated, ${text.length - max} more bytes)`;
}

function prettifyBody(text: string, isJson: boolean): string {
  if (!isJson) return truncate(text, 100 * 1024);
  try {
    return truncate(JSON.stringify(JSON.parse(text), null, 2), 100 * 1024);
  } catch {
    return truncate(text, 100 * 1024);
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function statusText(code: number): string {
  return STATUS_TEXT[code] ?? '';
}

function formatAssertResult(v: unknown): string {
  if (v === undefined) return '(no return value)';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Tiny lookup — only the codes we expect users to hit. Unknown codes
// render with the number alone, which is fine.
const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
