import { parsePipConfigOutput, mergePipProxy } from '../src/adapters/python/detectPipProxy';

describe('parsePipConfigOutput', () => {
  test('parses single-quoted values', () => {
    const text = "global.proxy='http://corp:8080'\nglobal.index-url='https://nexus.local/simple'";
    expect(parsePipConfigOutput(text)).toEqual({
      proxy: 'http://corp:8080',
      indexUrl: 'https://nexus.local/simple',
      noProxy: null,
    });
  });
  test('parses double-quoted values', () => {
    const text = 'global.proxy="http://corp:8080"';
    expect(parsePipConfigOutput(text)).toEqual({
      proxy: 'http://corp:8080',
      indexUrl: null,
      noProxy: null,
    });
  });
  test('parses unquoted values', () => {
    const text = 'global.proxy=http://corp:8080';
    expect(parsePipConfigOutput(text).proxy).toBe('http://corp:8080');
  });
  test('returns nulls when no proxy keys present', () => {
    expect(parsePipConfigOutput('')).toEqual({ proxy: null, indexUrl: null, noProxy: null });
  });
});

describe('mergePipProxy', () => {
  const base = { proxy: null, indexUrl: null, noProxy: null };
  test('source = none when nothing set', () => {
    const r = mergePipProxy(base, {});
    expect(r.source).toBe('none');
  });
  test('source = pip when only pip config has values', () => {
    const r = mergePipProxy({ proxy: 'http://a', indexUrl: null, noProxy: null }, {});
    expect(r.source).toBe('pip');
    expect(r.proxyUrl).toBe('http://a');
  });
  test('source = env when only env vars set', () => {
    const r = mergePipProxy(base, { HTTPS_PROXY: 'http://b' });
    expect(r.source).toBe('env');
    expect(r.proxyUrl).toBe('http://b');
  });
  test('source = mixed when both set, pip wins', () => {
    const r = mergePipProxy({ proxy: 'http://pip', indexUrl: null, noProxy: null }, { HTTPS_PROXY: 'http://env' });
    expect(r.source).toBe('mixed');
    expect(r.proxyUrl).toBe('http://pip');
  });
});
