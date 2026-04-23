import { Uri, __resetFs, __writeFs } from 'vscode';
import { GradleTaskAdapter } from '../src/adapters/gradle-task/GradleTaskAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new GradleTaskAdapter();

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'ffffffff-1111-2222-3333-444444444444',
    name: 'x',
    type: 'gradle-task' as const,
    projectPath: '',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      task: 'dropAll',
      gradleCommand: './gradlew' as const,
      jdkPath: '',
      gradlePath: '',
      buildRoot: '',
    },
  };
  return {
    ...base,
    ...overrides,
    typeOptions: { ...base.typeOptions, ...(overrides.typeOptions ?? {}) },
  } as RunConfig;
}

describe('GradleTaskAdapter.buildCommand', () => {
  test('wraps a single-word task with --console=plain', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { task: 'dropAll' } }));
    expect(r.command).toBe('./gradlew');
    expect(r.args).toEqual(['--console=plain', 'dropAll']);
  });

  test('uses system gradle when gradleCommand is "gradle"', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { gradleCommand: 'gradle' } }));
    expect(r.command).toBe('gradle');
  });

  test('uses gradlePath binary when set', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { gradleCommand: 'gradle', gradlePath: '/opt/gradle/gradle-8.5' },
    }));
    expect(r.command).toBe('/opt/gradle/gradle-8.5/bin/gradle');
  });

  test('preserves quoted --tests argument', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { task: ':systemtest:test --tests "com.example.*IT"' },
    }));
    expect(r.args).toEqual([
      '--console=plain',
      ':systemtest:test',
      '--tests',
      'com.example.*IT',
    ]);
  });

  test('chained tasks', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { task: 'clean build -x test' } }));
    expect(r.args).toEqual(['--console=plain', 'clean', 'build', '-x', 'test']);
  });
});

describe('GradleTaskAdapter.detect', () => {
  beforeEach(() => __resetFs());

  test('returns null without a gradle build file', async () => {
    expect(await adapter.detect(Uri.file('/proj'))).toBeNull();
  });

  test('matches on build.gradle even on Spring Boot projects', async () => {
    __writeFs('/proj/build.gradle', 'plugins { id "org.springframework.boot" version "3.2.0" }');
    const r = await adapter.detect(Uri.file('/proj'));
    expect(r).not.toBeNull();
    expect(r!.defaults.type).toBe('gradle-task');
  });

  test('matches on build.gradle.kts too', async () => {
    __writeFs('/proj/build.gradle.kts', 'plugins { `java` }');
    expect(await adapter.detect(Uri.file('/proj'))).not.toBeNull();
  });
});

describe('GradleTaskAdapter.prepareLaunch', () => {
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

describe('GradleTaskAdapter metadata', () => {
  test('does not support debug', () => {
    expect(adapter.supportsDebug).toBe(false);
  });
});
