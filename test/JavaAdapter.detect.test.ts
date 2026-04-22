import { Uri, __resetFs, __writeFs } from 'vscode';
import { JavaAdapter } from '../src/adapters/java/JavaAdapter';

const adapter = new JavaAdapter();

describe('JavaAdapter.detect', () => {
  beforeEach(() => __resetFs());

  test('returns null for empty folder', async () => {
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).toBeNull();
  });

  test('returns null for Spring Boot project (Spring takes priority)', async () => {
    __writeFs('/proj/pom.xml',
      '<project><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    expect(await adapter.detect(Uri.file('/proj'))).toBeNull();
  });

  test('returns null for Quarkus project', async () => {
    __writeFs('/proj/pom.xml', '<project><dependency><groupId>io.quarkus</groupId></dependency></project>');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    expect(await adapter.detect(Uri.file('/proj'))).toBeNull();
  });

  test('returns null for embedded Tomcat', async () => {
    __writeFs('/proj/pom.xml',
      '<project><dependency><artifactId>tomcat-embed-core</artifactId></dependency></project>');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    expect(await adapter.detect(Uri.file('/proj'))).toBeNull();
  });

  test('detects plain Maven Java project', async () => {
    __writeFs('/proj/pom.xml', '<project><groupId>com.example</groupId></project>');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    expect(r!.defaults.type).toBe('java');
    const to = r!.defaults.typeOptions as any;
    expect(to.launchMode).toBe('maven');
    expect(to.buildTool).toBe('maven');
    expect(to.mainClass).toBe('com.example.App');
  });

  test('detects plain Gradle Java project with application plugin', async () => {
    __writeFs('/proj/build.gradle',
      'plugins { id "application" }\napplication { mainClass = "com.example.App" }');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    const to = r!.defaults.typeOptions as any;
    expect(to.launchMode).toBe('gradle');
    expect((r!.context as any).hasApplicationPlugin).toBe(true);
  });

  test('bare source tree (no build file) defaults to java-main', async () => {
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    const to = r!.defaults.typeOptions as any;
    expect(to.launchMode).toBe('java-main');
  });

  test('defaults include debugPort 5005 and colorOutput true', async () => {
    __writeFs('/proj/pom.xml', '<project><groupId>com.example</groupId></project>');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\npublic class App { public static void main(String[] args) {} }');
    const to = (await adapter.detect(Uri.file('/proj')))!.defaults.typeOptions as any;
    expect(to.debugPort).toBe(5005);
    expect(to.colorOutput).toBe(true);
  });
});
