import { Uri, __resetFs, __writeFs } from 'vscode';
import { MavenGoalAdapter } from '../src/adapters/maven-goal/MavenGoalAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new MavenGoalAdapter();

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'eeeeeeee-1111-2222-3333-444444444444',
    name: 'x',
    type: 'maven-goal' as const,
    projectPath: '',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      goal: 'clean install',
      jdkPath: '',
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

describe('MavenGoalAdapter.buildCommand', () => {
  test('basic goal passes through splitArgs', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { goal: 'clean install' } }));
    expect(r.command).toBe('mvn');
    expect(r.args).toEqual(['clean', 'install']);
  });

  test('uses mavenPath/bin/mvn when set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { mavenPath: '/opt/maven' } }));
    expect(r.command).toBe('/opt/maven/bin/mvn');
  });

  test('preserves quoted arguments', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { goal: 'liquibase:dropAll -Dliquibase.url="jdbc:h2:mem:foo"' },
    }));
    expect(r.args).toEqual([
      'liquibase:dropAll',
      '-Dliquibase.url=jdbc:h2:mem:foo',
    ]);
  });
});

describe('MavenGoalAdapter.detect', () => {
  beforeEach(() => __resetFs());

  test('returns null without pom.xml', async () => {
    expect(await adapter.detect(Uri.file('/proj'))).toBeNull();
  });

  test('matches on any pom.xml — even on Spring Boot projects', async () => {
    // Unlike the Java adapter, maven-goal does NOT bail on framework markers.
    // Running `mvn clean install` on a Spring Boot project is a valid use case.
    __writeFs('/proj/pom.xml',
      '<project><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    expect(r!.defaults.type).toBe('maven-goal');
  });
});

describe('MavenGoalAdapter.prepareLaunch', () => {
  const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

  test('sets JAVA_HOME + FORCE_COLOR when configured', async () => {
    const p = await adapter.prepareLaunch(
      cfg({ typeOptions: { jdkPath: '/opt/jdk-21', colorOutput: true } }),
      folder as any,
      { debug: false },
    );
    expect(p.env?.JAVA_HOME).toBe('/opt/jdk-21');
    expect(p.env?.FORCE_COLOR).toBe('1');
  });
});

describe('MavenGoalAdapter metadata', () => {
  test('does not support debug', () => {
    expect(adapter.supportsDebug).toBe(false);
  });
});
