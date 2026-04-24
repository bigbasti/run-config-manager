import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { detectJdks } from '../spring-boot/detectJdks';
import { detectBuildTools } from '../spring-boot/detectBuildTools';
import { findGradleRoot } from '../spring-boot/findBuildRoot';
import { resolveProjectUri } from '../../utils/paths';
import { splitArgs } from '../npm/splitArgs';
import { log } from '../../utils/logger';
import type { GradleTaskEntry } from './discoverGradleTasks';

const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';

export class GradleTaskAdapter implements RuntimeAdapter {
  readonly type = 'gradle-task' as const;
  readonly label = 'Gradle Task';
  readonly supportsDebug = false;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Gradle Task detect: ${folder.fsPath}`);
    if (!(await hasGradleBuild(folder))) {
      log.debug(`Gradle Task detect: no build.gradle / gradlew`);
      return null;
    }

    const [gradleCommand, jdks, buildTools, gradleRoot] = await Promise.all([
      detectGradleCommand(folder),
      detectJdks(),
      detectBuildTools(),
      findGradleRoot(folder),
    ]);

    const buildRoot = gradleRoot.fsPath;
    const effectiveGradleCommand: 'gradle' | './gradlew' =
      (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
        ? './gradlew'
        : gradleCommand;

    log.info(
      `Gradle Task detect: gradleCommand=${effectiveGradleCommand}, ` +
      `jdks=${jdks.length}, gradleInstalls=${buildTools.gradleInstalls.length}, ` +
      `buildRoot=${buildRoot}`,
    );

    return {
      defaults: {
        type: 'gradle-task',
        typeOptions: {
          task: '',
          gradleCommand: effectiveGradleCommand,
          jdkPath: jdks[0] ?? '',
          gradlePath: buildTools.gradleInstalls[0] ?? '',
          buildRoot: buildRoot === folder.fsPath ? '' : buildRoot,
          colorOutput: true,
        },
      },
      context: {
        gradleCommand: effectiveGradleCommand,
        jdks,
        gradleInstalls: buildTools.gradleInstalls,
        buildRoot,
        // Populated on demand via the 'loadTasks' action — empty at first.
        loadedTasks: [],
      },
    };
  }

  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    log.debug(`Gradle Task detectStreaming: probing ${folder.fsPath}`);
    if (!(await hasGradleBuild(folder))) {
      log.debug(`Gradle Task detectStreaming: no build file — bailing`);
      return;
    }

    emit({
      contextPatch: {},
      defaultsPatch: { type: 'gradle-task' as const, typeOptions: {} as any },
      resolved: [],
    });

    (async () => {
      const gradleCommand = await detectGradleCommand(folder);
      const gradleRoot = await findGradleRoot(folder);
      const effective: 'gradle' | './gradlew' =
        (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
          ? './gradlew'
          : gradleCommand;
      log.debug(`Gradle Task probe: gradleCommand=${effective}, buildRoot=${gradleRoot.fsPath}`);
      emit({
        contextPatch: { gradleCommand: effective, buildRoot: gradleRoot.fsPath },
        defaultsPatch: {
          typeOptions: {
            gradleCommand: effective,
            buildRoot: gradleRoot.fsPath === folder.fsPath ? '' : gradleRoot.fsPath,
          } as any,
        },
        resolved: ['typeOptions.gradleCommand', 'typeOptions.buildRoot'],
      });
    })().catch(e => log.warn(`Gradle Task probe (gradleCommand/buildRoot) failed: ${(e as Error).message}`));

    (async () => {
      const jdks = await detectJdks();
      log.debug(`Gradle Task probe: jdks=${jdks.length}`);
      emit({
        contextPatch: { jdks },
        defaultsPatch: jdks[0] ? { typeOptions: { jdkPath: jdks[0] } as any } : undefined,
        resolved: ['typeOptions.jdkPath'],
      });
    })().catch(e => log.warn(`Gradle Task probe (jdks) failed: ${(e as Error).message}`));

    (async () => {
      const bt = await detectBuildTools();
      log.debug(`Gradle Task probe: gradleInstalls=${bt.gradleInstalls.length}`);
      emit({
        contextPatch: { gradleInstalls: bt.gradleInstalls },
        defaultsPatch: { typeOptions: { gradlePath: bt.gradleInstalls[0] ?? '' } as any },
        resolved: ['typeOptions.gradlePath'],
      });
    })().catch(e => log.warn(`Gradle Task probe (buildTools) failed: ${(e as Error).message}`));
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const jdks = (context.jdks as string[] | undefined) ?? [];
    const gradleInstalls = (context.gradleInstalls as string[] | undefined) ?? [];
    const detectedBuildRoot = (context.buildRoot as string | undefined) ?? '';
    const loadedTasks = (context.loadedTasks as GradleTaskEntry[] | undefined) ?? [];

    // Emit structured options — SelectOrCustom will use `group` for its
    // collapsible section headers and `description` for the dim column on
    // each row. The `label` stays as just the task name so the filter
    // matches what the user sees.
    const taskOptions = loadedTasks.map(t => ({
      value: t.name,
      label: t.name,
      group: t.group,
      description: t.description,
    }));

    const taskHelp = loadedTasks.length
      ? `Gradle task name. ${loadedTasks.length} task(s) discovered; pick from the dropdown or type a fully-qualified name (e.g. \`:api:test\`). ` +
        'Arguments are supported: `assemble --parallel`, `:systemtest:test --tests "pkg.*"`.'
      : 'Gradle task name. Click "Load tasks from Gradle" to discover available tasks (may take up to a minute on a cold daemon); in the meantime type any task name, including module-scoped ones like `:api:test` and flags like `--tests "pkg.*"`.';

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Gradle Task',
          help: 'Display name shown in the sidebar. Purely cosmetic.',
          examples: ['Drop schema', 'Systemtest'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          validateBuildPath: 'gradle',
          help: 'Path to the Gradle project root, relative to the workspace folder.',
          examples: ['', 'backend', 'systemtest'],
        },
      ],
      typeSpecific: [
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.task',
          label: 'Task',
          options: taskOptions,
          placeholder: 'dropAll',
          help: taskHelp,
          examples: [
            'dropAll',
            'clean build',
            ':api:test --tests "com.example.*IT"',
          ],
          inspectable: true,
          action: { id: 'loadTasks', label: 'Load tasks from Gradle', busyLabel: 'Loading…' },
        },
        {
          kind: 'select',
          key: 'typeOptions.gradleCommand',
          label: 'Gradle command',
          options: [
            { value: './gradlew', label: './gradlew (wrapper)' },
            { value: 'gradle', label: 'gradle (system)' },
          ],
          help: 'Which gradle binary to invoke. Use the wrapper when possible for version reproducibility.',
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.gradlePath',
          label: 'Gradle installation',
          options: gradleInstalls.map(p => ({ value: p, label: p })),
          placeholder: '/opt/gradle/gradle-8.5',
          help: 'Gradle install directory. Used only when "Gradle command" is "gradle" (system). Leave blank to use `gradle` from PATH.',
          examples: ['/opt/gradle/gradle-8.5', '/usr/share/gradle'],
          dependsOn: { key: 'typeOptions.gradleCommand', equals: 'gradle' },
        },
        {
          kind: 'text',
          key: 'typeOptions.buildRoot',
          label: 'Build root',
          placeholder: '(auto-detected)',
          help: `Absolute path to the Gradle project root. Detected: ${detectedBuildRoot || '(same as project path)'}. Override only if auto-detection picked wrong.`,
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.jdkPath',
          label: 'JDK',
          options: jdks.map(p => ({ value: p, label: p })),
          placeholder: '/path/to/jdk',
          help: 'Java installation. Sets JAVA_HOME for the task. Leave blank to use the build tool\'s default.',
          examples: ['/usr/lib/jvm/jdk-21', '/opt/jdk-17'],
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          help: 'Sets FORCE_COLOR=1 / CLICOLOR_FORCE=1. Note that `--console=plain` (needed for the integrated terminal) still strips some Gradle-native colors; this mostly affects output from tools the task forks.',
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['DB_URL=${DB_URL}', 'GRADLE_OPTS=-Xmx2g'],
        },
      ],
    };
  }

  buildCommand(cfg: RunConfig, _folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'gradle-task') {
      throw new Error('GradleTaskAdapter received non-gradle-task config');
    }
    const to = cfg.typeOptions;
    const binary = to.gradleCommand === './gradlew'
      ? './gradlew'
      : to.gradlePath ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle` : 'gradle';
    const args = ['--console=plain', ...splitArgs(to.task)];
    return { command: binary, args };
  }

  async prepareLaunch(
    cfg: RunConfig,
    _folder: vscode.WorkspaceFolder,
    _ctx: { debug: boolean; debugPort?: number },
  ): Promise<{ env?: Record<string, string> }> {
    if (cfg.type !== 'gradle-task') return {};
    const env: Record<string, string> = {};
    if (cfg.typeOptions.colorOutput) {
      env.FORCE_COLOR = '1';
      env.CLICOLOR_FORCE = '1';
    }
    if (cfg.typeOptions.jdkPath) {
      env.JAVA_HOME = cfg.typeOptions.jdkPath;
    }
    return { env };
  }
}

async function hasGradleBuild(folder: vscode.Uri): Promise<boolean> {
  const candidates = ['build.gradle', 'build.gradle.kts', 'gradlew', 'settings.gradle', 'settings.gradle.kts'];
  for (const c of candidates) {
    if (await fileExists(vscode.Uri.joinPath(folder, c))) return true;
  }
  // Walk up one level to handle selecting a module in a multi-module project.
  const parent = parentOf(folder);
  if (parent) {
    for (const c of ['settings.gradle', 'settings.gradle.kts', 'gradlew']) {
      if (await fileExists(vscode.Uri.joinPath(parent, c))) return true;
    }
  }
  return false;
}

function parentOf(uri: vscode.Uri): vscode.Uri | null {
  const parts = uri.fsPath.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  return vscode.Uri.file('/' + parts.slice(0, -1).join('/'));
}

async function detectGradleCommand(folder: vscode.Uri): Promise<'./gradlew' | 'gradle'> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, 'gradlew'));
    return './gradlew';
  } catch {
    return 'gradle';
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
