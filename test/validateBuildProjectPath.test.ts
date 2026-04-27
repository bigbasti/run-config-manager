import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri } from 'vscode';
import { validateBuildProjectPath } from '../src/utils/validateBuildProjectPath';

// These tests build real directories under os.tmpdir() because the helper
// uses vscode.workspace.fs.stat (mocked against an in-memory FS in other
// tests) but the validator calls through real-path logic on its arguments
// — simpler to test on real fs. The __mocks__/vscode.ts shim forwards
// stat to its in-memory map, so we ALSO need to populate that. We use
// __writeFs to cover both paths.

import { __resetFs, __writeFs } from 'vscode';

const WORKSPACE = '/ws';
const folder = { uri: Uri.file(WORKSPACE), name: 'ws', index: 0 } as any;

describe('validateBuildProjectPath', () => {
  beforeEach(() => __resetFs());

  test('pom.xml at the chosen path → ok', async () => {
    __writeFs('/ws/api/pom.xml', '<project/>');
    const r = await validateBuildProjectPath(folder, 'api', 'maven');
    expect(r.ok).toBe(true);
  });

  test('no pom.xml, but parent has one → suggests parent', async () => {
    __writeFs('/ws/pom.xml', '<project/>');
    __writeFs('/ws/src/main/java/foo.txt', 'x');
    const r = await validateBuildProjectPath(folder, 'src/main/java', 'maven');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/pom\.xml/i);
      expect(r.suggestion).toBe('');   // relative to workspace = root
    }
  });

  test('Gradle submodule with ancestor wrapper → ok (adapters resolve the root)', async () => {
    // The exact scenario from the bug report: user picks /ws/queue-watcher
    // which has build.gradle but no gradlew. The workspace root /ws has
    // gradlew + settings.gradle. The adapters handle this via
    // findGradleRoot + :<module>:task prefix + cwd=root.
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/settings.gradle', 'include "queue-watcher"');
    __writeFs('/ws/queue-watcher/build.gradle', '');
    const r = await validateBuildProjectPath(folder, 'queue-watcher', 'gradle');
    expect(r.ok).toBe(true);
  });

  test('Gradle submodule WITHOUT any ancestor wrapper → fails', async () => {
    // No gradlew anywhere — genuinely can't run Gradle from here.
    __writeFs('/ws/orphan/build.gradle', '');
    const r = await validateBuildProjectPath(folder, 'orphan', 'gradle');
    expect(r.ok).toBe(false);
  });

  test('build.gradle.kts with settings.gradle.kts in same dir → ok', async () => {
    __writeFs('/ws/mod/build.gradle.kts', '');
    __writeFs('/ws/mod/settings.gradle.kts', '');
    const r = await validateBuildProjectPath(folder, 'mod', 'gradle');
    expect(r.ok).toBe(true);
  });

  test('gradlew wrapper alone counts as a valid Gradle root', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    const r = await validateBuildProjectPath(folder, '', 'gradle');
    expect(r.ok).toBe(true);
  });

  test('"either" accepts pom.xml or Gradle roots (wrapper OR settings)', async () => {
    __writeFs('/ws/a/pom.xml', '');
    __writeFs('/ws/b/gradlew', '#!/bin/bash');
    __writeFs('/ws/c/settings.gradle', '');
    expect((await validateBuildProjectPath(folder, 'a', 'either')).ok).toBe(true);
    expect((await validateBuildProjectPath(folder, 'b', 'either')).ok).toBe(true);
    expect((await validateBuildProjectPath(folder, 'c', 'either')).ok).toBe(true);
  });

  test('"either" accepts Gradle submodule when ancestor has wrapper', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/submodule/build.gradle', '');
    const r = await validateBuildProjectPath(folder, 'submodule', 'either');
    expect(r.ok).toBe(true);
  });

  test('maven-only strict: build.gradle at path does NOT satisfy maven', async () => {
    __writeFs('/ws/a/build.gradle', '');
    const r = await validateBuildProjectPath(folder, 'a', 'maven');
    expect(r.ok).toBe(false);
  });

  test('nothing found anywhere → no suggestion', async () => {
    __writeFs('/ws/empty/.gitkeep', 'x');
    const r = await validateBuildProjectPath(folder, 'empty', 'maven');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion).toBeUndefined();
  });

  test('path escaping the workspace via ../ is rejected', async () => {
    const r = await validateBuildProjectPath(folder, '../outside', 'maven');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside the workspace/i);
  });

  test('blank projectPath checks the workspace root itself', async () => {
    __writeFs('/ws/pom.xml', '');
    const r = await validateBuildProjectPath(folder, '', 'maven');
    expect(r.ok).toBe(true);
  });

  test('settings.gradle anchors Gradle validity', async () => {
    __writeFs('/ws/settings.gradle', '');
    const r = await validateBuildProjectPath(folder, '', 'gradle');
    expect(r.ok).toBe(true);
  });

  test('deep subdir with no build.gradle still warns (not a submodule)', async () => {
    // /ws/modules/a/b/c has no build.gradle at all — it's not a Gradle
    // submodule; it's a random directory. Warn and suggest the root.
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/modules/a/b/c/.empty', '');
    const r = await validateBuildProjectPath(folder, 'modules/a/b/c', 'gradle');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion).toBe('');
  });

  test('deep submodule with build.gradle + ancestor wrapper → ok', async () => {
    __writeFs('/ws/gradlew', '#!/bin/bash');
    __writeFs('/ws/modules/a/build.gradle', '');
    const r = await validateBuildProjectPath(folder, 'modules/a', 'gradle');
    expect(r.ok).toBe(true);
  });
});
