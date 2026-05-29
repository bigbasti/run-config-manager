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

// Precomputed lowercase → values map so the lookup is O(1) and avoids
// scanning Object.keys on every call.
const VALUE_SUGGESTIONS_LOWER = new Map(
  Object.entries(HEADER_VALUE_SUGGESTIONS).map(([k, v]) => [k.toLowerCase(), v])
);

export function valueSuggestionsForKey(key: string): string[] {
  const normalized = key.trim().toLowerCase();
  return normalized ? VALUE_SUGGESTIONS_LOWER.get(normalized) ?? [] : [];
}
