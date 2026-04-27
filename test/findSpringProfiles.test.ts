import { Uri, __resetFs, __writeFs } from 'vscode';
import { findSpringProfiles } from '../src/adapters/spring-boot/findProfiles';

describe('findSpringProfiles', () => {
  beforeEach(() => __resetFs());

  test('empty project → no profiles', async () => {
    __writeFs('/proj/src/main/java/Foo.java', 'class Foo{}');
    expect(await findSpringProfiles(Uri.file('/proj'))).toEqual([]);
  });

  test('picks up application-<profile>.properties filenames', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'x=1');
    __writeFs('/proj/src/main/resources/application-dev.properties', 'foo=1');
    __writeFs('/proj/src/main/resources/application-prod.yml', 'foo: 2');
    const r = await findSpringProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'prod']);
  });

  test('recognises single application-<profile> variant without a base file', async () => {
    // Canonical Spring layout is always trusted, even without application.properties.
    __writeFs('/proj/src/main/resources/application-dev.properties', 'foo=1');
    expect(await findSpringProfiles(Uri.file('/proj'))).toEqual(['dev']);
  });

  test('picks up custom prefix (e.g. queue_watcher-<profile>) with base file', async () => {
    // Mirrors zebra/queue-watcher: @PropertySource points at a custom file
    // name, not application.properties. We surface profiles when there's a
    // same-prefix base file OR ≥2 variants sharing the prefix.
    __writeFs('/proj/src/main/resources/application.properties', 'spring.profiles.active=@x@');
    __writeFs('/proj/src/main/resources/queue_watcher.properties', 'base=1');
    __writeFs('/proj/src/main/resources/queue_watcher-dev.properties', 'x=1');
    __writeFs('/proj/src/main/resources/queue_watcher-prod.properties', 'x=1');
    const r = await findSpringProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'prod']);
  });

  test('picks up custom prefix with 2+ variants even when no base file exists', async () => {
    __writeFs('/proj/src/main/resources/application.properties', '');
    __writeFs('/proj/src/main/resources/queue_watcher-dev.properties', 'x=1');
    __writeFs('/proj/src/main/resources/queue_watcher-prod.properties', 'x=1');
    const r = await findSpringProfiles(Uri.file('/proj'));
    expect(r).toEqual(['dev', 'prod']);
  });

  test('rejects a lone one-off <prefix>-<token>.properties as a profile', async () => {
    // Prevents false positives like schema-users.properties being read as
    // profile "users".
    __writeFs('/proj/src/main/resources/schema-users.properties', 'x=1');
    const r = await findSpringProfiles(Uri.file('/proj'));
    expect(r).toEqual([]);
  });

  test('walks multi-module layouts', async () => {
    __writeFs('/proj/api/src/main/resources/application-api.properties', 'x=1');
    __writeFs('/proj/web/src/main/resources/application-web.properties', 'x=1');
    expect(await findSpringProfiles(Uri.file('/proj'))).toEqual(['api', 'web']);
  });

  test('dedupes across sources and sorts', async () => {
    __writeFs('/proj/a/src/main/resources/application-dev.properties', 'x=1');
    __writeFs('/proj/b/src/main/resources/application-dev.yml', 'x: 1');
    __writeFs('/proj/b/src/main/resources/application-prod.properties', 'x=1');
    expect(await findSpringProfiles(Uri.file('/proj'))).toEqual(['dev', 'prod']);
  });

  test('missing resources/ directory does not throw', async () => {
    __writeFs('/proj/pom.xml', '<project/>');
    await expect(findSpringProfiles(Uri.file('/proj'))).resolves.toEqual([]);
  });
});
