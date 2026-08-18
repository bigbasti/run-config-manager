import { containerIdMatches } from '../src/services/containerMatch';

const FULL = 'a1b2c3d4e5f6' + '0'.repeat(52); // 64 chars, as `docker ps --no-trunc` reports
const SHORT = 'a1b2c3d4e5f6'; // 12 chars, as `docker ps` prints and users copy

describe('containerIdMatches', () => {
  it('matches identical full ids', () => {
    expect(containerIdMatches(FULL, FULL)).toBe(true);
  });

  it('matches a stored short id against a reported full id', () => {
    expect(containerIdMatches(FULL, SHORT)).toBe(true);
  });

  it('matches a stored full id against a reported short id (symmetry contract; --no-trunc means find never sees this)', () => {
    expect(containerIdMatches(SHORT, FULL)).toBe(true);
  });

  it('does not match unrelated ids', () => {
    expect(containerIdMatches(FULL, 'f' + '0'.repeat(63))).toBe(false);
  });

  // Diverges only at the final character of the short form — the boundary that
  // actually exercises prefix matching. The unrelated-ids case above would pass
  // even against an implementation that only compared the first character.
  it('does not match a short id that diverges at the last character', () => {
    expect(containerIdMatches(FULL, 'a1b2c3d4e5f7')).toBe(false);
  });

  it('does not match when the stored id is empty', () => {
    expect(containerIdMatches(FULL, '')).toBe(false);
  });

  // Latent bug fixed by this extraction (never shipped as broken behavior):
  // with summaryId === '', `storedId.startsWith(summaryId)` is true, so a
  // blank row from `docker ps` would otherwise match every stored id.
  it('does not match when the reported id is empty', () => {
    expect(containerIdMatches('', SHORT)).toBe(false);
  });
});
