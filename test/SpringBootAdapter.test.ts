import { Uri, __resetFs, __writeFs } from 'vscode';
import { SpringBootAdapter } from '../src/adapters/spring-boot/SpringBootAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new SpringBootAdapter();

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    name: 'x',
    type: 'spring-boot' as const,
    projectPath: 'backend',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      launchMode: 'maven' as const,
      buildTool: 'maven' as const,
      gradleCommand: './gradlew' as const,
      profiles: '',
      mainClass: '',
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

describe('SpringBootAdapter.detect', () => {
  beforeEach(() => __resetFs());

  test('returns null for empty folder', async () => {
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).toBeNull();
  });

  test('returns null when pom.xml present but no Spring Boot signal', async () => {
    __writeFs('/proj/pom.xml', '<project><artifactId>nope</artifactId></project>');
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).toBeNull();
  });

  test('detects Spring Boot from pom.xml mentioning spring-boot-starter', async () => {
    __writeFs('/proj/pom.xml', '<project><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>');
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).not.toBeNull();
    expect(result!.defaults.type).toBe('spring-boot');
    expect((result!.defaults.typeOptions as any).buildTool).toBe('maven');
    expect((result!.context as any).buildTool).toBe('maven');
  });

  test('detects Spring Boot from build.gradle mentioning spring-boot-maven-plugin', async () => {
    __writeFs('/proj/build.gradle', 'plugins { id "org.springframework.boot" version "3.2.0" }');
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).not.toBeNull();
    expect((result!.defaults.typeOptions as any).buildTool).toBe('gradle');
  });

  test('detects Spring Boot from @SpringBootApplication annotation alone', async () => {
    __writeFs('/proj/pom.xml', '<project/>');
    __writeFs('/proj/src/main/java/com/example/App.java',
      'package com.example; @SpringBootApplication class App {}');
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).not.toBeNull();
  });

  test('prefers maven when both pom.xml and build.gradle exist', async () => {
    __writeFs('/proj/pom.xml', '<project><dependency><artifactId>spring-boot-starter</artifactId></dependency></project>');
    __writeFs('/proj/build.gradle', 'plugins {}');
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.defaults.typeOptions as any).buildTool).toBe('maven');
  });
});

describe('SpringBootAdapter.buildCommand (Maven)', () => {
  test('basic mvn spring-boot:run', () => {
    const r = adapter.buildCommand(cfg());
    expect(r.command).toBe('mvn');
    expect(r.args).toEqual(['spring-boot:run']);
  });

  test('adds -Dspring-boot.run.profiles when profiles set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { launchMode: 'maven', profiles: 'dev,local' } }));
    expect(r.args).toContain('-Dspring-boot.run.profiles=dev,local');
  });

  test('adds -Dspring-boot.run.arguments (quoted) when programArgs set', () => {
    const r = adapter.buildCommand(cfg({ programArgs: '--server.port=8081' }));
    expect(r.args.some(a => a.startsWith("-Dspring-boot.run.arguments='--server.port=8081'"))).toBe(true);
  });

  test('adds -Dspring-boot.run.jvmArguments (quoted) when vmArgs set', () => {
    const r = adapter.buildCommand(cfg({ vmArgs: '-Xmx1g' }));
    expect(r.args.some(a => a === "-Dspring-boot.run.jvmArguments='-Xmx1g'")).toBe(true);
  });
});

describe('SpringBootAdapter.buildCommand (Gradle)', () => {
  test('basic ./gradlew bootRun', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { launchMode: 'gradle', buildTool: 'gradle', profiles: '' } }));
    expect(r.command).toBe('./gradlew');
    expect(r.args).toEqual(['bootRun']);
  });

  test('adds --args with profile flag when profiles set', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { launchMode: 'gradle', buildTool: 'gradle', profiles: 'dev' } }));
    expect(r.args.some(a => a.startsWith("--args='--spring.profiles.active=dev"))).toBe(true);
  });

  test('merges program args into --args', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { launchMode: 'gradle', buildTool: 'gradle', profiles: 'dev' },
      programArgs: '--server.port=9090',
    }));
    const argsFlag = r.args.find(a => a.startsWith('--args='));
    expect(argsFlag).toBeDefined();
    expect(argsFlag).toContain('--spring.profiles.active=dev');
    expect(argsFlag).toContain('--server.port=9090');
  });
});

describe('SpringBootAdapter form schema', () => {
  test('every field has non-empty help', () => {
    const schema = adapter.getFormSchema({ buildTool: 'maven', mainClasses: [], jdks: [] });
    const allFields = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
    for (const f of allFields) {
      expect(typeof f.help).toBe('string');
      expect(f.help!.length).toBeGreaterThan(0);
    }
  });

  test('typeSpecific fields include new fields', () => {
    const schema = adapter.getFormSchema({ buildTool: 'maven', mainClasses: [], jdks: [] });
    const keys = schema.typeSpecific.map(f => f.key);
    expect(keys).toEqual(expect.arrayContaining([
      'typeOptions.gradleCommand',
      'typeOptions.jdkPath',
      'typeOptions.mainClass',
      'typeOptions.classpath',
      'typeOptions.module',
      'port',
    ]));
  });
});

describe('SpringBootAdapter debug', () => {
  test('supportsDebug is true', () => {
    expect(adapter.supportsDebug).toBe(true);
  });

  test('getDebugConfig for java-main returns a launch config', () => {
    const c = cfg({
      typeOptions: {
        launchMode: 'java-main',
        mainClass: 'com.example.App',
        classpath: '/a:/b:/c',
        jdkPath: '/opt/jdk-21',
      },
    });
    const r = adapter.getDebugConfig!(c, { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any);
    expect(r.type).toBe('java');
    expect(r.request).toBe('launch');
    expect(r.mainClass).toBe('com.example.App');
    expect(r.classPaths).toEqual(['/a', '/b', '/c']);
    expect(r.javaExec).toBe('/opt/jdk-21/bin/java');
  });

  test('getDebugConfig for maven returns an attach config on default port 5005', () => {
    const c = cfg({ typeOptions: { launchMode: 'maven' } });
    const r = adapter.getDebugConfig!(c, { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any);
    expect(r.type).toBe('java');
    expect(r.request).toBe('attach');
    expect(r.port).toBe(5005);
    expect(r.hostName).toBe('localhost');
  });

  test('getDebugConfig honours custom debugPort for gradle', () => {
    const c = cfg({ typeOptions: { launchMode: 'gradle', buildTool: 'gradle', debugPort: 5099 } });
    const r = adapter.getDebugConfig!(c, { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any);
    expect(r.port).toBe(5099);
  });

  test('getDebugConfig for java-main adds profile flag to vmArgs', () => {
    const c = cfg({
      typeOptions: {
        launchMode: 'java-main',
        mainClass: 'com.example.App',
        classpath: '/a',
        profiles: 'dev,local',
      },
    });
    const r = adapter.getDebugConfig!(c, { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any);
    expect(r.vmArgs).toBe('-Dspring.profiles.active=dev,local');
  });
});
