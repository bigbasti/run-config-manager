import {
  buildUrl,
  buildHeaders,
  encodeBody,
  runAssertScript,
} from '../src/services/HttpRequestRunner';
import type { HttpKvRow, HttpRequestTypeOptions } from '../src/shared/types';

const passthrough = (s: string) => s;
const subVar = (s: string) => s.replace(/\$\{env:(\w+)\}/g, (_m, n) => `<${n}>`);

const baseTo: HttpRequestTypeOptions = {
  url: 'https://example.com',
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
};

const row = (k: string, v: string, enabled = true): HttpKvRow => ({ key: k, value: v, enabled });

describe('buildUrl', () => {
  test('appends enabled query params', () => {
    const url = buildUrl('https://example.com/api',
      [row('a', '1'), row('b', '2')], undefined, passthrough);
    expect(url).toBe('https://example.com/api?a=1&b=2');
  });

  test('skips disabled rows', () => {
    const url = buildUrl('https://example.com/api',
      [row('a', '1'), row('b', '2', false)], undefined, passthrough);
    expect(url).toBe('https://example.com/api?a=1');
  });

  test('preserves inline query params on the URL', () => {
    const url = buildUrl('https://example.com/api?token=abc',
      [row('q', 'search')], undefined, passthrough);
    expect(url).toContain('token=abc');
    expect(url).toContain('q=search');
  });

  test('appends apiKey location=query', () => {
    const url = buildUrl('https://example.com', [],
      { name: 'X-API-Key', value: 'abc', location: 'query' }, passthrough);
    expect(url).toBe('https://example.com/?X-API-Key=abc');
  });

  test('apiKey location=header is NOT added to URL', () => {
    const url = buildUrl('https://example.com', [],
      { name: 'X-API-Key', value: 'abc', location: 'header' }, passthrough);
    expect(url).toBe('https://example.com/');
  });

  test('resolves variables in keys and values', () => {
    const url = buildUrl('https://example.com',
      [row('${env:KEY}', '${env:VAL}')], undefined, subVar);
    expect(url).toBe('https://example.com/?%3CKEY%3E=%3CVAL%3E');
  });

  test('URL-encodes values', () => {
    const url = buildUrl('https://example.com',
      [row('q', 'hello world & more')], undefined, passthrough);
    expect(url).toBe('https://example.com/?q=hello+world+%26+more');
  });
});

describe('buildHeaders', () => {
  test('basic auth → Authorization: Basic <base64>', () => {
    const to = { ...baseTo, authKind: 'basic' as const,
      authBasic: { username: 'admin', password: 'hunter2' } };
    const out = buildHeaders(to, passthrough, undefined);
    expect(out['authorization']).toBe(`Basic ${Buffer.from('admin:hunter2').toString('base64')}`);
  });

  test('bearer auth → Authorization: Bearer <token>', () => {
    const to = { ...baseTo, authKind: 'bearer' as const,
      authBearer: { token: 'tok123' } };
    const out = buildHeaders(to, passthrough, undefined);
    expect(out['authorization']).toBe('Bearer tok123');
  });

  test('apiKey location=header sets a custom header', () => {
    const to = { ...baseTo, authKind: 'apiKey' as const,
      authApiKey: { name: 'X-API-Key', value: 'abc', location: 'header' as const } };
    const out = buildHeaders(to, passthrough, undefined);
    expect(out['x-api-key']).toBe('abc');
  });

  test('content-type from body kind populates header by default', () => {
    const out = buildHeaders(baseTo, passthrough, 'application/json');
    expect(out['content-type']).toBe('application/json');
  });

  test('user-defined Content-Type wins over body-kind default', () => {
    const to = { ...baseTo, headers: [row('Content-Type', 'application/vnd.api+json')] };
    const out = buildHeaders(to, passthrough, 'application/json');
    expect(out['content-type']).toBe('application/vnd.api+json');
  });

  test('disabled header rows are dropped', () => {
    const to = { ...baseTo, headers: [row('X-Trace', 'abc', false)] };
    const out = buildHeaders(to, passthrough, undefined);
    expect(out['x-trace']).toBeUndefined();
  });

  test('oauth-client-credentials uses pre-fetched token as Bearer', () => {
    const to = { ...baseTo, authKind: 'oauth-client-credentials' as const };
    const out = buildHeaders(to, passthrough, undefined, 'preFetchedToken');
    expect(out['authorization']).toBe('Bearer preFetchedToken');
  });

  test('oauth-client-credentials without a token leaves Authorization unset', () => {
    const to = { ...baseTo, authKind: 'oauth-client-credentials' as const };
    const out = buildHeaders(to, passthrough, undefined);
    expect(out['authorization']).toBeUndefined();
  });

  test('user header overrides bearer Authorization', () => {
    const to = {
      ...baseTo,
      authKind: 'bearer' as const,
      authBearer: { token: 'orig' },
      headers: [row('Authorization', 'Custom override')],
    };
    const out = buildHeaders(to, passthrough, undefined);
    expect(out['authorization']).toBe('Custom override');
  });
});

describe('encodeBody', () => {
  test('none → no body, no content-type', () => {
    const out = encodeBody({ ...baseTo, bodyKind: 'none' }, passthrough);
    expect(out).toEqual({ body: undefined, contentType: undefined });
  });

  test('json → string body + application/json', () => {
    const out = encodeBody({ ...baseTo, bodyKind: 'json', bodyRaw: '{"a":1}' }, passthrough);
    expect(out.body).toBe('{"a":1}');
    expect(out.contentType).toBe('application/json');
  });

  test('form-urlencoded encodes rows', () => {
    const out = encodeBody({
      ...baseTo,
      bodyKind: 'form-urlencoded',
      bodyForm: [row('a', '1'), row('b', 'hello world')],
    }, passthrough);
    expect(out.body).toBe('a=1&b=hello+world');
    expect(out.contentType).toBe('application/x-www-form-urlencoded');
  });

  test('form-urlencoded skips disabled rows', () => {
    const out = encodeBody({
      ...baseTo,
      bodyKind: 'form-urlencoded',
      bodyForm: [row('a', '1'), row('b', '2', false)],
    }, passthrough);
    expect(out.body).toBe('a=1');
  });

  test('xml → application/xml', () => {
    const out = encodeBody({ ...baseTo, bodyKind: 'xml', bodyRaw: '<r/>' }, passthrough);
    expect(out.body).toBe('<r/>');
    expect(out.contentType).toBe('application/xml');
  });

  test('raw → text/plain', () => {
    const out = encodeBody({ ...baseTo, bodyKind: 'raw', bodyRaw: 'plain' }, passthrough);
    expect(out.contentType).toBe('text/plain');
  });

  test('values resolve variables', () => {
    const out = encodeBody({
      ...baseTo,
      bodyKind: 'form-urlencoded',
      bodyForm: [row('user', '${env:NAME}')],
    }, subVar);
    expect(out.body).toBe('user=%3CNAME%3E');
  });
});

describe('runAssertScript', () => {
  test('returns the script result', () => {
    const ret = runAssertScript('return $status === 200 ? "ok" : "no"',
      { $response: {}, $rawBody: '', $headers: {}, $status: 200 });
    expect(ret).toBe('ok');
  });

  test('throw fails the assertion (caller catches)', () => {
    expect(() => runAssertScript('throw new Error("nope")',
      { $response: {}, $rawBody: '', $headers: {}, $status: 500 }))
      .toThrow('nope');
  });

  test('exposes $response, $headers, $status', () => {
    const ret = runAssertScript(
      'return { id: $response.id, ct: $headers["content-type"], s: $status };',
      { $response: { id: 7 }, $rawBody: '', $headers: { 'content-type': 'application/json' }, $status: 201 },
    );
    expect(ret).toEqual({ id: 7, ct: 'application/json', s: 201 });
  });

  test('no `require` in the sandbox', () => {
    expect(() => runAssertScript('return require("fs")',
      { $response: {}, $rawBody: '', $headers: {}, $status: 200 }))
      .toThrow();
  });

  test('top-level return works (script wrapped in IIFE)', () => {
    const ret = runAssertScript('return 42;',
      { $response: {}, $rawBody: '', $headers: {}, $status: 200 });
    expect(ret).toBe(42);
  });
});
