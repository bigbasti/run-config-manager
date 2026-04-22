import { SpringBootAdapter } from '../src/adapters/spring-boot/SpringBootAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new SpringBootAdapter();

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'cccccccc-1111-2222-3333-444444444444',
    name: 'x',
    type: 'spring-boot' as const,
    projectPath: 'api',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      launchMode: 'java-main' as const,
      buildTool: 'maven' as const,
      gradleCommand: './gradlew' as const,
      profiles: '',
      mainClass: 'com.example.MyApp',
      classpath: 'target/classes:lib/*',
      jdkPath: '',
      module: '',
    },
  };
  return {
    ...base,
    ...overrides,
    typeOptions: { ...base.typeOptions, ...(overrides.typeOptions ?? {}) },
  } as RunConfig;
}

describe('SpringBootAdapter.buildCommand — java-main', () => {
  test('basic java -cp ... MainClass', () => {
    const r = adapter.buildCommand(cfg());
    expect(r.command).toBe('java');
    expect(r.args).toEqual(['-cp', 'target/classes:lib/*', 'com.example.MyApp']);
  });

  test('uses jdkPath/bin/java when set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { jdkPath: '/opt/jdk-21' } }));
    expect(r.command).toBe('/opt/jdk-21/bin/java');
  });

  test('strips trailing slash from jdkPath', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { jdkPath: '/opt/jdk-21/' } }));
    expect(r.command).toBe('/opt/jdk-21/bin/java');
  });

  test('applies vmArgs before classpath', () => {
    const r = adapter.buildCommand(cfg({ vmArgs: '-Xmx2g -XX:+UseG1GC' }));
    expect(r.args.slice(0, 4)).toEqual(['-Xmx2g', '-XX:+UseG1GC', '-cp', 'target/classes:lib/*']);
  });

  test('injects -Dspring.profiles.active when profiles set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { profiles: 'dev,local' } }));
    expect(r.args).toContain('-Dspring.profiles.active=dev,local');
  });

  test('appends programArgs after main class', () => {
    const r = adapter.buildCommand(cfg({ programArgs: '--server.port=8081' }));
    const mainIdx = r.args.indexOf('com.example.MyApp');
    expect(r.args.slice(mainIdx)).toEqual(['com.example.MyApp', '--server.port=8081']);
  });

  test('no classpath → omits -cp', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { classpath: '' } }));
    expect(r.args).not.toContain('-cp');
  });
});
