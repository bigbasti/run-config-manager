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

  test('gradle submodule uses buildRoot cwd and :module:bootRun task', () => {
    // Mirrors the queue-watcher scenario: user picked /ws/queue-watcher but the
    // wrapper lives at /ws. Runtime execs from /ws with `:queue-watcher:bootRun`,
    // and the preview must match so the command shown to the user is what we
    // actually run.
    const cfg = {
      ...springBase,
      projectPath: 'queue-watcher',
      typeOptions: {
        ...springBase.typeOptions,
        launchMode: 'gradle',
        gradleCommand: './gradlew',
        buildTool: 'gradle',
        buildRoot: '/ws',
      },
    };
    expect(buildCommandPreview(cfg as any, '/ws'))
      .toBe('cd . && ./gradlew :queue-watcher:bootRun');
  });

  test('gradle submodule without workspace folder falls back to projectPath cwd', () => {
    // Tree provider renders the preview without a workspaceFolderPath. In that
    // case we keep the old behavior rather than show a wrong cwd.
    const cfg = {
      ...springBase,
      projectPath: 'queue-watcher',
      typeOptions: {
        ...springBase.typeOptions,
        launchMode: 'gradle',
        gradleCommand: './gradlew',
        buildTool: 'gradle',
        buildRoot: '/ws',
      },
    };
    expect(buildCommandPreview(cfg as any))
      .toBe('cd /ws && ./gradlew bootRun');
  });

  test('gradle mode at workspace root omits module prefix', () => {
    const cfg = {
      ...springBase,
      projectPath: '',
      typeOptions: {
        ...springBase.typeOptions,
        launchMode: 'gradle',
        gradleCommand: './gradlew',
        buildTool: 'gradle',
        buildRoot: '',
      },
    };
    expect(buildCommandPreview(cfg as any, '/ws'))
      .toBe('./gradlew bootRun');
  });
});

describe('buildCommandPreview — tomcat', () => {
  const tomcatBase = {
    id: 'eeeeeeee-1111-2222-3333-444444444444',
    name: 't',
    type: 'tomcat' as const,
    projectPath: '',
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      tomcatHome: '/opt/tc',
      jdkPath: '',
      httpPort: 8080,
      buildProjectPath: '',
      buildRoot: '',
      buildTool: 'gradle' as const,
      gradleCommand: './gradlew' as const,
      gradlePath: '',
      mavenPath: '',
      artifactPath: '/opt/app.war',
      artifactKind: 'war' as const,
      applicationContext: '/',
      profiles: '',
      vmOptions: '',
      reloadable: true,
      rebuildOnSave: false,
    },
  };

  test('no profiles / no vmOptions → no CATALINA_OPTS prefix', () => {
    expect(buildCommandPreview(tomcatBase as any))
      .toBe('/opt/tc/bin/catalina.sh run  # deploy /opt/app.war → / on :8080');
  });

  test('selected profiles show up as -Dspring.profiles.active via CATALINA_OPTS', () => {
    const cfg = { ...tomcatBase, typeOptions: { ...tomcatBase.typeOptions, profiles: 'dev,local' } };
    expect(buildCommandPreview(cfg as any))
      .toMatch(/CATALINA_OPTS='-Dspring\.profiles\.active=dev,local' \/opt\/tc\/bin\/catalina\.sh run/);
  });

  test('vmOptions + profiles combine in CATALINA_OPTS', () => {
    const cfg = {
      ...tomcatBase,
      typeOptions: { ...tomcatBase.typeOptions, profiles: 'prod', vmOptions: '-Xmx2g' },
    };
    expect(buildCommandPreview(cfg as any))
      .toMatch(/CATALINA_OPTS='-Xmx2g -Dspring\.profiles\.active=prod'/);
  });
});

describe('buildCommandPreview — docker', () => {
  const dockerBase = {
    id: 'ffffffff-1111-2222-3333-444444444444',
    name: 'db',
    type: 'docker' as const,
    projectPath: '',
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      containerId: '',
    },
  };

  test('empty containerId falls back to placeholder token', () => {
    expect(buildCommandPreview(dockerBase as any)).toBe('docker start <container>');
  });

  test('long container id is truncated to the 12-char short form', () => {
    const cfg = { ...dockerBase, typeOptions: { containerId: 'abcdef1234567890abcdef1234' } };
    expect(buildCommandPreview(cfg as any)).toBe('docker start abcdef123456');
  });

  test('no cwd prefix or program-args suffix are appended', () => {
    const cfg = {
      ...dockerBase,
      projectPath: 'ignored',
      programArgs: '--also-ignored',
      typeOptions: { containerId: 'abc' },
    };
    expect(buildCommandPreview(cfg as any)).toBe('docker start abc');
  });
});
