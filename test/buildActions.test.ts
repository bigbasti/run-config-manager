import { Uri } from 'vscode';
import { resolveBuildContext, buildCommandFor } from '../src/services/buildActions';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;
const base = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  name: 't',
  projectPath: 'api',
  workspaceFolder: 'ws',
  env: {},
  programArgs: '',
  vmArgs: '',
};

function springBootMaven(over: any = {}): RunConfig {
  return {
    ...base,
    type: 'spring-boot',
    typeOptions: {
      launchMode: 'maven',
      buildTool: 'maven',
      gradleCommand: './gradlew',
      profiles: '',
      mainClass: '',
      classpath: '',
      jdkPath: '',
      module: '',
      gradlePath: '',
      mavenPath: '',
      buildRoot: '',
      ...over,
    },
  } as RunConfig;
}

function springBootGradle(over: any = {}): RunConfig {
  return {
    ...base,
    type: 'spring-boot',
    typeOptions: {
      launchMode: 'gradle',
      buildTool: 'gradle',
      gradleCommand: './gradlew',
      profiles: '',
      mainClass: '',
      classpath: '',
      jdkPath: '',
      module: '',
      gradlePath: '',
      mavenPath: '',
      buildRoot: '',
      ...over,
    },
  } as RunConfig;
}

describe('resolveBuildContext', () => {
  test('npm / docker / custom-command return null (no build tool)', () => {
    const npm: RunConfig = {
      ...base,
      type: 'npm',
      typeOptions: { scriptName: 'start', packageManager: 'npm' },
    } as RunConfig;
    const docker: RunConfig = {
      ...base,
      type: 'docker',
      typeOptions: { containerId: 'abc' },
    } as RunConfig;
    const custom: RunConfig = {
      ...base,
      type: 'custom-command',
      typeOptions: { command: 'echo', cwd: '', shell: 'default', interactive: false } as any,
    } as RunConfig;
    expect(resolveBuildContext(npm, folder)).toBeNull();
    expect(resolveBuildContext(docker, folder)).toBeNull();
    expect(resolveBuildContext(custom, folder)).toBeNull();
  });

  test('maven config without buildRoot: cwd = project root, no module prefix', () => {
    const ctx = resolveBuildContext(springBootMaven(), folder);
    expect(ctx).not.toBeNull();
    expect(ctx!.tool).toBe('maven');
    expect(ctx!.cwd).toBe('/ws/api');
    expect(ctx!.modulePrefix).toBe('');
    expect(ctx!.binary).toBe('mvn');
  });

  test('maven config with custom mavenPath uses that binary', () => {
    const ctx = resolveBuildContext(
      springBootMaven({ mavenPath: '/opt/maven/apache-maven-3.9.6/' }),
      folder,
    );
    expect(ctx!.binary).toBe('/opt/maven/apache-maven-3.9.6/bin/mvn');
  });

  test('gradle submodule: cwd = buildRoot, modulePrefix = :api, wrapper preserved', () => {
    const ctx = resolveBuildContext(
      springBootGradle({ buildRoot: '/ws', gradleCommand: './gradlew' }),
      folder,
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.tool).toBe('gradle');
    expect(ctx!.cwd).toBe('/ws');
    expect(ctx!.modulePrefix).toBe(':api');
    expect(ctx!.binary).toBe('./gradlew');
  });

  test('gradle system binary with gradlePath', () => {
    const ctx = resolveBuildContext(
      springBootGradle({ gradleCommand: 'gradle', gradlePath: '/opt/gradle/gradle-8.5/' }),
      folder,
    );
    expect(ctx!.binary).toBe('/opt/gradle/gradle-8.5/bin/gradle');
  });

  test('jdkPath flows into env as JAVA_HOME', () => {
    const ctx = resolveBuildContext(
      springBootMaven({ jdkPath: '/opt/jdk-21' }),
      folder,
    );
    expect(ctx!.env.JAVA_HOME).toBe('/opt/jdk-21');
  });

  test('tomcat buildTool=none returns null', () => {
    const cfg: RunConfig = {
      ...base,
      type: 'tomcat',
      typeOptions: {
        tomcatHome: '/opt/tc',
        jdkPath: '',
        httpPort: 8080,
        buildProjectPath: 'api',
        buildRoot: '',
        buildTool: 'none',
        gradleCommand: './gradlew',
        gradlePath: '',
        mavenPath: '',
        artifactPath: '',
        artifactKind: 'war',
        applicationContext: '/',
        profiles: '',
        vmOptions: '',
        reloadable: true,
        rebuildOnSave: false,
      } as any,
    } as RunConfig;
    expect(resolveBuildContext(cfg, folder)).toBeNull();
  });

  test('tomcat uses buildProjectPath when set for modulePrefix calc', () => {
    const cfg: RunConfig = {
      ...base,
      projectPath: '',
      type: 'tomcat',
      typeOptions: {
        tomcatHome: '/opt/tc',
        jdkPath: '',
        httpPort: 8080,
        buildProjectPath: 'api',
        buildRoot: '/ws',
        buildTool: 'gradle',
        gradleCommand: './gradlew',
        gradlePath: '',
        mavenPath: '',
        artifactPath: '',
        artifactKind: 'war',
        applicationContext: '/',
        profiles: '',
        vmOptions: '',
        reloadable: true,
        rebuildOnSave: false,
      } as any,
    } as RunConfig;
    const ctx = resolveBuildContext(cfg, folder);
    expect(ctx).not.toBeNull();
    expect(ctx!.cwd).toBe('/ws');
    expect(ctx!.modulePrefix).toBe(':api');
  });
});

describe('buildCommandFor', () => {
  test('maven commands', () => {
    const ctx = resolveBuildContext(springBootMaven(), folder)!;
    expect(buildCommandFor(ctx, 'clean')).toEqual(['clean']);
    expect(buildCommandFor(ctx, 'build')).toEqual(['package', '-DskipTests']);
    expect(buildCommandFor(ctx, 'test')).toEqual(['test']);
  });

  test('gradle root-level commands', () => {
    const ctx = resolveBuildContext(springBootGradle(), folder)!;
    expect(buildCommandFor(ctx, 'clean')).toEqual(['--console=plain', 'clean']);
    expect(buildCommandFor(ctx, 'build')).toEqual(['--console=plain', 'assemble']);
    expect(buildCommandFor(ctx, 'test')).toEqual(['--console=plain', 'test']);
  });

  test('gradle submodule commands include :module: prefix', () => {
    const ctx = resolveBuildContext(springBootGradle({ buildRoot: '/ws' }), folder)!;
    expect(buildCommandFor(ctx, 'clean')).toEqual(['--console=plain', ':api:clean']);
    expect(buildCommandFor(ctx, 'build')).toEqual(['--console=plain', ':api:assemble']);
    expect(buildCommandFor(ctx, 'test')).toEqual(['--console=plain', ':api:test']);
  });
});
