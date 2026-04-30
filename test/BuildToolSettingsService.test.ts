import * as path from 'path';
import * as os from 'os';
import {
  BuildToolSettingsService,
  parseMavenProxy,
  parseGradleProxy,
  parsePropertiesFile,
  parseProxyUrl,
} from '../src/services/BuildToolSettingsService';
import { Uri } from 'vscode';

// These helpers come from the vscode mock in __mocks__. Importing via the
// shimmed module keeps the same fs surface the service uses.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mock = require('vscode') as typeof import('vscode') & {
  __writeFs: (p: string, data: string) => void;
  __resetFs: () => void;
};

describe('parseMavenProxy', () => {
  test('picks active=true proxy', () => {
    const xml = `
      <settings>
        <proxies>
          <proxy>
            <id>corp</id>
            <active>true</active>
            <host>proxy.corp.internal</host>
            <port>8080</port>
          </proxy>
        </proxies>
      </settings>`;
    expect(parseMavenProxy(xml)).toEqual({
      host: 'proxy.corp.internal', port: 8080, nonProxyHosts: null,
    });
  });

  test('captures nonProxyHosts from active proxy', () => {
    const xml = `
      <settings><proxies><proxy>
        <active>true</active>
        <host>proxy.corp</host>
        <port>8080</port>
        <nonProxyHosts>localhost|*.internal|127.0.0.1</nonProxyHosts>
      </proxy></proxies></settings>`;
    expect(parseMavenProxy(xml)).toEqual({
      host: 'proxy.corp', port: 8080, nonProxyHosts: 'localhost|*.internal|127.0.0.1',
    });
  });

  test('treats missing <active> as active=true', () => {
    const xml = `
      <settings>
        <proxies>
          <proxy>
            <host>implicit.proxy</host>
            <port>3128</port>
          </proxy>
        </proxies>
      </settings>`;
    expect(parseMavenProxy(xml)).toEqual({ host: 'implicit.proxy', port: 3128, nonProxyHosts: null });
  });

  test('skips inactive proxies and returns first active', () => {
    const xml = `
      <settings>
        <proxies>
          <proxy>
            <active>false</active>
            <host>disabled.proxy</host>
            <port>1111</port>
          </proxy>
          <proxy>
            <active>true</active>
            <host>winner.proxy</host>
            <port>2222</port>
          </proxy>
          <proxy>
            <active>true</active>
            <host>later.proxy</host>
            <port>3333</port>
          </proxy>
        </proxies>
      </settings>`;
    const r = parseMavenProxy(xml);
    expect(r).toEqual({ host: 'winner.proxy', port: 2222, nonProxyHosts: null });
  });

  test('ignores proxies inside XML comments', () => {
    const xml = `
      <settings>
        <proxies>
          <!--
          <proxy>
            <active>true</active>
            <host>commented.proxy</host>
            <port>9999</port>
          </proxy>
          -->
        </proxies>
      </settings>`;
    expect(parseMavenProxy(xml)).toBeNull();
  });

  test('host without port returns a note', () => {
    const xml = `
      <settings><proxies><proxy>
        <active>true</active><host>only-host</host>
      </proxy></proxies></settings>`;
    const r = parseMavenProxy(xml);
    expect(r).toMatchObject({ host: 'only-host', port: null });
    expect(r?.note).toMatch(/port/i);
  });

  test('no proxies at all returns null', () => {
    expect(parseMavenProxy('<settings></settings>')).toBeNull();
  });
});

describe('parsePropertiesFile', () => {
  test('reads key=value with = and : separators', () => {
    const out = parsePropertiesFile('foo=1\nbar:2\nbaz 3');
    expect(out).toEqual({ foo: '1', bar: '2', baz: '3' });
  });

  test('skips # and ! comments and blank lines', () => {
    const out = parsePropertiesFile('# comment\n! another\n\nfoo=1');
    expect(out).toEqual({ foo: '1' });
  });

  test('folds backslash line continuations', () => {
    const out = parsePropertiesFile('key=part1\\\npart2');
    expect(out).toEqual({ key: 'part1part2' });
  });
});

describe('parseGradleProxy', () => {
  test('reads http proxy host and port', () => {
    const text = `
# Gradle proxy settings
systemProp.http.proxyHost=proxy.example.com
systemProp.http.proxyPort=8080
    `;
    expect(parseGradleProxy(text)).toEqual({
      host: 'proxy.example.com', port: 8080, nonProxyHosts: null,
    });
  });

  test('captures systemProp.http.nonProxyHosts', () => {
    const text = `
systemProp.http.proxyHost=proxy.corp
systemProp.http.proxyPort=8080
systemProp.http.nonProxyHosts=localhost|*.internal
    `;
    expect(parseGradleProxy(text)).toEqual({
      host: 'proxy.corp', port: 8080, nonProxyHosts: 'localhost|*.internal',
    });
  });

  test('returns nonProxyHosts even without host/port', () => {
    const text = 'systemProp.http.nonProxyHosts=only.nonproxy';
    expect(parseGradleProxy(text)).toMatchObject({
      host: null, port: null, nonProxyHosts: 'only.nonproxy',
    });
  });

  test('falls back to https when http not set', () => {
    const text = `
systemProp.https.proxyHost=secure.proxy
systemProp.https.proxyPort=8443
    `;
    expect(parseGradleProxy(text)).toEqual({
      host: 'secure.proxy', port: 8443, nonProxyHosts: null,
    });
  });

  test('prefers http over https when both present', () => {
    const text = `
systemProp.http.proxyHost=http.proxy
systemProp.http.proxyPort=80
systemProp.https.proxyHost=https.proxy
systemProp.https.proxyPort=443
    `;
    expect(parseGradleProxy(text)).toEqual({
      host: 'http.proxy', port: 80, nonProxyHosts: null,
    });
  });

  test('returns null when neither set', () => {
    expect(parseGradleProxy('org.gradle.jvmargs=-Xmx2g')).toBeNull();
  });

  test('host without port returns a note', () => {
    const text = 'systemProp.http.proxyHost=only.host';
    const r = parseGradleProxy(text);
    expect(r).toMatchObject({ host: 'only.host', port: null });
    expect(r?.note).toMatch(/port/i);
  });
});

describe('parseProxyUrl', () => {
  test('parses full URL with port', () => {
    expect(parseProxyUrl('http://proxy.corp:8080')).toEqual({ host: 'proxy.corp', port: 8080 });
  });

  test('strips credentials', () => {
    expect(parseProxyUrl('http://user:pass@proxy.corp:8080'))
      .toEqual({ host: 'proxy.corp', port: 8080 });
  });

  test('parses bare host:port without scheme', () => {
    expect(parseProxyUrl('proxy.corp:3128')).toEqual({ host: 'proxy.corp', port: 3128 });
  });

  test('returns null port when URL omits it', () => {
    expect(parseProxyUrl('http://proxy.corp')).toEqual({ host: 'proxy.corp', port: null });
  });

  test('returns host=null with note for garbage input', () => {
    const r = parseProxyUrl('http://:::::');
    expect(r.host).toBeNull();
    expect(r.note).toMatch(/could not parse/i);
  });
});

describe('BuildToolSettingsService npm (env-var)', () => {
  const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
  let prev: Record<string, string | undefined>;
  let svc: BuildToolSettingsService;
  beforeEach(() => {
    prev = {};
    for (const k of PROXY_ENV) { prev[k] = process.env[k]; delete process.env[k]; }
    svc = new BuildToolSettingsService();
  });
  afterEach(() => {
    for (const k of PROXY_ENV) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  test('returns empty result when no env vars set', async () => {
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.buildTool).toBe('npm');
    expect(r.activeFilePath).toBeUndefined();
    expect(r.sourceLabel).toBeUndefined();
    expect(r.proxyHost).toBeNull();
    expect(r.proxyPort).toBeNull();
    expect(r.nonProxyHosts).toBeNull();
  });

  test('reads HTTP_PROXY when only HTTP is set', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.sourceLabel).toBe('HTTP_PROXY env var');
    expect(r.proxyHost).toBe('proxy.example.com');
    expect(r.proxyPort).toBe(8080);
  });

  test('prefers HTTPS_PROXY over HTTP_PROXY when both set', async () => {
    process.env.HTTP_PROXY = 'http://plain:80';
    process.env.HTTPS_PROXY = 'http://secure:443';
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.sourceLabel).toBe('HTTPS_PROXY env var');
    expect(r.proxyHost).toBe('secure');
    expect(r.proxyPort).toBe(443);
  });

  test('includes NO_PROXY as nonProxyHosts', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'localhost,.internal,127.0.0.1';
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.nonProxyHosts).toBe('localhost,.internal,127.0.0.1');
  });

  test('shows only NO_PROXY when that is all that is set', async () => {
    process.env.NO_PROXY = 'localhost';
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.nonProxyHosts).toBe('localhost');
    expect(r.proxyHost).toBeNull();
    expect(r.proxyPort).toBeNull();
    // Source label falls back to HTTP_PROXY since neither HTTPS nor HTTP is set;
    // it stays undefined because there's no upstream proxy value to attribute.
    expect(r.sourceLabel).toBeUndefined();
  });

  test('accepts lower-case env vars', async () => {
    process.env.http_proxy = 'proxy.corp:3128';
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.proxyHost).toBe('proxy.corp');
    expect(r.proxyPort).toBe(3128);
  });

  test('strips credentials from proxy URL', async () => {
    process.env.HTTPS_PROXY = 'http://user:secret@proxy.corp:8080';
    const r = await svc.load('npm', Uri.file('/proj'));
    expect(r.proxyHost).toBe('proxy.corp');
    expect(r.proxyPort).toBe(8080);
  });
});

describe('BuildToolSettingsService.load', () => {
  let svc: BuildToolSettingsService;
  beforeEach(() => {
    mock.__resetFs();
    svc = new BuildToolSettingsService();
  });

  test('maven: reads user ~/.m2/settings.xml when present', async () => {
    const userFile = path.join(os.homedir(), '.m2', 'settings.xml');
    mock.__writeFs(userFile, `
      <settings><proxies><proxy>
        <active>true</active><host>user.proxy</host><port>8080</port>
      </proxy></proxies></settings>`);
    const r = await svc.load('maven', Uri.file('/unused'));
    expect(r.activeFilePath).toBe(userFile);
    expect(r.proxyHost).toBe('user.proxy');
    expect(r.proxyPort).toBe(8080);
  });

  test('maven: falls back to $MAVEN_HOME/conf/settings.xml', async () => {
    const prev = process.env.MAVEN_HOME;
    process.env.MAVEN_HOME = '/opt/maven';
    try {
      const globalFile = '/opt/maven/conf/settings.xml';
      mock.__writeFs(globalFile, `
        <settings><proxies><proxy>
          <host>global.proxy</host><port>3128</port>
        </proxy></proxies></settings>`);
      const r = await svc.load('maven', Uri.file('/unused'));
      expect(r.activeFilePath).toBe(globalFile);
      expect(r.proxyHost).toBe('global.proxy');
    } finally {
      if (prev === undefined) delete process.env.MAVEN_HOME;
      else process.env.MAVEN_HOME = prev;
    }
  });

  test('maven: selected mavenPath overrides MAVEN_HOME for global fallback', async () => {
    // User has no ~/.m2/settings.xml; the install the form picked contains one.
    const selectedInstall = '/opt/apache-maven-3.9.6';
    const globalFile = '/opt/apache-maven-3.9.6/conf/settings.xml';
    mock.__writeFs(globalFile, `
      <settings><proxies><proxy>
        <host>selected.install.proxy</host><port>5555</port>
      </proxy></proxies></settings>`);
    const r = await svc.load('maven', Uri.file('/unused'), { mavenPath: selectedInstall });
    expect(r.activeFilePath).toBe(globalFile);
    expect(r.proxyHost).toBe('selected.install.proxy');
    expect(r.proxyPort).toBe(5555);
  });

  test('maven: switching mavenPath picks up the new install settings', async () => {
    const installA = '/opt/maven-a';
    const installB = '/opt/maven-b';
    mock.__writeFs('/opt/maven-a/conf/settings.xml', `
      <settings><proxies><proxy><host>a</host><port>1</port></proxy></proxies></settings>`);
    mock.__writeFs('/opt/maven-b/conf/settings.xml', `
      <settings><proxies><proxy><host>b</host><port>2</port></proxy></proxies></settings>`);
    const ra = await svc.load('maven', Uri.file('/unused'), { mavenPath: installA });
    const rb = await svc.load('maven', Uri.file('/unused'), { mavenPath: installB });
    expect(ra.proxyHost).toBe('a');
    expect(rb.proxyHost).toBe('b');
  });

  test('maven: user file active, install global listed as overridden', async () => {
    const userFile = path.join(os.homedir(), '.m2', 'settings.xml');
    const globalFile = '/opt/apache-maven/conf/settings.xml';
    mock.__writeFs(userFile, `
      <settings><proxies><proxy><host>user.proxy</host><port>1000</port></proxy></proxies></settings>`);
    mock.__writeFs(globalFile, `
      <settings><proxies><proxy><host>install.proxy</host><port>2000</port></proxy></proxies></settings>`);
    const r = await svc.load('maven', Uri.file('/unused'), { mavenPath: '/opt/apache-maven' });
    expect(r.activeFilePath).toBe(userFile);
    expect(r.proxyHost).toBe('user.proxy');
    expect(r.overriddenFiles).toEqual([
      expect.objectContaining({
        filePath: globalFile,
        proxyHost: 'install.proxy',
        proxyPort: 2000,
        tier: 'Maven global (selected install)',
      }),
    ]);
  });

  test('maven: no overrides when only active file exists', async () => {
    const userFile = path.join(os.homedir(), '.m2', 'settings.xml');
    mock.__writeFs(userFile, `<settings><proxies><proxy><host>only</host><port>1</port></proxy></proxies></settings>`);
    const r = await svc.load('maven', Uri.file('/unused'));
    expect(r.overriddenFiles).toEqual([]);
  });

  test('maven: none found reports searched paths', async () => {
    const r = await svc.load('maven', Uri.file('/unused'));
    expect(r.activeFilePath).toBeUndefined();
    expect(r.proxyHost).toBeNull();
    expect(r.proxyPort).toBeNull();
    expect(r.searchedPaths.length).toBeGreaterThan(0);
    expect(r.note).toMatch(/no settings\.xml/i);
  });

  test('gradle: user gradle.properties wins over project', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    delete process.env.GRADLE_USER_HOME;
    try {
      const userFile = path.join(os.homedir(), '.gradle', 'gradle.properties');
      const projectFile = '/proj/gradle.properties';
      mock.__writeFs(userFile, 'systemProp.http.proxyHost=user.proxy\nsystemProp.http.proxyPort=9000');
      mock.__writeFs(projectFile, 'systemProp.http.proxyHost=project.proxy\nsystemProp.http.proxyPort=1000');
      const r = await svc.load('gradle', Uri.file('/proj'));
      expect(r.activeFilePath).toBe(userFile);
      expect(r.proxyHost).toBe('user.proxy');
      expect(r.proxyPort).toBe(9000);
    } finally {
      if (prev !== undefined) process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: falls back to project file when user missing', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    delete process.env.GRADLE_USER_HOME;
    try {
      const projectFile = '/proj/gradle.properties';
      mock.__writeFs(projectFile, 'systemProp.http.proxyHost=proj.proxy\nsystemProp.http.proxyPort=8888');
      const r = await svc.load('gradle', Uri.file('/proj'));
      expect(r.activeFilePath).toBe(projectFile);
      expect(r.proxyHost).toBe('proj.proxy');
      expect(r.proxyPort).toBe(8888);
    } finally {
      if (prev !== undefined) process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: respects GRADLE_USER_HOME env override', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    process.env.GRADLE_USER_HOME = '/custom/gradle-home';
    try {
      const userFile = '/custom/gradle-home/gradle.properties';
      mock.__writeFs(userFile, 'systemProp.http.proxyHost=env.proxy\nsystemProp.http.proxyPort=7777');
      const r = await svc.load('gradle', Uri.file('/proj'));
      expect(r.activeFilePath).toBe(userFile);
      expect(r.proxyHost).toBe('env.proxy');
    } finally {
      if (prev === undefined) delete process.env.GRADLE_USER_HOME;
      else process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: picks $gradlePath/gradle.properties as lowest-precedence fallback', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    delete process.env.GRADLE_USER_HOME;
    try {
      const installFile = '/opt/gradle-8.5/gradle.properties';
      mock.__writeFs(installFile, 'systemProp.http.proxyHost=install.proxy\nsystemProp.http.proxyPort=1111');
      const r = await svc.load('gradle', Uri.file('/proj'), { gradlePath: '/opt/gradle-8.5' });
      expect(r.activeFilePath).toBe(installFile);
      expect(r.proxyHost).toBe('install.proxy');
      expect(r.proxyPort).toBe(1111);
    } finally {
      if (prev !== undefined) process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: project file still wins over install file', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    delete process.env.GRADLE_USER_HOME;
    try {
      mock.__writeFs('/proj/gradle.properties', 'systemProp.http.proxyHost=proj.proxy\nsystemProp.http.proxyPort=8888');
      mock.__writeFs('/opt/gradle-8.5/gradle.properties', 'systemProp.http.proxyHost=install.proxy\nsystemProp.http.proxyPort=9999');
      const r = await svc.load('gradle', Uri.file('/proj'), { gradlePath: '/opt/gradle-8.5' });
      expect(r.activeFilePath).toBe('/proj/gradle.properties');
      expect(r.proxyHost).toBe('proj.proxy');
    } finally {
      if (prev !== undefined) process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: user wins, project + install listed as overridden with their own values', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    delete process.env.GRADLE_USER_HOME;
    try {
      const userFile = path.join(os.homedir(), '.gradle', 'gradle.properties');
      const projectFile = '/proj/gradle.properties';
      const installFile = '/opt/gradle-8.5/gradle.properties';
      mock.__writeFs(userFile, 'systemProp.http.proxyHost=user.proxy\nsystemProp.http.proxyPort=9000');
      mock.__writeFs(projectFile, 'systemProp.http.proxyHost=proj.proxy\nsystemProp.http.proxyPort=8000');
      mock.__writeFs(installFile, 'systemProp.http.proxyHost=install.proxy\nsystemProp.http.proxyPort=7000');
      const r = await svc.load('gradle', Uri.file('/proj'), { gradlePath: '/opt/gradle-8.5' });
      expect(r.activeFilePath).toBe(userFile);
      expect(r.proxyHost).toBe('user.proxy');
      expect(r.overriddenFiles).toEqual([
        expect.objectContaining({
          filePath: projectFile,
          proxyHost: 'proj.proxy',
          proxyPort: 8000,
          tier: 'Gradle project root',
        }),
        expect.objectContaining({
          filePath: installFile,
          proxyHost: 'install.proxy',
          proxyPort: 7000,
          tier: 'Gradle install',
        }),
      ]);
    } finally {
      if (prev !== undefined) process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: switching install surfaces different overridden install file', async () => {
    const prev = process.env.GRADLE_USER_HOME;
    delete process.env.GRADLE_USER_HOME;
    try {
      const userFile = path.join(os.homedir(), '.gradle', 'gradle.properties');
      mock.__writeFs(userFile, 'systemProp.http.proxyHost=user.proxy\nsystemProp.http.proxyPort=9000');
      mock.__writeFs('/opt/gradle-7/gradle.properties', 'systemProp.http.proxyHost=g7\nsystemProp.http.proxyPort=700');
      mock.__writeFs('/opt/gradle-8/gradle.properties', 'systemProp.http.proxyHost=g8\nsystemProp.http.proxyPort=800');
      const r7 = await svc.load('gradle', Uri.file('/proj'), { gradlePath: '/opt/gradle-7' });
      const r8 = await svc.load('gradle', Uri.file('/proj'), { gradlePath: '/opt/gradle-8' });
      // Active stays the user file in both cases.
      expect(r7.activeFilePath).toBe(userFile);
      expect(r8.activeFilePath).toBe(userFile);
      // But the overridden list picks up the selected install each time.
      expect(r7.overriddenFiles.find(f => f.tier === 'Gradle install')?.proxyHost).toBe('g7');
      expect(r8.overriddenFiles.find(f => f.tier === 'Gradle install')?.proxyHost).toBe('g8');
    } finally {
      if (prev !== undefined) process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: dedupes when GRADLE_USER_HOME points at the install dir', async () => {
    // Repro of the field report: GRADLE_USER_HOME=/opt/gradle/gradle-7.6.2
    // (the install root, not ~/.gradle). Both "user home" and "install"
    // candidates resolve to the same file, which used to render it twice.
    const prev = process.env.GRADLE_USER_HOME;
    process.env.GRADLE_USER_HOME = '/opt/gradle/gradle-7.6.2';
    try {
      const file = '/opt/gradle/gradle-7.6.2/gradle.properties';
      mock.__writeFs(file, 'systemProp.http.proxyHost=corp\nsystemProp.http.proxyPort=8080');
      const r = await svc.load('gradle', Uri.file('/proj'), { gradlePath: '/opt/gradle/gradle-7.6.2' });
      expect(r.activeFilePath).toBe(file);
      expect(r.overriddenFiles).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.GRADLE_USER_HOME;
      else process.env.GRADLE_USER_HOME = prev;
    }
  });

  test('gradle: none found reports searched paths', async () => {
    const r = await svc.load('gradle', Uri.file('/proj'));
    expect(r.activeFilePath).toBeUndefined();
    expect(r.proxyHost).toBeNull();
    expect(r.searchedPaths.length).toBe(2);
    expect(r.note).toMatch(/no gradle\.properties/i);
  });
});
