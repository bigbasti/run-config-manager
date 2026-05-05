import {
  parseMajorListing,
  parseVersionListing,
  parseShaFile,
  TomcatInstallerService,
} from '../src/services/TomcatInstallerService';

describe('parseMajorListing', () => {
  test('extracts active major lines from the Apache index', () => {
    // Trimmed snapshot of `https://downloads.apache.org/tomcat/`. The
    // listing also contains tomcat-native, tomcat-connectors, taglibs —
    // we want those filtered out.
    const html = `
      <a href="../">../</a>
      <a href="taglibs/">taglibs/</a>
      <a href="tomcat-9/">tomcat-9/</a>
      <a href="tomcat-10/">tomcat-10/</a>
      <a href="tomcat-11/">tomcat-11/</a>
      <a href="tomcat-connectors/">tomcat-connectors/</a>
      <a href="tomcat-native/">tomcat-native/</a>
    `;
    const out = parseMajorListing(html);
    expect(out.map(m => m.major)).toEqual([11, 10, 9]);
    // Future-proof: when Tomcat 12 is published the parser picks it up
    // without code changes — that's the whole point of data-driven
    // discovery.
    const future = parseMajorListing('<a href="tomcat-12/">tomcat-12/</a>');
    expect(future.map(m => m.major)).toEqual([12]);
  });

  test('ignores non-server subprojects and parent directory links', () => {
    const html = `<a href="../">..</a><a href="taglibs/">x</a><a href="other/">y</a>`;
    expect(parseMajorListing(html)).toEqual([]);
  });
});

describe('parseVersionListing', () => {
  test('extracts GA versions and skips milestones / RCs / alphas / betas', () => {
    const html = `
      <a href="../">../</a>
      <a href="v10.1.34/">v10.1.34/</a>
      <a href="v10.1.35/">v10.1.35/</a>
      <a href="v11.0.0-M22/">milestone</a>
      <a href="v11.0.0-RC1/">rc</a>
      <a href="v11.0.0-alpha/">alpha</a>
      <a href="KEYS">KEYS</a>
    `;
    const out = parseVersionListing(html);
    expect(out.sort()).toEqual(['10.1.34', '10.1.35']);
  });
});

describe('parseShaFile', () => {
  test('extracts the hex digest regardless of trailing filename', () => {
    const text = 'abcdef0123456789'.repeat(8) + '  apache-tomcat-10.1.35.tar.gz\n';
    expect(parseShaFile(text)).toBe('abcdef0123456789'.repeat(8));
  });

  test('returns null for malformed input', () => {
    expect(parseShaFile('not a hash')).toBeNull();
    // Too short — only 127 chars.
    expect(parseShaFile('a'.repeat(127))).toBeNull();
  });
});

describe('TomcatInstallerService', () => {
  test('cancel() is safe with no install in flight', () => {
    const svc = new TomcatInstallerService();
    expect(() => svc.cancel()).not.toThrow();
  });

  test('getInstallRoot returns a per-user path', () => {
    const svc = new TomcatInstallerService();
    const root = svc.getInstallRoot();
    expect(root).toMatch(/(rcm[\\/]+tomcats|\.rcm[\\/]+tomcats)/);
  });
});
