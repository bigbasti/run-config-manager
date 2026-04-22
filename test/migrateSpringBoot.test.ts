import { migrateSpringBootConfig } from '../src/services/migrateSpringBoot';

describe('migrateSpringBootConfig', () => {
  test('passes through non-spring-boot configs unchanged', () => {
    const npm = { type: 'npm', typeOptions: { scriptName: 'start', packageManager: 'npm' } };
    expect(migrateSpringBootConfig(npm)).toBe(npm);
  });

  test('adds launchMode defaulting to buildTool when absent', () => {
    const legacy = { type: 'spring-boot', typeOptions: { buildTool: 'gradle', profiles: 'dev' } };
    const m = migrateSpringBootConfig(legacy) as any;
    expect(m.typeOptions.launchMode).toBe('gradle');
    expect(m.typeOptions.buildTool).toBe('gradle');
    expect(m.typeOptions.profiles).toBe('dev');
  });

  test('fills new fields with empty strings', () => {
    const legacy = { type: 'spring-boot', typeOptions: { buildTool: 'maven' } };
    const m = migrateSpringBootConfig(legacy) as any;
    expect(m.typeOptions.mainClass).toBe('');
    expect(m.typeOptions.classpath).toBe('');
    expect(m.typeOptions.jdkPath).toBe('');
    expect(m.typeOptions.module).toBe('');
    expect(m.typeOptions.gradleCommand).toBe('./gradlew');
  });

  test('preserves launchMode when already set', () => {
    const newCfg = {
      type: 'spring-boot',
      typeOptions: {
        launchMode: 'java-main',
        buildTool: 'maven',
        gradleCommand: 'gradle',
        profiles: '',
        mainClass: 'com.example.App',
        classpath: 'target/classes',
        jdkPath: '/opt/jdk-21',
        module: '',
      },
    };
    const m = migrateSpringBootConfig(newCfg) as any;
    expect(m.typeOptions.launchMode).toBe('java-main');
    expect(m.typeOptions.mainClass).toBe('com.example.App');
    expect(m.typeOptions.jdkPath).toBe('/opt/jdk-21');
  });

  test('handles missing typeOptions object', () => {
    const bad = { type: 'spring-boot' };
    const m = migrateSpringBootConfig(bad) as any;
    expect(m.typeOptions.launchMode).toBe('maven');
    expect(m.typeOptions.buildTool).toBe('maven');
  });

  test('handles non-object inputs gracefully', () => {
    expect(migrateSpringBootConfig(null)).toBe(null);
    expect(migrateSpringBootConfig('hello')).toBe('hello');
    expect(migrateSpringBootConfig(42)).toBe(42);
  });
});
