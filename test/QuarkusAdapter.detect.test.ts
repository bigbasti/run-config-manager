import { Uri, __resetFs, __writeFs } from 'vscode';
import { QuarkusAdapter } from '../src/adapters/quarkus/QuarkusAdapter';

const adapter = new QuarkusAdapter();

describe('QuarkusAdapter.detect', () => {
  beforeEach(() => __resetFs());

  test('returns null for empty folder', async () => {
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).toBeNull();
  });

  test('returns null for Spring Boot pom (no quarkus markers)', async () => {
    __writeFs('/proj/pom.xml',
      '<project><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).toBeNull();
  });

  test('detects from Maven pom containing quarkus-maven-plugin', async () => {
    __writeFs('/proj/pom.xml',
      '<project><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    expect(r!.defaults.type).toBe('quarkus');
    expect((r!.defaults.typeOptions as any).buildTool).toBe('maven');
  });

  test('detects from pom referencing io.quarkus', async () => {
    __writeFs('/proj/pom.xml',
      '<project><dependency><groupId>io.quarkus</groupId><artifactId>quarkus-core</artifactId></dependency></project>');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
  });

  test('detects from build.gradle applying io.quarkus plugin', async () => {
    __writeFs('/proj/build.gradle',
      'plugins { id "io.quarkus" version "3.5.0" }');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    expect((r!.defaults.typeOptions as any).buildTool).toBe('gradle');
  });

  test('detects from build.gradle.kts with quarkus BOM', async () => {
    __writeFs('/proj/build.gradle.kts',
      'dependencies { implementation(enforcedPlatform("io.quarkus:quarkus-bom:3.5.0")) }');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
  });

  test('falls back to application.properties with quarkus.* keys when build file lacks markers', async () => {
    __writeFs('/proj/pom.xml', '<project/>');
    __writeFs('/proj/src/main/resources/application.properties',
      'quarkus.http.port=8081\nquarkus.log.level=INFO\n');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
  });

  test('detects from YAML with top-level quarkus: block', async () => {
    __writeFs('/proj/build.gradle', 'plugins {}');
    __writeFs('/proj/src/main/resources/application.yml',
      'quarkus:\n  http:\n    port: 8081\n');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
  });

  test('default debugPort is 5005 and colorOutput is true', async () => {
    __writeFs('/proj/pom.xml',
      '<project><dependency><groupId>io.quarkus</groupId></dependency></project>');
    const r = await adapter.detect(Uri.file('/proj'));
    const to = r!.defaults.typeOptions as any;
    expect(to.debugPort).toBe(5005);
    expect(to.colorOutput).toBe(true);
  });
});
