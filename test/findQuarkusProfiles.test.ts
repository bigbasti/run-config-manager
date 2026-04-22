import { Uri, __resetFs, __writeFs } from 'vscode';
import { findQuarkusProfiles } from '../src/adapters/quarkus/findQuarkusProfiles';

describe('findQuarkusProfiles', () => {
  beforeEach(() => __resetFs());

  test('empty project → no profiles', async () => {
    __writeFs('/proj/src/main/java/Foo.java', 'class Foo{}');
    expect(await findQuarkusProfiles(Uri.file('/proj'))).toEqual([]);
  });

  test('picks up application-<profile>.properties filenames', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'quarkus.log.level=INFO');
    __writeFs('/proj/src/main/resources/application-dev.properties', 'foo=1');
    __writeFs('/proj/src/main/resources/application-prod.yml', 'foo: 2');
    const r = await findQuarkusProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'prod']);
  });

  test('parses %<profile>. prefixed keys in application.properties', async () => {
    __writeFs('/proj/src/main/resources/application.properties', [
      'quarkus.log.level=INFO',
      '%dev.quarkus.http.port=8081',
      '%prod.quarkus.http.port=8080',
      '%staging.quarkus.log.level=DEBUG',
    ].join('\n'));
    const r = await findQuarkusProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'prod', 'staging']);
  });

  test('parses top-level %<profile>: blocks in YAML', async () => {
    __writeFs('/proj/src/main/resources/application.yml', [
      'quarkus:',
      '  http:',
      '    port: 8080',
      '"%dev":',
      '  quarkus:',
      '    http:',
      '      port: 8081',
    ].join('\n'));
    const r = await findQuarkusProfiles(Uri.file('/proj'));
    expect(r).toContain('dev');
  });

  test('dedupes across sources and sorts', async () => {
    __writeFs('/proj/src/main/resources/application.properties',
      '%dev.foo=1\n%staging.foo=2\n');
    __writeFs('/proj/src/main/resources/application-dev.yml', 'x: 1');
    __writeFs('/proj/src/main/resources/application-prod.properties', 'x=1');
    const r = await findQuarkusProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'prod', 'staging']);
  });

  test('walks multi-module layouts', async () => {
    __writeFs('/proj/api/src/main/resources/application-api.properties', 'x=1');
    __writeFs('/proj/web/src/main/resources/application-web.properties', 'x=1');
    const r = await findQuarkusProfiles(Uri.file('/proj'));
    expect(r).toEqual(['api', 'web']);
  });

  test('splits multi-profile property prefixes (Quarkus syntax %"dev,test")', async () => {
    __writeFs('/proj/src/main/resources/application.properties',
      '%"dev,test".foo=1\n');
    const r = await findQuarkusProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'test']);
  });

  test('missing resources/ directory does not throw', async () => {
    __writeFs('/proj/pom.xml', '<project/>');
    await expect(findQuarkusProfiles(Uri.file('/proj'))).resolves.toEqual([]);
  });
});
