import { inferConfigPorts, inferConfigPortsDetailed } from '../src/services/PortScanner';
import type { RunConfig } from '../src/shared/types';

const base = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  name: 't',
  projectPath: '',
  workspaceFolder: 'ws',
  env: {},
  programArgs: '',
  vmArgs: '',
};

describe('inferConfigPorts', () => {
  test('npm: explicit port field wins', () => {
    const cfg: RunConfig = {
      ...base,
      type: 'npm',
      port: 4200,
      typeOptions: { scriptName: 'start', packageManager: 'npm' },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(4200);
  });

  test('npm: scans programArgs --port', () => {
    const cfg: RunConfig = {
      ...base,
      type: 'npm',
      programArgs: '--port 5000',
      typeOptions: { scriptName: 'start', packageManager: 'npm' },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(5000);
  });

  test('npm: defaults to 3000 when nothing explicit', () => {
    const cfg: RunConfig = {
      ...base,
      type: 'npm',
      typeOptions: { scriptName: 'start', packageManager: 'npm' },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(3000);
  });

  test('spring-boot: scans --server.port in programArgs', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      programArgs: '--server.port=8181',
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(8181);
  });

  test('spring-boot: scans -Dserver.port in vmArgs', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      vmArgs: '-Dserver.port=9090',
      typeOptions: {
        launchMode: 'maven', buildTool: 'maven', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(9090);
  });

  test('spring-boot: reads SERVER_PORT from env', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      env: { SERVER_PORT: '7070' },
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(7070);
  });

  test('spring-boot: defaults to 8080 when nothing explicit', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(8080);
  });

  test('spring-boot: includes debugPort when set', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
        debugPort: 5005,
      },
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(5005);
  });

  test('tomcat: returns httpPort', () => {
    const cfg = {
      ...base,
      type: 'tomcat' as const,
      typeOptions: {
        tomcatHome: '/opt/tc', jdkPath: '', httpPort: 8181,
        buildProjectPath: '', buildRoot: '', buildTool: 'gradle',
        gradleCommand: './gradlew', gradlePath: '', mavenPath: '',
        artifactPath: '', artifactKind: 'war', applicationContext: '/',
        profiles: '', vmOptions: '', reloadable: true, rebuildOnSave: false,
      } as any,
    } as RunConfig;
    expect(inferConfigPorts(cfg)).toContain(8181);
  });

  test('docker / custom-command / maven-goal return empty', () => {
    expect(inferConfigPorts({
      ...base,
      type: 'docker',
      typeOptions: { containerId: 'abc' },
    } as RunConfig)).toEqual([]);

    expect(inferConfigPorts({
      ...base,
      type: 'custom-command',
      typeOptions: { command: 'echo', cwd: '', shell: 'default', interactive: false },
    } as RunConfig)).toEqual([]);
  });

  test('deduplicates ports', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      port: 8080,
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    const ports = inferConfigPorts(cfg);
    expect(ports.filter(p => p === 8080).length).toBe(1);
  });
});

describe('inferConfigPortsDetailed', () => {
  test('spring-boot with no explicit port: default 8080 marked as default, not explicit', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    const r = inferConfigPortsDetailed(cfg);
    expect(r.explicit).toEqual([]);
    expect(r.defaultPorts).toEqual([8080]);
  });

  test('spring-boot with explicit port field: explicit, no default', () => {
    const cfg = {
      ...base,
      type: 'spring-boot' as const,
      port: 9090,
      typeOptions: {
        launchMode: 'gradle', buildTool: 'gradle', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '',
        module: '', gradlePath: '', mavenPath: '', buildRoot: '',
      },
    } as RunConfig;
    const r = inferConfigPortsDetailed(cfg);
    expect(r.explicit).toContain(9090);
    expect(r.defaultPorts).toEqual([]);
  });

  test('tomcat httpPort always counts as explicit (user-configured field)', () => {
    const cfg = {
      ...base,
      type: 'tomcat' as const,
      typeOptions: {
        tomcatHome: '/opt/tc', jdkPath: '', httpPort: 8181,
        buildProjectPath: '', buildRoot: '', buildTool: 'gradle',
        gradleCommand: './gradlew', gradlePath: '', mavenPath: '',
        artifactPath: '', artifactKind: 'war', applicationContext: '/',
        profiles: '', vmOptions: '', reloadable: true, rebuildOnSave: false,
      } as any,
    } as RunConfig;
    const r = inferConfigPortsDetailed(cfg);
    expect(r.explicit).toContain(8181);
    expect(r.defaultPorts).toEqual([]);
  });

  test('npm with nothing set: default 3000 only', () => {
    const cfg: RunConfig = {
      ...base,
      type: 'npm',
      typeOptions: { scriptName: 'start', packageManager: 'npm' },
    } as RunConfig;
    const r = inferConfigPortsDetailed(cfg);
    expect(r.explicit).toEqual([]);
    expect(r.defaultPorts).toEqual([3000]);
  });
});
