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

  it('OAuth uses <access_token> placeholder', () => {
    const curl = buildRequestCurl(baseOpts({ authKind: 'oauth-client-credentials' }));
    expect(curl).toContain('Authorization: Bearer <access_token>');
    expect(curl).not.toContain('#');
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

  it('escapes single quotes in body', () => {
    const curl = buildRequestCurl(baseOpts({
      method: 'POST',
      bodyKind: 'raw',
      bodyRaw: "it's alive",
    }));
    expect(curl).toContain("--data-raw 'it'\\''s alive'");
  });

  it('escapes single quotes in header values', () => {
    const curl = buildRequestCurl(baseOpts({
      headers: [{ key: 'X-Name', value: "O'Reilly", enabled: true }],
    }));
    expect(curl).toContain("-H 'X-Name: O'\\''Reilly'");
  });

  it('CUSTOM method with blank customMethod falls back to GET silently', () => {
    const curl = buildRequestCurl(baseOpts({ method: 'CUSTOM', customMethod: '' }));
    expect(curl).not.toContain('#');
    expect(curl).toContain('curl ');
    expect(curl).not.toContain('-X');
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

  it('applies verifyTls false as --insecure', () => {
    const curl = buildTokenCurl(baseOpts({ verifyTls: false }));
    expect(curl).toContain('--insecure');
  });

  it('applies timeoutMs as --max-time', () => {
    const curl = buildTokenCurl(baseOpts({ timeoutMs: 10000 }));
    expect(curl).toContain('--max-time 10');
  });

  it('escapes single quotes in client credentials (body mode)', () => {
    const curl = buildTokenCurl(baseOpts({
      authOAuthClientCredentials: {
        tokenUrl: 'https://auth.example.com/token',
        clientId: "id'with'quotes",
        clientSecret: "sec'ret",
        scope: '',
        clientAuth: 'body',
      },
    }));
    expect(curl).toContain("client_id=id'\\''with'\\''quotes");
    expect(curl).toContain("client_secret=sec'\\''ret");
  });
});
