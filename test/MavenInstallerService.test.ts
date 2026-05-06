import {
  parseMajorListing,
  parseVersionListing,
  parseShaFile,
  MavenInstallerService,
} from '../src/services/MavenInstallerService';

describe('Maven parseMajorListing', () => {
  test('extracts canonical maven-N entries', () => {
    const html = `
      <a href="../">../</a>
      <a href="enforcer/">enforcer/</a>
      <a href="maven-1/">maven-1/</a>
      <a href="maven-2/">maven-2/</a>
      <a href="maven-3/">maven-3/</a>
      <a href="maven-4/">maven-4/</a>
      <a href="wagon/">wagon/</a>
    `;
    expect(parseMajorListing(html).map(m => m.major)).toEqual([4, 3, 2, 1]);
  });

  test('future-proof — picks up maven-5 the day Apache publishes it', () => {
    expect(parseMajorListing('<a href="maven-5/">maven-5/</a>').map(m => m.major)).toEqual([5]);
  });

  test('ignores non-canonical sibling subdirs', () => {
    const html = `<a href="enforcer/">x</a><a href="wagon/">y</a><a href="maven-mojo/">z</a>`;
    expect(parseMajorListing(html)).toEqual([]);
  });
});

describe('Maven parseVersionListing', () => {
  test('extracts GA versions only', () => {
    const html = `
      <a href="3.9.6/">x</a>
      <a href="3.9.5/">x</a>
      <a href="4.0.0-beta-3/">beta</a>
      <a href="4.0.0-alpha-12/">alpha</a>
      <a href="4.0.0-rc-1/">rc</a>
    `;
    expect(parseVersionListing(html).sort()).toEqual(['3.9.5', '3.9.6']);
  });
});

describe('Maven parseShaFile', () => {
  test('extracts the digest', () => {
    const text = 'a'.repeat(128) + '  apache-maven-3.9.6-bin.tar.gz\n';
    expect(parseShaFile(text)).toBe('a'.repeat(128));
  });
  test('returns null for malformed input', () => {
    expect(parseShaFile('not a hash')).toBeNull();
  });
});

describe('MavenInstallerService', () => {
  test('cancel() is safe with no install in flight', () => {
    expect(() => new MavenInstallerService().cancel()).not.toThrow();
  });
  test('getInstallRoot returns a per-user path', () => {
    const root = new MavenInstallerService().getInstallRoot();
    expect(root).toMatch(/(rcm[\\/]+mavens|\.rcm[\\/]+mavens)/);
  });
});
