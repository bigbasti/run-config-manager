import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { detectJdks } from '../spring-boot/detectJdks';
import { detectBuildTools } from '../spring-boot/detectBuildTools';
import { findMavenRoot } from '../spring-boot/findBuildRoot';
import { splitArgs } from '../npm/splitArgs';
import { log } from '../../utils/logger';
import type { MavenGoalEntry } from './discoverMavenGoals';

const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';

export class MavenGoalAdapter implements RuntimeAdapter {
  readonly type = 'maven-goal' as const;
  readonly label = 'Maven Goal';
  readonly supportsDebug = false;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Maven Goal detect: ${folder.fsPath}`);
    if (!(await fileExists(vscode.Uri.joinPath(folder, 'pom.xml')))) {
      log.debug(`Maven Goal detect: no pom.xml`);
      return null;
    }

    const [jdks, buildTools, mavenRoot] = await Promise.all([
      detectJdks(),
      detectBuildTools(),
      findMavenRoot(folder),
    ]);

    const buildRoot = mavenRoot.fsPath;
    log.info(
      `Maven Goal detect: jdks=${jdks.length}, ` +
      `mavenInstalls=${buildTools.mavenInstalls.length}, buildRoot=${buildRoot}`,
    );

    return {
      defaults: {
        type: 'maven-goal',
        typeOptions: {
          goal: '',
          jdkPath: jdks[0] ?? '',
          mavenPath: buildTools.mavenInstalls[0] ?? '',
          buildRoot: buildRoot === folder.fsPath ? '' : buildRoot,
          colorOutput: true,
        },
      },
      context: {
        jdks,
        mavenInstalls: buildTools.mavenInstalls,
        buildRoot,
        loadedGoals: [],
      },
    };
  }

  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    log.debug(`Maven Goal detectStreaming: probing ${folder.fsPath}`);
    const hasPom = await fileExists(vscode.Uri.joinPath(folder, 'pom.xml'));
    if (!hasPom) {
      log.debug(`Maven Goal detectStreaming: no pom.xml — bailing`);
      return;
    }

    emit({
      contextPatch: {},
      defaultsPatch: { type: 'maven-goal' as const, typeOptions: {} as any },
      resolved: [],
    });

    (async () => {
      const mavenRoot = await findMavenRoot(folder);
      log.debug(`Maven Goal probe: buildRoot=${mavenRoot.fsPath}`);
      emit({
        contextPatch: { buildRoot: mavenRoot.fsPath },
        defaultsPatch: {
          typeOptions: {
            buildRoot: mavenRoot.fsPath === folder.fsPath ? '' : mavenRoot.fsPath,
          } as any,
        },
        resolved: ['typeOptions.buildRoot'],
      });
    })().catch(e => log.warn(`Maven Goal probe (buildRoot) failed: ${(e as Error).message}`));

    (async () => {
      const jdks = await detectJdks();
      log.debug(`Maven Goal probe: jdks=${jdks.length}`);
      emit({
        contextPatch: { jdks },
        defaultsPatch: jdks[0] ? { typeOptions: { jdkPath: jdks[0] } as any } : undefined,
        resolved: ['typeOptions.jdkPath'],
      });
    })().catch(e => log.warn(`Maven Goal probe (jdks) failed: ${(e as Error).message}`));

    (async () => {
      const bt = await detectBuildTools();
      log.debug(`Maven Goal probe: mavenInstalls=${bt.mavenInstalls.length}`);
      emit({
        contextPatch: { mavenInstalls: bt.mavenInstalls },
        defaultsPatch: { typeOptions: { mavenPath: bt.mavenInstalls[0] ?? '' } as any },
        resolved: ['typeOptions.mavenPath'],
      });
    })().catch(e => log.warn(`Maven Goal probe (buildTools) failed: ${(e as Error).message}`));
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const jdks = (context.jdks as string[] | undefined) ?? [];
    const mavenInstalls = (context.mavenInstalls as string[] | undefined) ?? [];
    const detectedBuildRoot = (context.buildRoot as string | undefined) ?? '';
    const loadedGoals = (context.loadedGoals as MavenGoalEntry[] | undefined) ?? [];

    // Group rows so the dropdown's collapsible sections partition cleanly:
    //   - Lifecycle phases (clean / compile / test / package / ...)
    //   - One section per plugin (Liquibase goals, Spring Boot goals, ...)
    //   - "Plugin prefixes" catch-all for plugins whose describe probe
    //     failed and only the prefix was surfaced as a fallback.
    const goalOptions = loadedGoals.map(g => {
      let group: string;
      if (!g.value.includes(':')) {
        group = 'Lifecycle phases';
      } else if (g.value.endsWith(':')) {
        group = 'Plugin prefixes';
      } else {
        // <prefix>:<goal> — group by prefix with a human-readable label.
        const prefix = g.value.split(':')[0];
        group = `${prefix} goals`;
      }
      return {
        value: g.value,
        label: g.value,
        group,
        description: g.description,
      };
    });

    const goalHelp = loadedGoals.length
      ? 'Maven lifecycle phase or plugin goal. The dropdown is grouped — lifecycle phases + one section per plugin detected in pom.xml with its actual goals (liquibase:dropAll, liquibase:update, …). You can chain multiple phases/goals: `clean install`, `clean verify -Pprod`.'
      : 'Maven lifecycle phase or plugin goal. Click "Load phases & plugin goals" to enumerate what your pom\'s plugins expose. Typical values: `clean install`, `verify -Pprod`, `liquibase:dropAll`.';

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Maven Goal',
          help: 'Display name shown in the sidebar. Purely cosmetic.',
          examples: ['Clean install', 'Liquibase drop'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to the Maven project root, relative to the workspace folder.',
          examples: ['', 'backend', 'services/api'],
        },
      ],
      typeSpecific: [
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.goal',
          label: 'Goal / phase',
          options: goalOptions,
          placeholder: 'clean install',
          help: goalHelp,
          examples: [
            'clean install',
            'clean verify -Pprod',
            'liquibase:dropAll -Dliquibase.url=jdbc:h2:mem:test',
          ],
          inspectable: true,
          action: { id: 'loadGoals', label: 'Load phases & plugin goals', busyLabel: 'Loading…' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mavenPath',
          label: 'Maven installation',
          options: mavenInstalls.map(p => ({ value: p, label: p })),
          placeholder: '/opt/maven/apache-maven-3.9.6',
          help: 'Maven install directory. Leave blank to use `mvn` from PATH.',
          examples: ['/opt/maven/apache-maven-3.9.6', '/usr/share/maven'],
        },
        {
          kind: 'text',
          key: 'typeOptions.buildRoot',
          label: 'Build root',
          placeholder: '(auto-detected)',
          help: `Absolute path to the Maven project root (reactor root for multi-module). Detected: ${detectedBuildRoot || '(same as project path)'}.`,
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.jdkPath',
          label: 'JDK',
          options: jdks.map(p => ({ value: p, label: p })),
          placeholder: '/path/to/jdk',
          help: 'Java installation. Sets JAVA_HOME for mvn.',
          examples: ['/usr/lib/jvm/jdk-21', '/opt/jdk-17'],
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          help: 'Sets FORCE_COLOR=1 / CLICOLOR_FORCE=1 so libraries that auto-detect TTY don\'t strip ANSI codes.',
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['MAVEN_OPTS=-Xmx2g', 'DB_URL=${DB_URL}'],
        },
      ],
    };
  }

  buildCommand(cfg: RunConfig, _folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'maven-goal') {
      throw new Error('MavenGoalAdapter received non-maven-goal config');
    }
    const to = cfg.typeOptions;
    const binary = to.mavenPath
      ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn`
      : 'mvn';
    return { command: binary, args: splitArgs(to.goal) };
  }

  async prepareLaunch(
    cfg: RunConfig,
    _folder: vscode.WorkspaceFolder,
    _ctx: { debug: boolean; debugPort?: number },
  ): Promise<{ env?: Record<string, string> }> {
    if (cfg.type !== 'maven-goal') return {};
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

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
