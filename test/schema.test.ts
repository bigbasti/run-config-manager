import { RunFileSchema, parseRunFile } from '../src/shared/schema';

describe('RunFileSchema', () => {
  const minimalConfig = {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'My App',
    type: 'npm',
    projectPath: 'frontend',
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: { scriptName: 'start', packageManager: 'npm' },
  };

  test('accepts a valid v1 file', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [minimalConfig],
    });
    expect(result.success).toBe(true);
  });

  test('accepts optional port field', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{ ...minimalConfig, port: 4200 }],
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing required field (name)', () => {
    const { name, ...rest } = minimalConfig;
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [rest],
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown type', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{ ...minimalConfig, type: 'cobol' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects version != 1', () => {
    const result = RunFileSchema.safeParse({
      version: 2,
      configurations: [minimalConfig],
    });
    expect(result.success).toBe(false);
  });

  test('parseRunFile returns a typed error on invalid JSON', () => {
    const outcome = parseRunFile('not json {');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/JSON/i);
  });

  test('parseRunFile returns a typed error with the Zod path on schema mismatch', () => {
    const outcome = parseRunFile(JSON.stringify({ version: 1, configurations: [{}] }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/configurations/);
  });

  test('parseRunFile succeeds on empty configurations array', () => {
    const outcome = parseRunFile(JSON.stringify({ version: 1, configurations: [] }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.configurations).toEqual([]);
  });

  test('accepts a Quarkus config', () => {
    const quarkusConfig = {
      id: '22222222-3333-4444-5555-666666666666',
      name: 'Quarkus dev',
      type: 'quarkus',
      projectPath: 'api',
      workspaceFolder: '',
      env: {},
      programArgs: '',
      vmArgs: '',
      typeOptions: {
        launchMode: 'maven',
        buildTool: 'maven',
        gradleCommand: './gradlew',
        profile: 'dev',
        jdkPath: '',
        module: '',
        gradlePath: '',
        mavenPath: '',
        buildRoot: '',
        debugPort: 5005,
        colorOutput: true,
      },
    };
    const result = RunFileSchema.safeParse({ version: 1, configurations: [quarkusConfig] });
    expect(result.success).toBe(true);
  });

  test('rejects Quarkus config missing required typeOptions field', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'quarkus',
        typeOptions: { launchMode: 'maven' },  // missing everything else
      }],
    });
    expect(result.success).toBe(false);
  });

  test('accepts a Java config (java-main mode with classpath + main class)', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        id: '33333333-4444-5555-6666-777777777777',
        name: 'Java CLI',
        type: 'java',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: {
          launchMode: 'java-main',
          buildTool: 'maven',
          gradleCommand: './gradlew',
          mainClass: 'com.example.Main',
          classpath: 'target/classes',
          customArgs: '',
          jdkPath: '',
          module: '',
          gradlePath: '',
          mavenPath: '',
          buildRoot: '',
        },
      }],
    });
    expect(result.success).toBe(true);
  });

  test('rejects Java java-main config without mainClass', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'java',
        typeOptions: {
          launchMode: 'java-main',
          buildTool: 'maven',
          gradleCommand: './gradlew',
          mainClass: '',
          classpath: 'target/classes',
          customArgs: '',
          jdkPath: '', module: '', gradlePath: '', mavenPath: '', buildRoot: '',
        },
      }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects Java java-main config without classpath', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'java',
        typeOptions: {
          launchMode: 'java-main',
          buildTool: 'maven',
          gradleCommand: './gradlew',
          mainClass: 'com.example.Main',
          classpath: '',
          customArgs: '',
          jdkPath: '', module: '', gradlePath: '', mavenPath: '', buildRoot: '',
        },
      }],
    });
    expect(result.success).toBe(false);
  });

  test('Java gradle mode does NOT require mainClass (read from build.gradle)', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        id: '44444444-5555-6666-7777-888888888888',
        name: 'Gradle run',
        type: 'java',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: {
          launchMode: 'gradle',
          buildTool: 'gradle',
          gradleCommand: './gradlew',
          mainClass: '',
          classpath: '',
          customArgs: '',
          jdkPath: '', module: '', gradlePath: '', mavenPath: '', buildRoot: '',
        },
      }],
    });
    expect(result.success).toBe(true);
  });

  test('accepts a Maven Goal config', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
        name: 'Clean install',
        type: 'maven-goal',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: { goal: 'clean install', jdkPath: '', mavenPath: '', buildRoot: '' },
      }],
    });
    expect(r.success).toBe(true);
  });

  test('rejects Maven Goal config with empty goal', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'maven-goal',
        typeOptions: { goal: '  ', jdkPath: '', mavenPath: '', buildRoot: '' },
      }],
    });
    expect(r.success).toBe(false);
  });

  test('accepts a Gradle Task config', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
        name: 'Drop schema',
        type: 'gradle-task',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: { task: 'dropAll', gradleCommand: './gradlew', jdkPath: '', gradlePath: '', buildRoot: '' },
      }],
    });
    expect(r.success).toBe(true);
  });

  test('accepts a Custom Command config', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        id: '88888888-9999-aaaa-bbbb-cccccccccccc',
        name: 'Seed DB',
        type: 'custom-command',
        projectPath: '',
        workspaceFolder: '',
        env: {},
        programArgs: '',
        vmArgs: '',
        typeOptions: {
          command: './scripts/seed.sh --dev',
          cwd: '',
          shell: 'bash',
          interactive: false,
        },
      }],
    });
    expect(r.success).toBe(true);
  });

  test('rejects Custom Command with empty command', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'custom-command',
        typeOptions: {
          command: '   ',
          cwd: '',
          shell: 'default',
          interactive: false,
        },
      }],
    });
    expect(r.success).toBe(false);
  });

  test('rejects Custom Command with invalid shell value', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'custom-command',
        typeOptions: {
          command: 'echo hi',
          cwd: '',
          shell: 'fish',   // not in the enum
          interactive: false,
        },
      }],
    });
    expect(r.success).toBe(false);
  });

  test('rejects Gradle Task config with empty task', () => {
    const r = RunFileSchema.safeParse({
      version: 1,
      configurations: [{
        ...minimalConfig,
        type: 'gradle-task',
        typeOptions: { task: '', gradleCommand: './gradlew', jdkPath: '', gradlePath: '', buildRoot: '' },
      }],
    });
    expect(r.success).toBe(false);
  });

  test('Java gradle-custom mode requires customArgs', () => {
    const base = {
      id: '55555555-6666-7777-8888-999999999999',
      name: 'Systemtest',
      type: 'java',
      projectPath: '',
      workspaceFolder: '',
      env: {},
      programArgs: '',
      vmArgs: '',
    };
    const to = {
      launchMode: 'gradle-custom',
      buildTool: 'gradle',
      gradleCommand: './gradlew',
      mainClass: '',
      classpath: '',
      jdkPath: '', module: '', gradlePath: '', mavenPath: '', buildRoot: '',
    };
    const withArgs = RunFileSchema.safeParse({
      version: 1,
      configurations: [{ ...base, typeOptions: { ...to, customArgs: ':systemtest:systemtestDev --tests "x.*"' } }],
    });
    expect(withArgs.success).toBe(true);
    const withoutArgs = RunFileSchema.safeParse({
      version: 1,
      configurations: [{ ...base, typeOptions: { ...to, customArgs: '' } }],
    });
    expect(withoutArgs.success).toBe(false);
  });
});
