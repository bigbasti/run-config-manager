import { Uri, __resetFs, __writeFs } from 'vscode';
import { findMainClasses } from '../src/adapters/java-shared/findMainClasses';

describe('findMainClasses', () => {
  beforeEach(() => __resetFs());

  test('returns empty for a folder with no source', async () => {
    const out = await findMainClasses(Uri.file('/empty'));
    expect(out).toEqual([]);
  });

  test('detects a single @SpringBootApplication', async () => {
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example;\n@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {}\n}');
    const out = await findMainClasses(Uri.file('/proj'));
    expect(out).toHaveLength(1);
    expect(out[0].fqn).toBe('com.example.App');
    expect(out[0].isSpringBoot).toBe(true);
  });

  test('detects multiple main classes across modules, Spring Boot first', async () => {
    __writeFs('/proj/api/src/main/java/com/api/ApiApp.java',
      'package com.api;\n@SpringBootApplication\npublic class ApiApp { public static void main(String[] a) {} }');
    __writeFs('/proj/util/src/main/java/com/util/Cli.java',
      'package com.util;\npublic class Cli { public static void main(String[] a) {} }');
    const out = await findMainClasses(Uri.file('/proj'));
    expect(out.map(c => c.fqn)).toEqual(['com.api.ApiApp', 'com.util.Cli']);
    expect(out[0].isSpringBoot).toBe(true);
    expect(out[1].isSpringBoot).toBe(false);
  });

  test('detects Kotlin @SpringBootApplication', async () => {
    __writeFs('/proj/src/main/kotlin/com/k/App.kt',
      'package com.k\n@SpringBootApplication\nclass App\nfun main(args: Array<String>) {}');
    const out = await findMainClasses(Uri.file('/proj'));
    expect(out[0].fqn).toBe('com.k.App');
    expect(out[0].isSpringBoot).toBe(true);
  });

  test('skips target/, build/, node_modules/, .git/', async () => {
    __writeFs('/proj/src/main/java/com/a/Good.java',
      'package com.a; @SpringBootApplication public class Good { public static void main(String[] x) {} }');
    __writeFs('/proj/target/classes/com/a/Bad.java',
      'package com.a; public class Bad { public static void main(String[] x) {} }');
    __writeFs('/proj/build/tmp/x.java',
      'package x; public class Y { public static void main(String[] x) {} }');
    __writeFs('/proj/node_modules/foo/src/main/java/a.java',
      'package a; public class B { public static void main(String[] x) {} }');
    const out = await findMainClasses(Uri.file('/proj'));
    expect(out.map(c => c.fqn)).toEqual(['com.a.Good']);
  });

  test('non-@SpringBootApplication classes without main are ignored', async () => {
    __writeFs('/proj/src/main/java/com/a/Helper.java',
      'package com.a; public class Helper { public void doThing() {} }');
    const out = await findMainClasses(Uri.file('/proj'));
    expect(out).toEqual([]);
  });

  test('handles missing package declaration (default package)', async () => {
    __writeFs('/proj/src/main/java/App.java',
      '@SpringBootApplication public class App { public static void main(String[] a) {} }');
    const out = await findMainClasses(Uri.file('/proj'));
    expect(out[0].fqn).toBe('App');
  });
});
