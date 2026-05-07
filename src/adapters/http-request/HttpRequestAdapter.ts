import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema, FormField } from '../../shared/formSchema';
import { dependsOnField, envFilesField } from '../sharedFields';
import { log } from '../../utils/logger';

// HTTP Request — fire-and-log style config. Unlike the build-tool types
// this isn't a ShellExecution; ExecutionService special-cases the run
// path to invoke HttpRequestRunner directly, then flashes a status icon
// (green/yellow/red) on the tree row for 3 seconds based on the response
// code. The form mirrors Postman/Insomnia/Bruno's structure: method+url
// at the top, then collapsible-feeling sections for params, headers,
// auth, body, the assert script, and network knobs.
//
// Why declarative: every field opts into our existing `dependsOn` gating
// so we get reactive UI for free — pick "json" body kind and the json
// textarea appears; pick "basic" auth and the username/password inputs
// appear; etc. No custom React panel needed.

const VAR_SYNTAX_HINT =
  'Supports `${env:VAR}` (from `.env` files / process env), `${workspaceFolder}`, and `${userHome}`. Unresolved variables expand to an empty string at request time.';

export class HttpRequestAdapter implements RuntimeAdapter {
  readonly type = 'http-request' as const;
  readonly label = 'HTTP Request';
  readonly supportsDebug = false;

  async detect(_folder: vscode.Uri): Promise<DetectionResult | null> {
    // No auto-detection — HTTP requests are user-declared.
    log.debug(`HTTP Request detect: matches any folder (user-declared)`);
    return {
      defaults: {
        type: 'http-request',
        typeOptions: {
          url: '',
          method: 'GET',
          queryParams: [],
          headers: [],
          bodyKind: 'none',
          bodyRaw: '',
          bodyForm: [],
          authKind: 'none',
          authBasic: { username: '', password: '' },
          authBearer: { token: '' },
          authApiKey: { name: '', value: '', location: 'header' },
          authOAuthClientCredentials: { tokenUrl: '', clientId: '', clientSecret: '', scope: '', clientAuth: 'header' },
          timeoutMs: 30_000,
          followRedirects: true,
          verifyTls: true,
          assertScript: '',
          responseSink: 'output',
        },
      },
      context: {},
    };
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My API call',
          help: 'Display name shown in the sidebar.',
          examples: ['Health check', 'Create user', 'Refresh OAuth token'],
        },
      ],
      typeSpecific: [
        // ------- Method + URL on one row ----------------------------------
        // Method is the narrow field; URL is the partner that expands
        // to fill the row.
        {
          kind: 'select',
          key: 'typeOptions.method',
          label: 'Method',
          options: [
            { value: 'GET', label: 'GET' },
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
            { value: 'PATCH', label: 'PATCH' },
            { value: 'DELETE', label: 'DELETE' },
            { value: 'HEAD', label: 'HEAD' },
            { value: 'OPTIONS', label: 'OPTIONS' },
            { value: 'CUSTOM', label: 'Custom…' },
          ],
          inlineWith: 'next',
          help: 'HTTP method. Pick CUSTOM to type a non-standard verb (rare — useful for WebDAV / PROPFIND).',
        },
        {
          kind: 'text',
          key: 'typeOptions.url',
          label: 'URL',
          required: true,
          placeholder: 'https://api.example.com/users',
          help: 'Full URL including scheme. Query parameters can be added inline or via the editor below — both work, the editor entries are appended after any inline `?...`. ' + VAR_SYNTAX_HINT,
          examples: [
            'https://api.example.com/v1/users',
            '${env:API_BASE}/health',
            'http://localhost:8080/actuator/info',
          ],
        },
        {
          kind: 'text',
          key: 'typeOptions.customMethod',
          label: 'Custom method',
          required: true,
          placeholder: 'PROPFIND',
          dependsOn: { key: 'typeOptions.method', equals: 'CUSTOM' },
          help: 'Verb sent on the wire. Uppercase by convention; we don\'t alter it.',
        },

        // ------- Query params ------------------------------------------------
        {
          kind: 'kvList',
          key: 'typeOptions.queryParams',
          label: 'Query parameters',
          help:
            'Appended to the URL as `?key=value&...`. Toggle the checkbox on each row to disable a param without removing it.\n\n' +
            'Both keys and values support `${VAR}` interpolation.\n\n' +
            VAR_SYNTAX_HINT,
        },

        // ------- Headers -----------------------------------------------------
        {
          kind: 'kvList',
          key: 'typeOptions.headers',
          label: 'Headers',
          help:
            'Custom HTTP headers. `Content-Type` is inferred from the body kind below (`application/json`, `application/x-www-form-urlencoded`, etc.) — overriding it here wins.\n\n' +
            '`Authorization` is set automatically from the **Auth** section unless you add it here.\n\n' +
            VAR_SYNTAX_HINT,
        },

        // ------- Auth --------------------------------------------------------
        {
          kind: 'select',
          key: 'typeOptions.authKind',
          label: 'Authentication',
          options: [
            { value: 'none', label: 'No auth' },
            { value: 'basic', label: 'Basic (username + password)' },
            { value: 'bearer', label: 'Bearer token' },
            { value: 'apiKey', label: 'API key' },
            { value: 'oauth-client-credentials', label: 'OAuth 2 — client credentials' },
          ],
          help:
            'How to authenticate. Adds the right `Authorization` header (or query param for API key) automatically.\n\n' +
            '**OAuth client credentials** performs an extra `POST` to the token endpoint at run time, then uses the returned `access_token` as a Bearer on the actual request.',
        },
        {
          kind: 'text',
          key: 'typeOptions.authBasic.username',
          label: 'Username',
          dependsOn: { key: 'typeOptions.authKind', equals: 'basic' },
          help: 'Username for HTTP Basic auth. ' + VAR_SYNTAX_HINT,
        },
        {
          kind: 'text',
          key: 'typeOptions.authBasic.password',
          label: 'Password',
          dependsOn: { key: 'typeOptions.authKind', equals: 'basic' },
          help: 'Password for HTTP Basic auth. Stored in run.json — use ${env:PASSWORD} to read from your environment instead.',
        },
        {
          kind: 'text',
          key: 'typeOptions.authBearer.token',
          label: 'Token',
          dependsOn: { key: 'typeOptions.authKind', equals: 'bearer' },
          help: 'Sent as `Authorization: Bearer <token>`. Use ${env:TOKEN} or a .env file to keep secrets out of run.json.',
          examples: ['${env:GITHUB_TOKEN}', 'eyJhbGciOiJI...'],
        },
        {
          kind: 'text',
          key: 'typeOptions.authApiKey.name',
          label: 'Key name',
          dependsOn: { key: 'typeOptions.authKind', equals: 'apiKey' },
          help: 'Name of the header / query parameter. Common: `X-API-Key`, `apikey`, `api_key`.',
          examples: ['X-API-Key', 'apikey'],
        },
        {
          kind: 'text',
          key: 'typeOptions.authApiKey.value',
          label: 'Key value',
          dependsOn: { key: 'typeOptions.authKind', equals: 'apiKey' },
          help: 'The secret. Use ${env:VAR} so the value never lands in source control.',
        },
        {
          kind: 'select',
          key: 'typeOptions.authApiKey.location',
          label: 'Add to',
          options: [
            { value: 'header', label: 'Request header' },
            { value: 'query', label: 'Query parameter' },
          ],
          dependsOn: { key: 'typeOptions.authKind', equals: 'apiKey' },
          help: 'Where the API key lands. Most APIs want a header; some legacy services expect a query parameter.',
        },
        // ------- OAuth 2 client credentials --------------------------------
        {
          kind: 'text',
          key: 'typeOptions.authOAuthClientCredentials.tokenUrl',
          label: 'Token endpoint URL',
          required: true,
          placeholder: 'https://auth.example.com/oauth2/token',
          dependsOn: { key: 'typeOptions.authKind', equals: 'oauth-client-credentials' },
          help:
            'The OAuth 2 token endpoint to call before the actual request.\n\n' +
            'The runner `POST`s `grant_type=client_credentials` here, reads `access_token` from the JSON response, and uses it as a Bearer token.\n\n' +
            VAR_SYNTAX_HINT,
        },
        {
          kind: 'text',
          key: 'typeOptions.authOAuthClientCredentials.clientId',
          label: 'Client ID',
          required: true,
          dependsOn: { key: 'typeOptions.authKind', equals: 'oauth-client-credentials' },
          help: 'OAuth client identifier issued by your authorization server. ' + VAR_SYNTAX_HINT,
        },
        {
          kind: 'text',
          key: 'typeOptions.authOAuthClientCredentials.clientSecret',
          label: 'Client secret',
          dependsOn: { key: 'typeOptions.authKind', equals: 'oauth-client-credentials' },
          help: 'OAuth client secret. Use ${env:VAR} so the secret never lands in run.json. Some servers issue public clients with no secret — leave blank in that case.',
        },
        {
          kind: 'text',
          key: 'typeOptions.authOAuthClientCredentials.scope',
          label: 'Scope (optional)',
          placeholder: 'read:users write:users',
          dependsOn: { key: 'typeOptions.authKind', equals: 'oauth-client-credentials' },
          help: 'Space-separated scopes added to the token request as `scope=…`. Leave blank to omit.',
        },
        {
          kind: 'select',
          key: 'typeOptions.authOAuthClientCredentials.clientAuth',
          label: 'Send client credentials in',
          options: [
            { value: 'header', label: 'Authorization header (HTTP Basic — RFC 6749 preferred)' },
            { value: 'body', label: 'Request body (client_id / client_secret as form fields)' },
          ],
          dependsOn: { key: 'typeOptions.authKind', equals: 'oauth-client-credentials' },
          help:
            'How to send the client id/secret to the token endpoint.\n\n' +
            'The **header** form (RFC 6749 §2.3.1 preferred) is what most servers expect.\n\n' +
            'Switch to **body** when your server requires `client_id` / `client_secret` as form parameters.',
        },

        // ------- Body --------------------------------------------------------
        {
          kind: 'select',
          key: 'typeOptions.bodyKind',
          label: 'Body',
          options: [
            { value: 'none', label: 'No body' },
            { value: 'json', label: 'JSON' },
            { value: 'form-urlencoded', label: 'Form (application/x-www-form-urlencoded)' },
            { value: 'raw', label: 'Raw text' },
            { value: 'xml', label: 'XML' },
          ],
          help:
            'Request body format. The right `Content-Type` is set automatically (you can override it in **Headers** above).\n\n' +
            '`GET` / `HEAD` requests typically have no body — using one is allowed but uncommon.',
        },
        {
          kind: 'textarea',
          key: 'typeOptions.bodyRaw',
          label: 'JSON body',
          rows: 8,
          language: 'json',
          placeholder: '{ "name": "Alice", "email": "alice@example.com" }',
          dependsOn: { key: 'typeOptions.bodyKind', equals: 'json' },
          help:
            'JSON payload. We don\'t validate or pretty-print on save — you can keep it as you typed it.\n\n' +
            'Variables are expanded **after** stringification, so put `${env:NAME}` inside string values, not as bare tokens.\n\n' +
            VAR_SYNTAX_HINT,
        },
        {
          kind: 'kvList',
          key: 'typeOptions.bodyForm',
          label: 'Form fields',
          dependsOn: { key: 'typeOptions.bodyKind', equals: 'form-urlencoded' },
          help:
            '`application/x-www-form-urlencoded` body. Each row becomes one `key=value` pair, URL-encoded.\n\n' +
            'Toggle the checkbox to disable a row without removing it.\n\n' +
            VAR_SYNTAX_HINT,
        },
        {
          kind: 'textarea',
          key: 'typeOptions.bodyRaw',
          label: 'Raw body',
          rows: 8,
          placeholder: 'arbitrary text/plain payload',
          dependsOn: { key: 'typeOptions.bodyKind', equals: 'raw' },
          help: 'Body sent as text/plain (override Content-Type via Headers if needed). ' + VAR_SYNTAX_HINT,
        },
        {
          kind: 'textarea',
          key: 'typeOptions.bodyRaw',
          label: 'XML body',
          rows: 8,
          placeholder: '<?xml version="1.0"?><root>...</root>',
          dependsOn: { key: 'typeOptions.bodyKind', equals: 'xml' },
          help: 'Sent with Content-Type application/xml. ' + VAR_SYNTAX_HINT,
        },

        // ------- Assert script ----------------------------------------------
        {
          kind: 'textarea',
          key: 'typeOptions.assertScript',
          label: 'Assert script (JavaScript, optional)',
          rows: 6,
          language: 'javascript',
          placeholder: 'if ($status !== 200) throw new Error("expected 200");\nreturn { id: $response.id };',
          help:
            'Runs after the response arrives.\n\n' +
            '**Available bindings:**\n' +
            '- `$response` — parsed body (JSON when content-type is JSON, otherwise the string)\n' +
            '- `$rawBody` — always a string\n' +
            '- `$headers` — lowercased header map\n' +
            '- `$status` — status code as number\n\n' +
            'Throwing or returning `false` fails the assertion (red icon flash). Returning anything else logs it to your chosen sink.\n\n' +
            '**Sandbox:** 5-second cap, no `require()`, no fs / network access.',
        },

        // ------- Output ------------------------------------------------------
        {
          kind: 'select',
          key: 'typeOptions.responseSink',
          label: 'Show response in',
          options: [
            { value: 'output', label: 'Output channel only' },
            { value: 'panel', label: 'Output channel + side panel' },
          ],
          help:
            'The full request/response (URL, headers, body, status, timing, assert result) is always written to the **Run Configurations** Output channel — that\'s the run history you can scroll back through.\n\n' +
            'Pick **Output channel + side panel** to additionally open a read-only tab beside the editor with the response status, headers, and pretty-printed body.\n\n' +
            'Useful for big JSON responses you want to read without scrolling past the request log.',
        },
      ],
      advanced: [
        envFilesField(),
        {
          kind: 'number',
          key: 'typeOptions.timeoutMs',
          label: 'Timeout (ms)',
          min: 1,
          max: 600_000,
          help: 'Abort the request after this many milliseconds. Includes connect + response. Default 30_000.',
        },
        {
          kind: 'boolean',
          key: 'typeOptions.followRedirects',
          label: 'Follow redirects',
          help: 'When enabled, 30x responses are followed up to 5 hops; the final response is what your assert script sees.',
        },
        {
          kind: 'boolean',
          key: 'typeOptions.verifyTls',
          label: 'Verify TLS certificate',
          help: 'Disable for local servers with self-signed certs. Re-enable in production — turning this off accepts ANY certificate.',
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
      ],
    };
  }

  // Required by RuntimeAdapter, but never invoked: ExecutionService
  // routes http-request configs to HttpRequestRunner instead of going
  // through ShellExecution. Returns a harmless echo so anything that
  // stringifies the result for diagnostics doesn't blow up.
  buildCommand(_cfg: RunConfig, _folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    return { command: 'echo', args: ['(http-request runs in-process; this command is not invoked)'] };
  }
}

// FormField type-narrowing helper kept here in case future fields want
// it. Currently unused — the schema above is fully literal.
void (null as unknown as FormField);
