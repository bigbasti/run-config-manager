import { Uri, __resetFs, __writeFs, extensions } from 'vscode';
import { detectJdks } from '../src/adapters/spring-boot/detectJdks';

describe('detectJdks', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    __resetFs();
    (extensions.getExtension as jest.Mock).mockReset().mockReturnValue(undefined);
    process.env = { ...origEnv };
    delete process.env.JAVA_HOME;
  });
  afterAll(() => { process.env = origEnv; });

  test('returns empty list when no signals', async () => {
    const out = await detectJdks();
    expect(out).toEqual([]);
  });

  test('includes JAVA_HOME when set', async () => {
    process.env.JAVA_HOME = '/opt/custom-jdk';
    const out = await detectJdks();
    expect(out).toContain('/opt/custom-jdk');
  });

  test('includes /usr/lib/jvm entries that have bin/java', async () => {
    __writeFs('/usr/lib/jvm/jdk-21/bin/java', '');
    __writeFs('/usr/lib/jvm/some-dir/nothing', ''); // no bin/java → skipped
    const out = await detectJdks();
    expect(out).toContain('/usr/lib/jvm/jdk-21');
    expect(out).not.toContain('/usr/lib/jvm/some-dir');
  });

  test('uses Java extension when available', async () => {
    (extensions.getExtension as jest.Mock).mockImplementation((id: string) => {
      if (id !== 'redhat.java') return undefined;
      return {
        isActive: true,
        activate: async () => ({
          jdks: [{ path: '/ext/jdk-17' }, { path: '/ext/jdk-21' }],
        }),
      };
    });
    const out = await detectJdks();
    expect(out).toEqual(expect.arrayContaining(['/ext/jdk-17', '/ext/jdk-21']));
  });

  test('dedupes duplicates', async () => {
    process.env.JAVA_HOME = '/opt/jdk';
    __writeFs('/opt/jdk/bin/java', '');
    __writeFs('/usr/lib/jvm/jdk/bin/java', '');
    const out = await detectJdks();
    expect(new Set(out).size).toBe(out.length);
  });
});
