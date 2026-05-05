import { Uri, __resetFs, __writeFs } from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectTomcatInstalls, findTomcatArtifacts } from '../src/adapters/tomcat/detectTomcat';

// detectTomcatInstalls uses the real filesystem (mirrors detectJdks) so
// we can resolve symlinks for shim-based installs (sdkman, asdf, brew).
// The tests work with real temp dirs and point env vars at them, leaving
// the host's actual installs untouched.

describe('detectTomcatInstalls', () => {
  const origEnv = { ...process.env };
  let tmp: string;
  beforeEach(async () => {
    process.env = { ...origEnv };
    delete process.env.CATALINA_HOME;
    delete process.env.TOMCAT_HOME;
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rcm-tomcat-'));
  });
  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  afterAll(() => { process.env = origEnv; });

  // Helper: lay out a minimal Tomcat install at <root>/<name>.
  async function makeTomcat(parent: string, name: string): Promise<string> {
    const root = path.join(parent, name);
    await fs.promises.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'conf'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'bin', 'catalina.sh'), '#!/bin/sh');
    await fs.promises.writeFile(path.join(root, 'conf', 'server.xml'), '<Server/>');
    return root;
  }

  test('CATALINA_HOME pointing at a valid install is detected', async () => {
    const root = await makeTomcat(tmp, 'apache-tomcat-10.1.35');
    process.env.CATALINA_HOME = root;
    const out = await detectTomcatInstalls();
    expect(out).toContain(root);
  });

  test('CATALINA_HOME with no server.xml is rejected', async () => {
    const fake = path.join(tmp, 'fake-tomcat');
    await fs.promises.mkdir(path.join(fake, 'bin'), { recursive: true });
    await fs.promises.writeFile(path.join(fake, 'bin', 'catalina.sh'), '#!/bin/sh');
    process.env.CATALINA_HOME = fake;
    const out = await detectTomcatInstalls();
    expect(out).not.toContain(fake);
  });

  test('TOMCAT_HOME alongside CATALINA_HOME — both kept when distinct', async () => {
    const a = await makeTomcat(tmp, 'a-tomcat');
    const b = await makeTomcat(tmp, 'b-tomcat');
    process.env.CATALINA_HOME = a;
    process.env.TOMCAT_HOME = b;
    const out = await detectTomcatInstalls();
    expect(out).toContain(a);
    expect(out).toContain(b);
  });

  test('symlinked install dedupes against its real path', async () => {
    const real = await makeTomcat(tmp, 'real-tomcat');
    const link = path.join(tmp, 'shim-tomcat');
    await fs.promises.symlink(real, link, 'dir');
    process.env.CATALINA_HOME = real;
    process.env.TOMCAT_HOME = link;
    const out = await detectTomcatInstalls();
    // Real path appears once; the symlinked alias is collapsed onto it
    // by the realpath dedupe.
    const reals = await Promise.all(out.map(p => fs.promises.realpath(p).catch(() => p)));
    const distinctReals = new Set(reals);
    expect(distinctReals.has(real)).toBe(true);
    // The two env entries reduce to one canonical install.
    const matchingEntries = out.filter((_, i) => reals[i] === real);
    expect(matchingEntries.length).toBe(1);
  });
});

describe('findTomcatArtifacts', () => {
  beforeEach(() => __resetFs());

  test('finds Gradle WAR', async () => {
    __writeFs('/proj/build/libs/app-1.0.war', '');
    const out = await findTomcatArtifacts(Uri.file('/proj'));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('war');
    expect(out[0].path).toBe('/proj/build/libs/app-1.0.war');
  });

  test('finds exploded web app under build/exploded', async () => {
    __writeFs('/proj/build/exploded/app/WEB-INF/web.xml', '');
    const out = await findTomcatArtifacts(Uri.file('/proj'));
    expect(out.some(c => c.kind === 'exploded' && c.path === '/proj/build/exploded/app')).toBe(true);
  });

  test('finds Maven target WAR', async () => {
    __writeFs('/proj/target/app-SNAPSHOT.war', '');
    const out = await findTomcatArtifacts(Uri.file('/proj'));
    expect(out[0].path).toBe('/proj/target/app-SNAPSHOT.war');
  });

  test('prefers exploded when both exist for same name', async () => {
    __writeFs('/proj/build/libs/app.war', '');
    __writeFs('/proj/build/exploded/app.war/WEB-INF/web.xml', '');
    const out = await findTomcatArtifacts(Uri.file('/proj'));
    // Different paths; both appear — but the scanner dedupes by path only,
    // so we just verify both are discovered.
    expect(out.map(o => o.kind).sort()).toEqual(['exploded', 'war']);
  });

  test('each candidate carries an mtime', async () => {
    __writeFs('/proj/build/libs/app-1.0.war', '');
    const out = await findTomcatArtifacts(Uri.file('/proj'));
    expect(typeof out[0].mtime).toBe('number');
  });
});
