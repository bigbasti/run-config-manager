import { Uri } from 'vscode';
import { QuarkusAdapter } from '../src/adapters/quarkus/QuarkusAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new QuarkusAdapter();

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'cccccccc-1111-2222-3333-444444444444',
    name: 'x',
    type: 'quarkus' as const,
    projectPath: 'backend',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      launchMode: 'maven' as const,
      buildTool: 'maven' as const,
      gradleCommand: './gradlew' as const,
      profile: '',
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

describe('QuarkusAdapter.buildCommand (Maven)', () => {
  test('basic mvn quarkus:dev with default debug port', () => {
    const r = adapter.buildCommand(cfg());
    expect(r.command).toBe('mvn');
    expect(r.args).toContain('quarkus:dev');
    expect(r.args).toContain('-Ddebug=5005');
  });

  test('uses mvnPath binary when set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { mavenPath: '/opt/maven/apache-maven-3.9.6' } }));
    expect(r.command).toBe('/opt/maven/apache-maven-3.9.6/bin/mvn');
  });

  test('adds -Dquarkus.profile when profile set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { profile: 'dev' } }));
    expect(r.args).toContain('-Dquarkus.profile=dev');
  });

  test('omits -Dquarkus.profile when blank', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { profile: '   ' } }));
    expect(r.args.find(a => a.startsWith('-Dquarkus.profile'))).toBeUndefined();
  });

  test('honors custom debug port', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { debugPort: 5006 } }));
    expect(r.args).toContain('-Ddebug=5006');
    expect(r.args.find(a => a === '-Ddebug=5005')).toBeUndefined();
  });

  test('passes program args via -Dquarkus.args', () => {
    const r = adapter.buildCommand(cfg({ programArgs: '--config=local.yml' }));
    expect(r.args.some(a => a.startsWith("-Dquarkus.args='--config=local.yml'"))).toBe(true);
  });

  test('passes vm args via -Djvm.args', () => {
    const r = adapter.buildCommand(cfg({ vmArgs: '-Xmx2g' }));
    expect(r.args.some(a => a === "-Djvm.args='-Xmx2g'")).toBe(true);
  });
});

describe('QuarkusAdapter.buildCommand (Gradle)', () => {
  const gradleCfg = (overrides: any = {}) => {
    const { typeOptions: toOverrides, ...rest } = overrides;
    return cfg({
      ...rest,
      typeOptions: { launchMode: 'gradle', buildTool: 'gradle', ...(toOverrides ?? {}) },
    });
  };

  test('basic ./gradlew --console=plain quarkusDev', () => {
    const r = adapter.buildCommand(gradleCfg());
    expect(r.command).toBe('./gradlew');
    expect(r.args.slice(0, 2)).toEqual(['--console=plain', 'quarkusDev']);
    expect(r.args).toContain('-Ddebug=5005');
    expect(r.args).toContain('-DdebugHost=0.0.0.0');
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

  test('scopes quarkusDev with :module: prefix in multi-module Gradle build', () => {
    const r = adapter.buildCommand(
      gradleCfg({
        projectPath: 'api',
        typeOptions: { buildRoot: '/git/demo' },
      }),
      { uri: Uri.file('/git/demo'), name: 'demo', index: 0 } as any,
    );
    // Find the task positional arg (it's the non-flag after --console=plain).
    expect(r.args).toContain(':api:quarkusDev');
    expect(r.args).not.toContain('quarkusDev');
  });

  test('adds profile + program + vm args together', () => {
    const r = adapter.buildCommand(gradleCfg({
      programArgs: '--config=prod.yml',
      vmArgs: '-Xmx2g',
      typeOptions: { profile: 'staging', debugPort: 5099 },
    }));
    expect(r.args).toContain('-Dquarkus.profile=staging');
    expect(r.args).toContain('-Ddebug=5099');
    expect(r.args.some(a => a.startsWith("-Dquarkus.args='--config=prod.yml"))).toBe(true);
    expect(r.args.some(a => a === "-Djvm.args='-Xmx2g'")).toBe(true);
  });
});

describe('QuarkusAdapter.getDebugConfig', () => {
  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

  test('returns Java attach config with default port 5005', () => {
    const c = adapter.getDebugConfig(cfg(), folder as any);
    expect(c.type).toBe('java');
    expect(c.request).toBe('attach');
    expect(c.port).toBe(5005);
    expect(c.hostName).toBe('localhost');
    // Redhat-java workarounds.
    expect(c.projectName).toBe('');
    expect(c.modulePaths).toEqual([]);
  });

  test('honors custom debug port', () => {
    const c = adapter.getDebugConfig(cfg({ typeOptions: { debugPort: 6006 } }), folder as any);
    expect(c.port).toBe(6006);
  });

  test('includes sourcePaths rooted at projectPath', () => {
    const c = adapter.getDebugConfig(cfg({ projectPath: 'api' }), folder as any);
    expect(c.sourcePaths).toEqual(['/ws/api']);
  });
});

describe('QuarkusAdapter.prepareLaunch', () => {
  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

  test('sets FORCE_COLOR when colorOutput is enabled', async () => {
    const p = await adapter.prepareLaunch(cfg({ typeOptions: { colorOutput: true } }), folder as any, { debug: false });
    expect(p.env?.FORCE_COLOR).toBe('1');
    expect(p.env?.CLICOLOR_FORCE).toBe('1');
  });

  test('does not set FORCE_COLOR when colorOutput omitted', async () => {
    const p = await adapter.prepareLaunch(cfg(), folder as any, { debug: false });
    expect(p.env?.FORCE_COLOR).toBeUndefined();
  });

  test('sets JAVA_HOME when jdkPath is set', async () => {
    const p = await adapter.prepareLaunch(cfg({ typeOptions: { jdkPath: '/opt/jdk-21' } }), folder as any, { debug: false });
    expect(p.env?.JAVA_HOME).toBe('/opt/jdk-21');
  });
});
