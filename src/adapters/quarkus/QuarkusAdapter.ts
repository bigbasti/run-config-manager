import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { readQuarkusInfo } from './detectQuarkus';
import { findQuarkusProfiles } from './findQuarkusProfiles';
import { detectQuarkusPort, safeDetect } from '../../services/detectProjectPort';
import { detectJdks } from '../spring-boot/detectJdks';
import { probeJdksStreaming, readJdks, jdkOption } from '../spring-boot/probeJdksStreaming';
import { detectBuildTools } from '../spring-boot/detectBuildTools';
import { findGradleRoot, findMavenRoot, gradleModulePrefix } from '../spring-boot/findBuildRoot';
import { resolveProjectUri } from '../../utils/paths';
import { dependsOnField, envFilesField } from '../sharedFields';
import { splitArgs } from '../npm/splitArgs';
import { log } from '../../utils/logger';

const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';

export class QuarkusAdapter implements RuntimeAdapter {
  readonly type = 'quarkus' as const;
  readonly label = 'Quarkus';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Quarkus detect: ${folder.fsPath}`);
    const info = await readQuarkusInfo(folder);
    if (!info) {
      log.debug(`Quarkus detect: no match`);
      return null;
    }

    const [gradleCommand, jdks, buildTools, gradleRoot, mavenRoot, profiles] = await Promise.all([
      detectGradleCommand(folder),
      detectJdks(),
      detectBuildTools(),
      info.buildTool === 'gradle' ? findGradleRoot(folder) : Promise.resolve(folder),
      info.buildTool === 'maven' ? findMavenRoot(folder) : Promise.resolve(folder),
      findQuarkusProfiles(folder),
    ]);

    const buildRoot = info.buildTool === 'gradle' ? gradleRoot.fsPath : mavenRoot.fsPath;
    const effectiveGradleCommand: 'gradle' | './gradlew' =
      info.buildTool === 'gradle' && (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
        ? './gradlew'
        : gradleCommand;

    log.info(
      `Quarkus detect: buildTool=${info.buildTool}, jdks=${jdks.length}, ` +
      `profiles=${profiles.length}, buildRoot=${buildRoot}`,
    );

    return {
      defaults: {
        type: 'quarkus',
        typeOptions: {
          launchMode: info.buildTool,
          buildTool: info.buildTool,
          gradleCommand: effectiveGradleCommand,
          profile: '',
          jdkPath: jdks[0] ?? '',
          module: '',
          gradlePath: buildTools.gradleInstalls[0] ?? '',
          mavenPath: buildTools.mavenInstalls[0] ?? '',
          buildRoot: buildRoot === folder.fsPath ? '' : buildRoot,
          debugPort: 5005,
          colorOutput: true,
        },
      },
      context: {
        buildTool: info.buildTool,
        gradleCommand: effectiveGradleCommand,
        jdks: jdks.map(p => ({ path: p })),
        gradleInstalls: buildTools.gradleInstalls,
        mavenInstalls: buildTools.mavenInstalls,
        buildRoot,
        profiles,
      },
    };
  }

  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    log.debug(`Quarkus detectStreaming: probing ${folder.fsPath}`);
    const info = await readQuarkusInfo(folder);
    if (!info) {
      log.debug(`Quarkus detectStreaming: no Quarkus markers — bailing`);
      return;
    }
    log.debug(`Quarkus detectStreaming: buildTool=${info.buildTool}`);

    // Emit the build-tool verdict first so the form knows which launch mode to
    // show — everything downstream depends on it.
    emit({
      contextPatch: { buildTool: info.buildTool },
      defaultsPatch: {
        type: 'quarkus' as const,
        typeOptions: {
          buildTool: info.buildTool,
          launchMode: info.buildTool,
        } as any,
      },
      resolved: [],
    });

    (async () => {
      const gradleCommand = await detectGradleCommand(folder);
      const gradleRoot = info.buildTool === 'gradle' ? await findGradleRoot(folder) : folder;
      const mavenRoot = info.buildTool === 'maven' ? await findMavenRoot(folder) : folder;
      const buildRoot = info.buildTool === 'gradle' ? gradleRoot.fsPath : mavenRoot.fsPath;
      const effective: 'gradle' | './gradlew' =
        info.buildTool === 'gradle' && (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
          ? './gradlew'
          : gradleCommand;
      log.debug(`Quarkus probe: gradleCommand=${effective}, buildRoot=${buildRoot}`);
      emit({
        contextPatch: { gradleCommand: effective, buildRoot },
        defaultsPatch: {
          typeOptions: {
            gradleCommand: effective,
            buildRoot: buildRoot === folder.fsPath ? '' : buildRoot,
          } as any,
        },
        resolved: ['typeOptions.gradleCommand', 'typeOptions.buildRoot'],
      });
    })().catch(e => log.warn(`Quarkus probe (gradleCommand/buildRoot) failed: ${(e as Error).message}`));

    (async () => {
      const profiles = await findQuarkusProfiles(folder);
      log.debug(`Quarkus probe: profiles=${profiles.length}`);
      emit({ contextPatch: { profiles }, resolved: ['typeOptions.profile'] });
    })().catch(e => log.warn(`Quarkus probe (profiles) failed: ${(e as Error).message}`));

    // Port detection — reads application.{properties,yml} for quarkus.http.port.
    // No profile passed on initial create; detectQuarkusPort returns the
    // plain-default value. Users can re-run when they pick a profile.
    (async () => {
      const port = await safeDetect('quarkus:port', () => detectQuarkusPort(folder, undefined));
      if (port) {
        log.debug(`Quarkus probe: port=${port}`);
        emit({ contextPatch: {}, defaultsPatch: { port } as any, resolved: ['port'] });
      }
    })().catch(e => log.warn(`Quarkus probe (port) failed: ${(e as Error).message}`));

    probeJdksStreaming(emit, 'quarkus').catch(e =>
      log.warn(`Quarkus probe (jdks) failed: ${(e as Error).message}`),
    );

    (async () => {
      const bt = await detectBuildTools();
      log.debug(`Quarkus probe: gradleInstalls=${bt.gradleInstalls.length}, mavenInstalls=${bt.mavenInstalls.length}`);
      emit({
        contextPatch: { gradleInstalls: bt.gradleInstalls, mavenInstalls: bt.mavenInstalls },
        defaultsPatch: {
          typeOptions: {
            gradlePath: bt.gradleInstalls[0] ?? '',
            mavenPath: bt.mavenInstalls[0] ?? '',
          } as any,
        },
        resolved: ['typeOptions.gradlePath', 'typeOptions.mavenPath'],
      });
    })().catch(e => log.warn(`Quarkus probe (buildTools) failed: ${(e as Error).message}`));
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const jdks = readJdks(context.jdks);
    const gradleInstalls = (context.gradleInstalls as string[] | undefined) ?? [];
    const mavenInstalls = (context.mavenInstalls as string[] | undefined) ?? [];
    const detectedBuildTool = (context.buildTool as string | undefined) ?? 'maven';
    const detectedGradle = (context.gradleCommand as string | undefined) ?? './gradlew';
    const detectedBuildRoot = (context.buildRoot as string | undefined) ?? '';
    const detectedProfiles = (context.profiles as string[] | undefined) ?? [];

    const jdkOptions = jdks.map(jdkOption);
    const gradleInstallOptions = gradleInstalls.map(p => ({ value: p, label: p }));
    const mavenInstallOptions = mavenInstalls.map(p => ({ value: p, label: p }));
    const profileOptions = detectedProfiles.map(p => ({ value: p, label: p }));

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Quarkus App',
          help: 'Display name shown in the sidebar. Purely cosmetic.',
          examples: ['API server', 'Backend dev'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          validateBuildPath: 'either',
          help: 'Path to the Quarkus project root, relative to the workspace folder.',
          examples: ['', 'backend', 'services/api'],
        },
        {
          kind: 'select',
          key: 'typeOptions.launchMode',
          label: 'Launch mode',
          options: [
            { value: 'maven', label: 'Maven (mvn quarkus:dev)' },
            { value: 'gradle', label: 'Gradle (quarkusDev)' },
          ],
          help: `How to start the app in dev mode. Quarkus dev mode has built-in Live Coding — no separate watcher task needed. Detected build tool: ${detectedBuildTool}.`,
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.profile',
          label: 'Profile',
          options: profileOptions,
          placeholder: detectedProfiles.length ? 'Pick or type a profile' : 'dev',
          help: detectedProfiles.length
            ? `Detected ${detectedProfiles.length} profile(s) from application.properties / application-*.yml. Passed as -Dquarkus.profile. Quarkus honors only one active profile.`
            : 'Active Quarkus profile (passed as -Dquarkus.profile). Quarkus honors only one profile at a time. Leave blank to use the default (dev in quarkus:dev).',
          examples: ['dev', 'staging', 'local'],
        },
      ],
      typeSpecific: [
        {
          kind: 'select',
          key: 'typeOptions.gradleCommand',
          label: 'Gradle command',
          options: [
            { value: './gradlew', label: './gradlew (wrapper)' },
            { value: 'gradle', label: 'gradle (system)' },
          ],
          help: `Which gradle binary to invoke. Detected: ${detectedGradle}. Override if the wrapper is missing or out-of-date.`,
          dependsOn: { key: 'typeOptions.launchMode', equals: 'gradle' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.gradlePath',
          label: 'Gradle installation',
          options: gradleInstallOptions,
          placeholder: '/opt/gradle/gradle-7.6.2',
          help: 'Gradle install directory. Used only when "Gradle command" is set to "gradle" (system). Leave blank to use "gradle" from PATH.',
          examples: ['/opt/gradle/gradle-8.5', '/usr/share/gradle'],
          dependsOn: { key: 'typeOptions.gradleCommand', equals: 'gradle' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mavenPath',
          label: 'Maven installation',
          options: mavenInstallOptions,
          placeholder: '/opt/maven/apache-maven-3.9.6',
          help: 'Maven install directory. Leave blank to use "mvn" from PATH.',
          examples: ['/opt/maven/apache-maven-3.9.6', '/usr/share/maven'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'maven' },
        },
        {
          kind: 'text',
          key: 'typeOptions.buildRoot',
          label: 'Build root',
          placeholder: '(auto-detected)',
          help: `Absolute path to the Gradle/Maven project root. Detected: ${detectedBuildRoot || '(same as project path)'}. Override only if auto-detection picked wrong.`,
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.jdkPath',
          label: 'JDK',
          options: jdkOptions,
          placeholder: '/path/to/jdk',
          help: 'Java installation. Sets JAVA_HOME before launching the build tool. Leave blank to use the build tool\'s default.',
          examples: ['/usr/lib/jvm/jdk-21', '/opt/jdk-17'],
          action: { id: 'openJdkDownload', label: '☁', title: 'Download and install a JDK', inline: true },
        },
        {
          kind: 'text',
          key: 'typeOptions.module',
          label: 'Module (optional)',
          placeholder: 'api',
          help: 'For multi-module Gradle projects, the submodule name. Used to scope the quarkusDev task as :<module>:quarkusDev.',
          examples: ['api', 'services/auth'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'gradle' },
        },
        {
          kind: 'number',
          key: 'port',
          label: 'Port (optional)',
          min: 1,
          max: 65535,
          help: 'Informational — the app itself is responsible for binding.',
          examples: ['8080', '8081'],
        },
        {
          kind: 'number',
          key: 'typeOptions.debugPort',
          label: 'Debug port',
          min: 1,
          max: 65535,
          help: 'JDWP port. Quarkus dev mode opens this port automatically (via -Ddebug=<port>). Default 5005.',
          examples: ['5005', '5006'],
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          help:
            'Sets FORCE_COLOR=1 and CLICOLOR_FORCE=1 so libraries that auto-detect TTY don\'t strip ANSI codes. Quarkus\'s console usually gets colors right on its own, but the integrated terminal can confuse its detection.',
        },
      ],
      advanced: [
        envFilesField(),
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['QUARKUS_PROFILE=dev', 'JAVA_HOME=/opt/jdk-21', 'DB_URL=${DB_URL}'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--server.port=8081',
          help: 'Passed to the Quarkus app. ' + VAR_SYNTAX_HINT,
          examples: ['--config=${workspaceFolder}/conf'],
          inspectable: true,
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args',
          placeholder: '-Xmx1g',
          help:
            'JVM flags. Quarkus dev mode forwards these to the forked JVM via -Djvm.args when set. ' +
            VAR_SYNTAX_HINT,
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC'],
          inspectable: true,
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
      ],
    };
  }

  buildCommand(cfg: RunConfig, folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'quarkus') {
      throw new Error('QuarkusAdapter received non-quarkus config');
    }
    if (cfg.typeOptions.launchMode === 'maven') return buildMaven(cfg);
    return buildGradle(cfg, folder);
  }

  async prepareLaunch(
    cfg: RunConfig,
    _folder: vscode.WorkspaceFolder,
    _ctx: { debug: boolean; debugPort?: number },
  ): Promise<{ env?: Record<string, string> }> {
    if (cfg.type !== 'quarkus') return {};
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

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    if (cfg.type !== 'quarkus') {
      throw new Error('QuarkusAdapter received non-quarkus config');
    }
    const port = typeof cfg.typeOptions.debugPort === 'number' ? cfg.typeOptions.debugPort : 5005;
    const projectUri = resolveProjectUri(folder, cfg.projectPath);
    // Attach to the JDWP socket that `quarkus:dev` / `quarkusDev` opened by
    // itself via the -Ddebug=<port> flag baked into buildCommand. Same redhat
    // .java-indexing workarounds as the Spring Boot attach config so the
    // debugger doesn't stall on "Resolving main class".
    return {
      type: 'java',
      request: 'attach',
      name: cfg.name,
      hostName: 'localhost',
      port,
      projectName: '',
      modulePaths: [],
      sourcePaths: [projectUri.fsPath],
      shortenCommandLine: 'auto',
      timeout: 60_000,
    };
  }
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

function mavenBinary(to: Extract<RunConfig, { type: 'quarkus' }>['typeOptions']): string {
  return to.mavenPath ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn` : 'mvn';
}

function gradleBinary(to: Extract<RunConfig, { type: 'quarkus' }>['typeOptions']): string {
  if (to.gradleCommand === './gradlew') return './gradlew';
  return to.gradlePath ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle` : 'gradle';
}

function debugPortOrDefault(to: Extract<RunConfig, { type: 'quarkus' }>['typeOptions']): number {
  return typeof to.debugPort === 'number' && to.debugPort > 0 ? to.debugPort : 5005;
}

function buildMaven(cfg: Extract<RunConfig, { type: 'quarkus' }>) {
  const to = cfg.typeOptions;
  const args: string[] = ['quarkus:dev'];
  const profile = to.profile.trim();
  if (profile) args.push(`-Dquarkus.profile=${profile}`);
  args.push(`-Ddebug=${debugPortOrDefault(to)}`);

  // Pass program args via -Dquarkus.args (Quarkus's documented way to feed
  // arguments to the application under dev mode).
  const programArgs = splitArgs(cfg.programArgs ?? '');
  if (programArgs.length > 0) {
    args.push(`-Dquarkus.args=${shellQuote(programArgs.join(' '))}`);
  }
  // JVM args forwarded via -Djvm.args (picked up by the quarkus-maven-plugin
  // and applied to the forked JVM).
  const vmArgs = (cfg.vmArgs ?? '').trim();
  if (vmArgs) args.push(`-Djvm.args=${shellQuote(vmArgs)}`);

  return { command: mavenBinary(to), args };
}

function buildGradle(
  cfg: Extract<RunConfig, { type: 'quarkus' }>,
  folder?: vscode.WorkspaceFolder,
) {
  const to = cfg.typeOptions;
  let task = 'quarkusDev';
  if (to.buildRoot && folder) {
    const projectAbs = resolveProjectUri(folder, cfg.projectPath).fsPath;
    const modulePrefix = gradleModulePrefix(to.buildRoot, projectAbs);
    if (modulePrefix) task = `${modulePrefix}:quarkusDev`;
  }

  // --console=plain prevents the Gradle daemon from hijacking the terminal
  // for its progress bar, which interferes with Quarkus's own interactive
  // dev-mode menu (press r to reload, etc.).
  const args: string[] = ['--console=plain', task];
  const profile = to.profile.trim();
  if (profile) args.push(`-Dquarkus.profile=${profile}`);
  args.push(`-Ddebug=${debugPortOrDefault(to)}`);
  // Bind JDWP on all interfaces so attach works across WSL/container boundaries
  // (same rationale as the Tomcat adapter's bind choice).
  args.push('-DdebugHost=0.0.0.0');

  const programArgs = splitArgs(cfg.programArgs ?? '');
  if (programArgs.length > 0) {
    args.push(`-Dquarkus.args=${shellQuote(programArgs.join(' '))}`);
  }
  const vmArgs = (cfg.vmArgs ?? '').trim();
  if (vmArgs) args.push(`-Djvm.args=${shellQuote(vmArgs)}`);

  return { command: gradleBinary(to), args };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
