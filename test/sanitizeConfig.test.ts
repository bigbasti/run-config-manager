import { sanitizeConfig } from '../src/ui/EditorPanel';
import { RunConfigSchema } from '../src/shared/schema';
import type { RunConfig } from '../src/shared/types';

// Regression guard for the "Quarkus saved as npm" bug (commit: the one after
// fe8a0aa). sanitize() had a fall-through that coerced anything non-tomcat /
// non-spring-boot to npm; Quarkus configs lost their typeOptions on save.
//
// Two invariants this file enforces:
//   1. Every RunConfigType preserves its `type` discriminator through sanitize.
//   2. The sanitized output is always a valid RunConfig (passes Zod).

const base = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'x',
  projectPath: '',
  workspaceFolder: '',
  env: {} as Record<string, string>,
  programArgs: '',
  vmArgs: '',
};

describe('sanitizeConfig', () => {
  test('npm: keeps type + fills scriptName default', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'npm',
      typeOptions: {} as any,
    } as RunConfig);
    expect(out.type).toBe('npm');
    expect((out.typeOptions as any).scriptName).toBe('');
    expect((out.typeOptions as any).packageManager).toBe('npm');
    expect(RunConfigSchema.safeParse({ ...out, typeOptions: { ...out.typeOptions, scriptName: 'start' } }).success).toBe(true);
  });

  test('spring-boot: keeps type + preserves optional booleans', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'spring-boot',
      typeOptions: {
        launchMode: 'gradle',
        buildTool: 'gradle',
        gradleCommand: './gradlew',
        profiles: 'dev',
        mainClass: '',
        classpath: '',
        jdkPath: '',
        module: '',
        gradlePath: '',
        mavenPath: '',
        buildRoot: '',
        rebuildOnSave: true,
        colorOutput: false,
      },
    } as RunConfig);
    expect(out.type).toBe('spring-boot');
    const to = out.typeOptions as any;
    expect(to.rebuildOnSave).toBe(true);
    expect(to.colorOutput).toBe(false);
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });

  test('tomcat: keeps type + preserves applicationContext', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'tomcat',
      typeOptions: {
        tomcatHome: '/opt/tomcat-10',
        httpPort: 8081,
        buildTool: 'gradle',
        artifactPath: '/opt/app.war',
        artifactKind: 'war',
        applicationContext: '/api',
      } as any,
    } as RunConfig);
    expect(out.type).toBe('tomcat');
    expect((out.typeOptions as any).applicationContext).toBe('/api');
    expect((out.typeOptions as any).httpPort).toBe(8081);
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });

  test('quarkus: keeps type (regression guard)', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'quarkus',
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
    } as RunConfig);
    expect(out.type).toBe('quarkus');
    const to = out.typeOptions as any;
    expect(to.launchMode).toBe('maven');
    expect(to.profile).toBe('dev');
    expect(to.debugPort).toBe(5005);
    expect(to.colorOutput).toBe(true);
    // Quarkus MUST NOT get scriptName/packageManager.
    expect(to.scriptName).toBeUndefined();
    expect(to.packageManager).toBeUndefined();
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });

  test('quarkus: fills safe defaults when typeOptions is minimal', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'quarkus',
      typeOptions: { launchMode: 'gradle' } as any,
    } as RunConfig);
    expect(out.type).toBe('quarkus');
    const to = out.typeOptions as any;
    expect(to.launchMode).toBe('gradle');
    expect(to.buildTool).toBe('maven');   // fallback
    expect(to.gradleCommand).toBe('./gradlew');
    expect(to.profile).toBe('');
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });

  test('unknown type throws rather than silently coercing', () => {
    expect(() =>
      sanitizeConfig({
        ...base,
        type: 'cobol',
        typeOptions: {},
      } as unknown as RunConfig),
    ).toThrow(/unsupported config type/i);
  });

  test('java: keeps type + preserves launchMode', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'java',
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
        debugPort: 5005,
        colorOutput: true,
      },
    } as RunConfig);
    expect(out.type).toBe('java');
    const to = out.typeOptions as any;
    expect(to.launchMode).toBe('java-main');
    expect(to.mainClass).toBe('com.example.Main');
    expect(to.debugPort).toBe(5005);
    expect(to.colorOutput).toBe(true);
    // Must not be coerced to npm.
    expect(to.scriptName).toBeUndefined();
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });

  test('java: gradle-custom preserves customArgs + schema-valid', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'java',
      typeOptions: {
        launchMode: 'gradle-custom',
        buildTool: 'gradle',
        gradleCommand: './gradlew',
        mainClass: '',
        classpath: '',
        customArgs: ':api:test --tests "com.example.*IT"',
        jdkPath: '',
        module: '',
        gradlePath: '',
        mavenPath: '',
        buildRoot: '',
      } as any,
    } as RunConfig);
    const to = out.typeOptions as any;
    expect(to.launchMode).toBe('gradle-custom');
    expect(to.customArgs).toBe(':api:test --tests "com.example.*IT"');
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });

  test('java: fills safe defaults when typeOptions is minimal', () => {
    const out = sanitizeConfig({
      ...base,
      type: 'java',
      typeOptions: { launchMode: 'gradle' } as any,
    } as RunConfig);
    expect(out.type).toBe('java');
    const to = out.typeOptions as any;
    expect(to.launchMode).toBe('gradle');
    expect(to.buildTool).toBe('maven');
    expect(to.gradleCommand).toBe('./gradlew');
    // Gradle mode does not require mainClass — schema validates.
    expect(RunConfigSchema.safeParse(out).success).toBe(true);
  });
});
