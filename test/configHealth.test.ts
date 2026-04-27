import { Uri, __resetFs, __writeFs } from 'vscode';
import { checkConfigHealth, resetConfigHealthCache } from '../src/services/configHealth';
import type { RunConfig } from '../src/shared/types';

const WORKSPACE = '/ws';
const folder = { uri: Uri.file(WORKSPACE), name: 'ws', index: 0 } as any;

function springBootGradle(
  projectPath: string,
  overrides: Partial<Extract<RunConfig, { type: 'spring-boot' }>['typeOptions']> = {},
): RunConfig {
  return {
    id: 'deadbeef-1111-2222-3333-444444444444',
    name: 'test',
    type: 'spring-boot',
    projectPath,
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
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
      ...overrides,
    },
  };
}

describe('checkConfigHealth', () => {
  beforeEach(() => {
    __resetFs();
    resetConfigHealthCache();
  });

  test('spring-boot submodule with empty buildRoot → stale', async () => {
    // Wrapper at workspace root, build.gradle at submodule — the scenario
    // the new detection populates buildRoot for. An older config wouldn't
    // have that set.
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/settings.gradle', 'include "api"');
    __writeFs('/ws/api/build.gradle', '');
    const r = await checkConfigHealth(springBootGradle('api'), folder);
    expect(r.healthy).toBe(false);
    if (!r.healthy) expect(r.reason).toMatch(/stale|build root|sub/i);
  });

  test('spring-boot submodule with buildRoot set → healthy', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/settings.gradle', 'include "api"');
    __writeFs('/ws/api/build.gradle', '');
    const cfg = springBootGradle('api', { buildRoot: '/ws' });
    const r = await checkConfigHealth(cfg, folder);
    expect(r.healthy).toBe(true);
  });

  test('spring-boot at workspace root with empty buildRoot → healthy', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/settings.gradle', '');
    __writeFs('/ws/build.gradle', '');
    const r = await checkConfigHealth(springBootGradle(''), folder);
    expect(r.healthy).toBe(true);
  });

  test('spring-boot java-main mode with empty buildRoot → healthy (mode ignores buildRoot)', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/api/build.gradle', '');
    const cfg = springBootGradle('api', { launchMode: 'java-main', buildRoot: '' });
    const r = await checkConfigHealth(cfg, folder);
    expect(r.healthy).toBe(true);
  });

  test('tomcat with empty buildRoot on a submodule → healthy (runtime recovers at launch)', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/api/build.gradle', '');
    const cfg: RunConfig = {
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      name: 'tc',
      type: 'tomcat',
      projectPath: 'api',
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
        buildTool: 'gradle',
        gradleCommand: './gradlew',
        gradlePath: '',
        mavenPath: '',
        artifactPath: '/opt/x.war',
        artifactKind: 'war',
        applicationContext: '/',
        profiles: '',
        vmOptions: '',
        reloadable: true,
        rebuildOnSave: false,
      },
    };
    const r = await checkConfigHealth(cfg, folder);
    expect(r.healthy).toBe(true);
  });

  test('maven-goal submodule with empty buildRoot → stale', async () => {
    __writeFs('/ws/pom.xml', '<project><modules><module>api</module></modules></project>');
    __writeFs('/ws/api/pom.xml', '<project/>');
    const cfg: RunConfig = {
      id: 'bbbbbbbb-1111-2222-3333-444444444444',
      name: 'mvn',
      type: 'maven-goal',
      projectPath: 'api',
      workspaceFolder: '',
      env: {},
      programArgs: '',
      vmArgs: '',
      typeOptions: {
        goal: 'test',
        jdkPath: '',
        mavenPath: '',
        buildRoot: '',
      },
    };
    const r = await checkConfigHealth(cfg, folder);
    expect(r.healthy).toBe(false);
  });

  test('gradle-task submodule with empty buildRoot → stale', async () => {
    __writeFs('/ws/gradlew', '');
    __writeFs('/ws/settings.gradle', 'include "tools"');
    __writeFs('/ws/tools/build.gradle', '');
    const cfg: RunConfig = {
      id: 'cccccccc-1111-2222-3333-444444444444',
      name: 'gtask',
      type: 'gradle-task',
      projectPath: 'tools',
      workspaceFolder: '',
      env: {},
      programArgs: '',
      vmArgs: '',
      typeOptions: {
        task: 'test',
        gradleCommand: './gradlew',
        jdkPath: '',
        gradlePath: '',
        buildRoot: '',
      },
    };
    const r = await checkConfigHealth(cfg, folder);
    expect(r.healthy).toBe(false);
  });

  test('npm type never flagged', async () => {
    const cfg: RunConfig = {
      id: 'dddddddd-1111-2222-3333-444444444444',
      name: 'web',
      type: 'npm',
      projectPath: 'frontend',
      workspaceFolder: '',
      env: {},
      programArgs: '',
      vmArgs: '',
      typeOptions: { scriptName: 'start', packageManager: 'npm' },
    };
    const r = await checkConfigHealth(cfg, folder);
    expect(r.healthy).toBe(true);
  });

  test('cached result is reused when fingerprint matches', async () => {
    __writeFs('/ws/gradlew', '');
    __writeFs('/ws/settings.gradle', '');
    __writeFs('/ws/api/build.gradle', '');
    const cfg = springBootGradle('api');
    const first = await checkConfigHealth(cfg, folder);
    // Remove the wrapper — if we re-probed filesystem, we'd now say healthy
    // (no build root to walk up to). Caching must win.
    __resetFs();
    const second = await checkConfigHealth(cfg, folder);
    expect(second).toEqual(first);
  });

  test('cache busts when a relevant field changes', async () => {
    __writeFs('/ws/gradlew', '');
    __writeFs('/ws/settings.gradle', '');
    __writeFs('/ws/api/build.gradle', '');
    const cfg = springBootGradle('api');
    const first = await checkConfigHealth(cfg, folder);
    expect(first.healthy).toBe(false);
    // User re-opens + saves with buildRoot populated.
    const fixed = springBootGradle('api', { buildRoot: '/ws' });
    const second = await checkConfigHealth(fixed, folder);
    expect(second.healthy).toBe(true);
  });
});
