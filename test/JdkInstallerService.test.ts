import { parseDiscoPackages, JdkInstallerService, SUPPORTED_DISTROS, ChecksumUnavailableError, jdkInstallDirName } from '../src/services/JdkInstallerService';

describe('parseDiscoPackages', () => {
  test('maps foojay fields into JdkPackage shape', () => {
    const body = {
      result: [{
        id: 'abc123',
        distribution: 'zulu',
        distribution_version: '21.0.2',
        jdk_version: 21,
        filename: 'zulu21.30.15-ca-jdk21.0.2-linux_x64.tar.gz',
        size: 187654321,
        term_of_support: 'lts',
        checksum: 'deadbeef',
        checksum_type: 'sha256',
        links: { pkg_download_redirect: 'https://cdn.azul.com/.../zulu21.tar.gz' },
      }],
    };
    const out = parseDiscoPackages(body, 'tar.gz');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 'abc123',
      distro: 'zulu',
      versionLabel: '21.0.2 (LTS)',
      majorVersion: 21,
      filename: 'zulu21.30.15-ca-jdk21.0.2-linux_x64.tar.gz',
      archiveType: 'tar.gz',
      size: 187654321,
      directUrl: 'https://cdn.azul.com/.../zulu21.tar.gz',
      sha256: 'deadbeef',
      lts: true,
    });
  });

  test('drops checksum when type is not sha256', () => {
    const body = {
      result: [{
        id: 'x', distribution: 'zulu', jdk_version: 17,
        filename: 'x.tar.gz', size: 1, term_of_support: 'lts',
        checksum: 'abc', checksum_type: 'sha1',
      }],
    };
    expect(parseDiscoPackages(body, 'tar.gz')[0].sha256).toBeUndefined();
  });

  test('sorts highest major first; LTS before non-LTS within same major', () => {
    const body = {
      result: [
        { id: 'a', distribution: 'd', jdk_version: 17, filename: 'a', size: 0, term_of_support: 'lts' },
        { id: 'b', distribution: 'd', jdk_version: 21, filename: 'b', size: 0, term_of_support: 'mts' },
        { id: 'c', distribution: 'd', jdk_version: 21, filename: 'c', size: 0, term_of_support: 'lts' },
        { id: 'd', distribution: 'd', jdk_version: 11, filename: 'd', size: 0, term_of_support: 'lts' },
      ],
    };
    const out = parseDiscoPackages(body, 'tar.gz');
    expect(out.map(p => p.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  test('handles missing/empty result safely', () => {
    expect(parseDiscoPackages({}, 'tar.gz')).toEqual([]);
    expect(parseDiscoPackages(null, 'tar.gz')).toEqual([]);
    expect(parseDiscoPackages({ result: null }, 'tar.gz')).toEqual([]);
  });

  test('disambiguates colliding labels with variant tags', () => {
    // Three Zulu 21 entries: standard, JavaFX-bundled, CRaC. All share the
    // same distribution_version — without disambiguation the dropdown
    // shows three "Java 21.0.2 (LTS)" lines (the bug the user reported).
    const body = {
      result: [
        { id: 's', distribution: 'zulu', jdk_version: 21, distribution_version: '21.0.2',
          filename: 'zulu-std.tar.gz', size: 1, term_of_support: 'lts' },
        { id: 'fx', distribution: 'zulu', jdk_version: 21, distribution_version: '21.0.2',
          filename: 'zulu-fx.tar.gz', size: 1, term_of_support: 'lts',
          javafx_bundled: true },
        { id: 'crac', distribution: 'zulu', jdk_version: 21, distribution_version: '21.0.2',
          filename: 'zulu-crac.tar.gz', size: 1, term_of_support: 'lts',
          feature: ['crac'] },
      ],
    };
    const out = parseDiscoPackages(body, 'tar.gz');
    expect(out).toHaveLength(3);
    const labels = out.map(p => p.versionLabel);
    // Each distinct now.
    expect(new Set(labels).size).toBe(3);
    expect(labels).toContain('21.0.2 (LTS) (standard)');
    expect(labels).toContain('21.0.2 (LTS) (JavaFX)');
    expect(labels).toContain('21.0.2 (LTS) (CRaC)');
  });

  test('does not disambiguate when there are no collisions', () => {
    const body = {
      result: [{
        id: 'only', distribution: 'temurin', jdk_version: 21, distribution_version: '21.0.2',
        filename: 'temurin.tar.gz', size: 1, term_of_support: 'lts',
      }],
    };
    expect(parseDiscoPackages(body, 'tar.gz')[0].versionLabel).toBe('21.0.2 (LTS)');
  });

  test('drops musl libc variants', () => {
    const body = {
      result: [
        { id: 'glibc', distribution: 'zulu', jdk_version: 21, distribution_version: '21.0.2',
          filename: 'a', size: 1, term_of_support: 'lts', lib_c_type: 'glibc' },
        { id: 'musl', distribution: 'zulu', jdk_version: 21, distribution_version: '21.0.2',
          filename: 'b', size: 1, term_of_support: 'lts', lib_c_type: 'musl' },
      ],
    };
    const out = parseDiscoPackages(body, 'tar.gz');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('glibc');
  });

  test('falls back to direct_download_uri when pkg_download_redirect missing', () => {
    const body = {
      result: [{
        id: 'x', distribution: 'd', jdk_version: 21, filename: 'x', size: 0,
        links: { direct_download_uri: 'https://example.com/x.tar.gz' },
      }],
    };
    expect(parseDiscoPackages(body, 'tar.gz')[0].directUrl).toBe('https://example.com/x.tar.gz');
  });
});

describe('JdkInstallerService', () => {
  test('listDistributions returns curated entries', () => {
    const svc = new JdkInstallerService();
    const list = svc.listDistributions();
    expect(list).toEqual(SUPPORTED_DISTROS);
    const names = list.map(d => d.apiName);
    // Mainstream vendors users actually expect to see.
    expect(names).toEqual(expect.arrayContaining([
      'temurin', 'oracle_open_jdk', 'zulu', 'corretto', 'liberica',
      'microsoft', 'sap_machine', 'semeru',
    ]));
    // GraalVM's CE 17 / 21 split is a foojay quirk; both should be available.
    expect(names).toEqual(expect.arrayContaining(['graalvm_ce17', 'graalvm_ce21']));
  });

  test('cancel() is safe to call when no install is running', () => {
    const svc = new JdkInstallerService();
    expect(() => svc.cancel()).not.toThrow();
  });

  test('ChecksumUnavailableError is exported and identifies the missing-checksum case', () => {
    const e = new ChecksumUnavailableError('test');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ChecksumUnavailableError);
    expect(e.name).toBe('ChecksumUnavailableError');
  });
});

describe('jdkInstallDirName', () => {
  test('produces friendly slugs', () => {
    expect(jdkInstallDirName({ distro: 'zulu', majorVersion: 25 })).toBe('zulu-25');
    expect(jdkInstallDirName({ distro: 'oracle_open_jdk', majorVersion: 22 }))
      .toBe('oracle-open-jdk-22');
    expect(jdkInstallDirName({ distro: 'corretto', majorVersion: 21 })).toBe('corretto-21');
    expect(jdkInstallDirName({ distro: 'temurin', majorVersion: 17 })).toBe('temurin-17');
  });

  test('strips trailing version digits already in the distro slug', () => {
    // Foojay's graalvm_ce17 / graalvm_ce21 split would otherwise produce
    // graalvm-ce17-17 and graalvm-ce21-21.
    expect(jdkInstallDirName({ distro: 'graalvm_ce17', majorVersion: 17 }))
      .toBe('graalvm-ce-17');
    expect(jdkInstallDirName({ distro: 'graalvm_ce21', majorVersion: 21 }))
      .toBe('graalvm-ce-21');
  });
});

