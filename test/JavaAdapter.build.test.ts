import { Uri } from 'vscode';
import { JavaAdapter } from '../src/adapters/java/JavaAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new JavaAdapter();

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'dddddddd-1111-2222-3333-444444444444',
    name: 'x',
    type: 'java' as const,
    projectPath: 'backend',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      launchMode: 'maven' as const,
      buildTool: 'maven' as const,
      gradleCommand: './gradlew' as const,
      mainClass: 'com.example.Main',
      classpath: '',
      jdkPath: '',
      module: '',
      gradlePath: '',
      mavenPath: '',
      buildRoot: '',
    },
  };
  return {
    ...base,
    ...overrides,
    typeOptions: { ...base.typeOptions, ...(overrides.typeOptions ?? {}) },
  } as RunConfig;
}

describe('JavaAdapter.buildCommand (Maven)', () => {
  test('basic mvn exec:java -Dexec.mainClass=<FQN>', () => {
    const r = adapter.buildCommand(cfg());
    expect(r.command).toBe('mvn');
    expect(r.args).toEqual(['exec:java', '-Dexec.mainClass=com.example.Main']);
  });

  test('uses mvnPath binary when set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { mavenPath: '/opt/maven/apache-maven-3.9.6' } }));
    expect(r.command).toBe('/opt/maven/apache-maven-3.9.6/bin/mvn');
  });

  test('passes program args via -Dexec.args', () => {
    const r = adapter.buildCommand(cfg({ programArgs: '--config=dev.yml -v' }));
    expect(r.args.some(a => a.startsWith("-Dexec.args='--config=dev.yml -v'"))).toBe(true);
  });

  test('vmArgs are NOT passed in maven mode', () => {
    const r = adapter.buildCommand(cfg({ vmArgs: '-Xmx2g' }));
    // No flag of any kind carrying the VM args — they'd be silently dropped
    // in the Maven JVM anyway, so we don't pretend to forward them.
    expect(r.args.find(a => a.includes('-Xmx2g'))).toBeUndefined();
    expect(r.args.find(a => a.includes('jvm'))).toBeUndefined();
  });
});

describe('JavaAdapter.buildCommand (Gradle)', () => {
  const gradleCfg = (overrides: any = {}) => {
    const { typeOptions: toOverrides, ...rest } = overrides;
    return cfg({
      ...rest,
      typeOptions: { launchMode: 'gradle', buildTool: 'gradle', ...(toOverrides ?? {}) },
    });
  };

  test('basic ./gradlew --console=plain run', () => {
    const r = adapter.buildCommand(gradleCfg());
    expect(r.command).toBe('./gradlew');
    expect(r.args.slice(0, 2)).toEqual(['--console=plain', 'run']);
  });

  test('does NOT pass -Dexec.mainClass in gradle mode (plugin reads it from build.gradle)', () => {
    const r = adapter.buildCommand(gradleCfg());
    expect(r.args.find(a => a.startsWith('-Dexec.mainClass'))).toBeUndefined();
  });

  test('uses system gradle when gradleCommand is "gradle"', () => {
    const r = adapter.buildCommand(gradleCfg({ typeOptions: { gradleCommand: 'gradle' } }));
    expect(r.command).toBe('gradle');
  });

  test('uses gradlePath binary when provided', () => {
    const r = adapter.buildCommand(gradleCfg({
      typeOptions: { gradleCommand: 'gradle', gradlePath: '/opt/gradle/gradle-8.5' },
    }));
    expect(r.command).toBe('/opt/gradle/gradle-8.5/bin/gradle');
  });

  test('scopes run with :module: prefix in multi-module Gradle build', () => {
    const r = adapter.buildCommand(
      gradleCfg({
        projectPath: 'tools/importer',
        typeOptions: { buildRoot: '/git/demo' },
      }),
      { uri: Uri.file('/git/demo'), name: 'demo', index: 0 } as any,
    );
    expect(r.args).toContain(':tools:importer:run');
    expect(r.args).not.toContain('run');
  });

  test('passes program args via --args', () => {
    const r = adapter.buildCommand(gradleCfg({ programArgs: '--input=/tmp/file.csv' }));
    expect(r.args.some(a => a.startsWith("--args='--input=/tmp/file.csv'"))).toBe(true);
  });

  test('vmArgs are NOT passed in gradle mode', () => {
    const r = adapter.buildCommand(gradleCfg({ vmArgs: '-Xmx2g' }));
    expect(r.args.find(a => a.includes('-Xmx2g'))).toBeUndefined();
  });
});

describe('JavaAdapter.buildCommand (java-main)', () => {
  const mainCfg = (overrides: any = {}) => {
    const { typeOptions: toOverrides, ...rest } = overrides;
    return cfg({
      ...rest,
      typeOptions: { launchMode: 'java-main', classpath: 'target/classes', ...(toOverrides ?? {}) },
    });
  };

  test('basic java -cp <classpath> <mainClass>', () => {
    const r = adapter.buildCommand(mainCfg());
    expect(r.command).toBe('java');
    expect(r.args).toEqual(['-cp', 'target/classes', 'com.example.Main']);
  });

  test('uses jdkPath/bin/java when set', () => {
    const r = adapter.buildCommand(mainCfg({ typeOptions: { jdkPath: '/opt/jdk-21' } }));
    expect(r.command).toBe('/opt/jdk-21/bin/java');
  });

  test('vmArgs appear BEFORE -cp and mainClass', () => {
    const r = adapter.buildCommand(mainCfg({ vmArgs: '-Xmx1g -Dfoo=bar' }));
    const cpIdx = r.args.indexOf('-cp');
    const xmxIdx = r.args.indexOf('-Xmx1g');
    expect(xmxIdx).toBeGreaterThanOrEqual(0);
    expect(xmxIdx).toBeLessThan(cpIdx);
  });

  test('program args appear AFTER mainClass', () => {
    const r = adapter.buildCommand(mainCfg({ programArgs: '--foo bar' }));
    const mainIdx = r.args.indexOf('com.example.Main');
    const fooIdx = r.args.indexOf('--foo');
    expect(fooIdx).toBeGreaterThan(mainIdx);
  });

  test('omits -cp when classpath is blank', () => {
    const r = adapter.buildCommand(mainCfg({ typeOptions: { classpath: '   ' } }));
    expect(r.args).not.toContain('-cp');
  });
});

describe('JavaAdapter.getDebugConfig', () => {
  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

  test('java-main returns launch config with classPaths', () => {
    const c = adapter.getDebugConfig(cfg({
      typeOptions: { launchMode: 'java-main', classpath: 'target/classes:lib/foo.jar' },
    }), folder as any);
    expect(c.request).toBe('launch');
    expect(c.mainClass).toBe('com.example.Main');
    expect(c.classPaths).toEqual(['target/classes', 'lib/foo.jar']);
    expect(c.projectName).toBe('');
  });

  test('maven returns attach config on default port 5005', () => {
    const c = adapter.getDebugConfig(cfg(), folder as any);
    expect(c.request).toBe('attach');
    expect(c.port).toBe(5005);
    expect(c.sourcePaths).toEqual(['/ws/backend']);
  });

  test('gradle returns attach config honoring custom debugPort', () => {
    const c = adapter.getDebugConfig(cfg({
      typeOptions: { launchMode: 'gradle', debugPort: 6006 },
    }), folder as any);
    expect(c.request).toBe('attach');
    expect(c.port).toBe(6006);
  });
});

describe('JavaAdapter.prepareLaunch', () => {
  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

  test('debug=true + maven → MAVEN_OPTS (not JAVA_TOOL_OPTIONS)', async () => {
    const p = await adapter.prepareLaunch(cfg(), folder as any, { debug: true, debugPort: 5099 });
    expect(p.env?.MAVEN_OPTS).toContain('-agentlib:jdwp');
    expect(p.env?.MAVEN_OPTS).toContain('address=*:5099');
    expect(p.env?.JAVA_TOOL_OPTIONS).toBeUndefined();
  });

  test('debug=true + gradle → JAVA_TOOL_OPTIONS (not MAVEN_OPTS)', async () => {
    const p = await adapter.prepareLaunch(
      cfg({ typeOptions: { launchMode: 'gradle' } }),
      folder as any,
      { debug: true, debugPort: 5099 },
    );
    expect(p.env?.JAVA_TOOL_OPTIONS).toContain('-agentlib:jdwp');
    expect(p.env?.MAVEN_OPTS).toBeUndefined();
  });

  test('debug=true + java-main → no env (launcher drives JDWP)', async () => {
    const p = await adapter.prepareLaunch(
      cfg({ typeOptions: { launchMode: 'java-main', classpath: 'x' } }),
      folder as any,
      { debug: true, debugPort: 5099 },
    );
    expect(p.env?.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(p.env?.MAVEN_OPTS).toBeUndefined();
  });

  test('colorOutput sets FORCE_COLOR', async () => {
    const p = await adapter.prepareLaunch(cfg({ typeOptions: { colorOutput: true } }), folder as any, { debug: false });
    expect(p.env?.FORCE_COLOR).toBe('1');
  });

  test('jdkPath → JAVA_HOME', async () => {
    const p = await adapter.prepareLaunch(cfg({ typeOptions: { jdkPath: '/opt/jdk-21' } }), folder as any, { debug: false });
    expect(p.env?.JAVA_HOME).toBe('/opt/jdk-21');
  });
});
