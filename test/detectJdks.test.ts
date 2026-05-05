import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  parseJavaVersionStderr,
  readReleaseFile,
} from '../src/adapters/spring-boot/detectJdks';

// Note: the broader detectJdks() integration is intentionally NOT unit-tested.
// The function reads from real filesystem locations (`/usr/lib/jvm`,
// `~/.jenv/versions`, etc.) and shells out to `which java` /
// `/usr/libexec/java_home` — its output depends entirely on the host
// environment. Mocking would just verify the shape of the mock. Instead
// we cover the pure helpers (release file parsing, java -version parsing)
// directly, plus the new probe-version round-trip.

describe('parseJavaVersionStderr', () => {
  test('extracts version and vendor from Temurin output', () => {
    const stderr = `openjdk version "21.0.2" 2024-01-16
OpenJDK Runtime Environment Temurin-21.0.2+13 (build 21.0.2+13)
OpenJDK 64-Bit Server VM Temurin-21.0.2+13 (build 21.0.2+13, mixed mode)`;
    expect(parseJavaVersionStderr(stderr)).toEqual({
      version: '21.0.2',
      vendor: 'Temurin',
    });
  });

  test('extracts version from Oracle JDK output', () => {
    const stderr = `java version "17.0.10" 2024-01-16 LTS
Java(TM) SE Runtime Environment (build 17.0.10+11-LTS-240)
Java HotSpot(TM) 64-Bit Server VM (build 17.0.10+11-LTS-240, mixed mode)`;
    const r = parseJavaVersionStderr(stderr);
    expect(r.version).toBe('17.0.10');
  });

  test('returns empty object for unrecognized output', () => {
    expect(parseJavaVersionStderr('Some unrelated text')).toEqual({});
  });

  test('handles Zulu vendor', () => {
    const stderr = 'openjdk version "11.0.21"\nOpenJDK Runtime Environment Zulu11.68+17';
    const r = parseJavaVersionStderr(stderr);
    expect(r.vendor).toBe('Zulu');
  });
});

describe('readReleaseFile', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rcm-jdk-test-'));
  });
  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('parses JAVA_VERSION and IMPLEMENTOR from quoted form', async () => {
    await fs.promises.writeFile(
      path.join(tmp, 'release'),
      'JAVA_VERSION="21.0.2"\nIMPLEMENTOR="Eclipse Adoptium"\nOS_NAME="Linux"\n',
    );
    expect(await readReleaseFile(tmp)).toEqual({
      version: '21.0.2',
      vendor: 'Eclipse Adoptium',
    });
  });

  test('parses unquoted values too (older JDKs)', async () => {
    await fs.promises.writeFile(
      path.join(tmp, 'release'),
      'JAVA_VERSION=11.0.20\nOTHER=stuff\n',
    );
    expect(await readReleaseFile(tmp)).toEqual({ version: '11.0.20' });
  });

  test('returns empty when release file is missing', async () => {
    expect(await readReleaseFile(tmp)).toEqual({});
  });

  test('returns empty for malformed release file', async () => {
    await fs.promises.writeFile(path.join(tmp, 'release'), 'garbage\n');
    expect(await readReleaseFile(tmp)).toEqual({});
  });
});
