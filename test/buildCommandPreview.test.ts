import { buildCommandPreview } from '../src/shared/buildCommandPreview';
import type { RunConfig, SpringBootTypeOptions } from '../src/shared/types';

const base: RunConfig = {
  id: 'a'.repeat(8) + '-1111-2222-3333-444444444444',
  name: 'x',
  type: 'npm',
  projectPath: 'frontend',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm' },
};

describe('buildCommandPreview', () => {
  test('formats npm run start with cwd hint', () => {
    expect(buildCommandPreview(base)).toBe('cd frontend && npm run start');
  });

  test('omits cd when projectPath is empty', () => {
    expect(buildCommandPreview({ ...base, projectPath: '' })).toBe('npm run start');
  });

  test('appends program args after --', () => {
    expect(buildCommandPreview({ ...base, programArgs: '--port 4000' }))
      .toBe('cd frontend && npm run start -- --port 4000');
  });

  test('returns invalid type message for unknown types', () => {
    expect(buildCommandPreview({ ...base, type: 'unknown' as any }))
      .toMatch(/unsupported/i);
  });
});

const springBase = {
  id: 'dddddddd-1111-2222-3333-444444444444',
  name: 'x',
  type: 'spring-boot' as const,
  projectPath: 'api',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
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
  } satisfies SpringBootTypeOptions,
};

describe('buildCommandPreview — spring-boot', () => {
  test('maven mode basic', () => {
    expect(buildCommandPreview(springBase as any)).toBe('cd api && mvn spring-boot:run');
  });

  test('gradle mode uses gradleCommand', () => {
    const cfg = {
      ...springBase,
      typeOptions: { ...springBase.typeOptions, launchMode: 'gradle', gradleCommand: 'gradle' },
    };
    expect(buildCommandPreview(cfg as any)).toBe('cd api && gradle bootRun');
  });

  test('java-main mode uses explicit jdk path and main class', () => {
    const cfg = {
      ...springBase,
      typeOptions: {
        ...springBase.typeOptions,
        launchMode: 'java-main',
        mainClass: 'com.example.App',
        classpath: 'target/classes',
        jdkPath: '/opt/jdk-21',
      },
    };
    expect(buildCommandPreview(cfg as any))
      .toBe('cd api && /opt/jdk-21/bin/java -cp target/classes com.example.App');
  });
});
