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

  it('has no duplicate entries', () => {
    expect(new Set(COMMON_HEADERS).size).toBe(COMMON_HEADERS.length);
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

  it('handles leading/trailing whitespace around a valid key', () => {
    expect(valueSuggestionsForKey('  Content-Type  ')).toEqual(valueSuggestionsForKey('Content-Type'));
  });
});

describe('HEADER_VALUE_SUGGESTIONS', () => {
  it('Content-Type has at least 4 values including application/json', () => {
    expect(HEADER_VALUE_SUGGESTIONS['Content-Type'].length).toBeGreaterThanOrEqual(4);
    expect(HEADER_VALUE_SUGGESTIONS['Content-Type']).toContain('application/json');
  });

  it('Accept has at least 3 values', () => {
    expect(HEADER_VALUE_SUGGESTIONS['Accept'].length).toBeGreaterThanOrEqual(3);
  });

  it('Cache-Control has at least 2 values', () => {
    expect(HEADER_VALUE_SUGGESTIONS['Cache-Control'].length).toBeGreaterThanOrEqual(2);
  });

  it('Accept-Language and Accept-Encoding are defined with at least 2 values each', () => {
    expect(HEADER_VALUE_SUGGESTIONS['Accept-Language'].length).toBeGreaterThanOrEqual(2);
    expect(HEADER_VALUE_SUGGESTIONS['Accept-Encoding'].length).toBeGreaterThanOrEqual(2);
  });
});
