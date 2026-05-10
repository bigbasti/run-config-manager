import {
  parseNodeReleases,
  pickNodeAsset,
  parseNodeShasum,
  NodeInstallerService,
} from '../src/services/NodeInstallerService';

describe('parseNodeReleases', () => {
  test('keeps GA versions, sorts newest first, marks current and currentLts', () => {
    const raw = [
      { version: 'v20.10.0', date: '2023-12-01', files: ['linux-x64', 'osx-x64-tar', 'win-x64-zip'], lts: 'Iron' },
      { version: 'v18.19.1', date: '2023-11-01', files: ['linux-x64'], lts: 'Hydrogen' },
      { version: 'v21.5.0',  date: '2024-01-01', files: ['linux-x64'], lts: false },
      { version: 'v20.11.0-rc.0', date: '2024-01-15', files: [], lts: false },
    ];
    const out = parseNodeReleases(raw);
    expect(out.map(v => v.version)).toEqual(['v21.5.0', 'v20.10.0', 'v18.19.1']);
    // The first non-LTS is "current"; first LTS in the (sorted) list is "currentLts".
    expect(out[0].current).toBe(true);
    const lts = out.find(v => v.version === 'v20.10.0')!;
    expect(lts.isLts).toBe(true);
    expect(lts.currentLts).toBe(true);
    // Older LTS isn't tagged currentLts.
    const older = out.find(v => v.version === 'v18.19.1')!;
    expect(older.isLts).toBe(true);
    expect(older.currentLts).toBe(false);
  });

  test('returns [] for non-array input', () => {
    expect(parseNodeReleases(null)).toEqual([]);
    expect(parseNodeReleases({})).toEqual([]);
  });

  test('drops entries with missing version', () => {
    expect(parseNodeReleases([{ date: '2024' }])).toEqual([]);
  });
});

describe('pickNodeAsset', () => {
  test('returns linux-x64 tar.gz on linux/x64', () => {
    expect(pickNodeAsset('v20.10.0', 'linux', 'x64')).toEqual({
      filename: 'node-v20.10.0-linux-x64.tar.gz',
      url: 'https://nodejs.org/dist/v20.10.0/node-v20.10.0-linux-x64.tar.gz',
    });
  });
  test('returns linux-arm64 tar.gz on linux/arm64', () => {
    expect(pickNodeAsset('v18.19.1', 'linux', 'arm64')).toEqual({
      filename: 'node-v18.19.1-linux-arm64.tar.gz',
      url: 'https://nodejs.org/dist/v18.19.1/node-v18.19.1-linux-arm64.tar.gz',
    });
  });
  test('returns darwin-arm64 tar.gz on darwin/arm64', () => {
    expect(pickNodeAsset('v20.10.0', 'darwin', 'arm64')).toEqual({
      filename: 'node-v20.10.0-darwin-arm64.tar.gz',
      url: 'https://nodejs.org/dist/v20.10.0/node-v20.10.0-darwin-arm64.tar.gz',
    });
  });
  test('returns win-x64 zip on win32/x64', () => {
    expect(pickNodeAsset('v20.10.0', 'win32', 'x64')).toEqual({
      filename: 'node-v20.10.0-win-x64.zip',
      url: 'https://nodejs.org/dist/v20.10.0/node-v20.10.0-win-x64.zip',
    });
  });
  test('throws on unsupported platform/arch', () => {
    expect(() => pickNodeAsset('v20.10.0', 'aix' as any, 'ppc64' as any)).toThrow(/unsupported/i);
  });
});

describe('parseNodeShasum', () => {
  test('matches the line whose filename equals the asset', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const c = 'c'.repeat(64);
    const text = [
      `${a}  node-v20.10.0-linux-x64.tar.gz`,
      `${b}  node-v20.10.0-linux-x64.tar.xz`,
      `${c}  node-v20.10.0-darwin-arm64.tar.gz`,
    ].join('\n');
    expect(parseNodeShasum(text, 'node-v20.10.0-linux-x64.tar.gz')).toBe(a);
  });
  test('returns null when filename is absent', () => {
    expect(parseNodeShasum(`${'x'.repeat(64)}  other.tar.gz`, 'missing.tar.xz')).toBeNull();
  });
});

describe('NodeInstallerService', () => {
  test('cancel() is safe with no install in flight', () => {
    expect(() => new NodeInstallerService().cancel()).not.toThrow();
  });
  test('getInstallRoot returns a per-user path', () => {
    const root = new NodeInstallerService().getInstallRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
    expect(root).toMatch(/nodes$/);
  });
});
