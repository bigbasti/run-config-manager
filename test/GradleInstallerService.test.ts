import {
  parseGradleVersions,
  parseGradleSha,
  GradleInstallerService,
} from '../src/services/GradleInstallerService';

describe('parseGradleVersions', () => {
  test('keeps GA entries, drops RCs / milestones / nightlies / broken', () => {
    const raw = [
      { version: '8.5', downloadUrl: 'a', checksumUrl: 'a.sha256',
        rcFor: '', milestoneFor: '', nightly: false, snapshot: false, broken: false, current: true },
      { version: '8.6-rc-1', downloadUrl: 'b', checksumUrl: 'b.sha256',
        rcFor: '8.6', milestoneFor: '', nightly: false, snapshot: false, broken: false, current: false },
      { version: '8.6-milestone-1', downloadUrl: 'c', checksumUrl: 'c.sha256',
        rcFor: '', milestoneFor: '8.6', nightly: false, snapshot: false, broken: false, current: false },
      { version: 'nightly', downloadUrl: 'd', checksumUrl: 'd.sha256',
        rcFor: '', milestoneFor: '', nightly: true, snapshot: false, broken: false, current: false },
      { version: '8.4-broken', downloadUrl: 'e', checksumUrl: 'e.sha256',
        rcFor: '', milestoneFor: '', nightly: false, snapshot: false, broken: true, current: false },
      { version: '8.4', downloadUrl: 'f', checksumUrl: 'f.sha256',
        rcFor: '', milestoneFor: '', nightly: false, snapshot: false, broken: false, current: false },
    ];
    const out = parseGradleVersions(raw);
    expect(out.map(v => v.version)).toEqual(['8.5', '8.4']);
    expect(out[0].current).toBe(true);
  });

  test('drops entries missing downloadUrl or checksumUrl', () => {
    const raw = [
      { version: '8.5', downloadUrl: '', checksumUrl: 'sha',
        rcFor: '', milestoneFor: '', nightly: false, snapshot: false, broken: false, current: false },
      { version: '8.4', downloadUrl: 'url', checksumUrl: '',
        rcFor: '', milestoneFor: '', nightly: false, snapshot: false, broken: false, current: false },
    ];
    expect(parseGradleVersions(raw)).toEqual([]);
  });

  test('handles non-array input gracefully', () => {
    expect(parseGradleVersions(null)).toEqual([]);
    expect(parseGradleVersions({})).toEqual([]);
    expect(parseGradleVersions(undefined)).toEqual([]);
  });
});

describe('parseGradleSha', () => {
  test('extracts a 64-char hex digest', () => {
    const text = 'b'.repeat(64);
    expect(parseGradleSha(text)).toBe(text);
  });
  test('returns null for non-hex content', () => {
    expect(parseGradleSha('not a hash')).toBeNull();
  });
});

describe('GradleInstallerService', () => {
  test('cancel() is safe with no install in flight', () => {
    expect(() => new GradleInstallerService().cancel()).not.toThrow();
  });
  test('getInstallRoot returns a per-user path', () => {
    const root = new GradleInstallerService().getInstallRoot();
    expect(root).toMatch(/(rcm[\\/]+gradles|\.rcm[\\/]+gradles)/);
  });
});
