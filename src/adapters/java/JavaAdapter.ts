import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { detectJavaApp } from './detectJavaApp';
import { findMainClasses, type MainClassCandidate } from '../java-shared/findMainClasses';
import { detectJdks } from '../spring-boot/detectJdks';
import { detectBuildTools } from '../spring-boot/detectBuildTools';
import { findGradleRoot, findMavenRoot, gradleModulePrefix } from '../spring-boot/findBuildRoot';
import { suggestClasspath } from '../spring-boot/suggestClasspath';
import { resolveProjectUri } from '../../utils/paths';
import { splitArgs } from '../npm/splitArgs';
import { log } from '../../utils/logger';
import { dependsOnField } from '../sharedFields';

const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';

export class JavaAdapter implements RuntimeAdapter {
  readonly type = 'java' as const;
  readonly label = 'Java Application';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Java detect: ${folder.fsPath}`);
    const info = await detectJavaApp(folder);
    if (!info) {
      log.debug(`Java detect: no match (not a plain Java project, or framework markers present)`);
      return null;
    }

    const [mainClasses, gradleCommand, jdks, buildTools, gradleRoot, mavenRoot, classpath] =
      await Promise.all([
        findMainClasses(folder),
        detectGradleCommand(folder),
        detectJdks(),
        detectBuildTools(),
        info.buildTool === 'gradle' ? findGradleRoot(folder) : Promise.resolve(folder),
        info.buildTool === 'maven' ? findMavenRoot(folder) : Promise.resolve(folder),
        info.buildTool ? suggestClasspath(folder, info.buildTool) : Promise.resolve(''),
      ]);

    const buildRoot = info.buildTool === 'gradle' ? gradleRoot.fsPath : mavenRoot.fsPath;
    const effectiveGradleCommand: 'gradle' | './gradlew' =
      info.buildTool === 'gradle' && (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
        ? './gradlew'
        : gradleCommand;

    // No build file → default to java-main. With build file, follow the
    // build tool.
    const launchMode: 'maven' | 'gradle' | 'java-main' =
      info.buildTool === 'maven' ? 'maven'
      : info.buildTool === 'gradle' ? 'gradle'
      : 'java-main';

    log.info(
      `Java detect: buildTool=${info.buildTool ?? 'none'}, launchMode=${launchMode}, ` +
      `mainClasses=${mainClasses.length}, jdks=${jdks.length}, ` +
      `gradleInstalls=${buildTools.gradleInstalls.length}, mavenInstalls=${buildTools.mavenInstalls.length}, ` +
      `buildRoot=${buildRoot}`,
    );

    return {
      defaults: {
        type: 'java',
        typeOptions: {
          launchMode,
          buildTool: info.buildTool ?? 'maven',
          gradleCommand: effectiveGradleCommand,
          mainClass: mainClasses[0]?.fqn ?? '',
          classpath,
          customArgs: '',
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
        hasApplicationPlugin: info.hasApplicationPlugin,
        mainClasses,
        jdks,
        gradleInstalls: buildTools.gradleInstalls,
        mavenInstalls: buildTools.mavenInstalls,
        buildRoot,
      },
    };
  }

  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    // When the user manually picks "Java Application" in the Add dialog, they
    // might point at a Spring Boot / Quarkus / Tomcat project on purpose —
    // typically to use the gradle-custom / maven-custom launch modes for
    // running a test task, a clean build, etc. The strict negative gate in
    // detectJavaApp (used by auto-create to keep priority ordering sane)
    // would reject those projects and leave the form empty.
    //
    // detectStreaming sees only the explicit manual path. We run a stripped-
    // down build-file probe here so JDKs / build-tool installs / main classes
    // all still populate, regardless of what framework the project uses.
    log.debug(`Java detectStreaming: probing ${folder.fsPath}`);
    const info = await probeBuildTool(folder);
    if (!info.buildTool && !info.hasSourceTree) {
      log.debug(`Java detectStreaming: no build file and no source tree — bailing`);
      return;
    }
    log.debug(
      `Java detectStreaming: buildTool=${info.buildTool ?? 'none'}, ` +
      `applicationPlugin=${info.hasApplicationPlugin}, sourceTree=${info.hasSourceTree}`,
    );

    emit({
      contextPatch: { buildTool: info.buildTool, hasApplicationPlugin: info.hasApplicationPlugin },
      defaultsPatch: {
        type: 'java' as const,
        typeOptions: {
          buildTool: info.buildTool ?? 'maven',
          launchMode: info.buildTool ?? 'java-main',
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
      log.debug(`Java probe: gradleCommand=${effective}, buildRoot=${buildRoot}`);
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
    })().catch(e => log.warn(`Java probe (gradleCommand/buildRoot) failed: ${(e as Error).message}`));

    (async () => {
      const mainClasses = await findMainClasses(folder);
      log.debug(`Java probe: mainClasses=${mainClasses.length}`);
      emit({
        contextPatch: { mainClasses },
        defaultsPatch: mainClasses[0]
          ? { typeOptions: { mainClass: mainClasses[0].fqn } as any }
          : undefined,
        resolved: ['typeOptions.mainClass'],
      });
    })().catch(e => log.warn(`Java probe (mainClasses) failed: ${(e as Error).message}`));

    (async () => {
      const jdks = await detectJdks();
      log.debug(`Java probe: jdks=${jdks.length}`);
      emit({
        contextPatch: { jdks },
        defaultsPatch: jdks[0] ? { typeOptions: { jdkPath: jdks[0] } as any } : undefined,
        resolved: ['typeOptions.jdkPath'],
      });
    })().catch(e => log.warn(`Java probe (jdks) failed: ${(e as Error).message}`));

    (async () => {
      const bt = await detectBuildTools();
      log.debug(`Java probe: gradleInstalls=${bt.gradleInstalls.length}, mavenInstalls=${bt.mavenInstalls.length}`);
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
    })().catch(e => log.warn(`Java probe (buildTools) failed: ${(e as Error).message}`));

    if (info.buildTool) {
      (async () => {
        const classpath = await suggestClasspath(folder, info.buildTool!);
        log.debug(`Java probe: classpath length=${classpath.length}`);
        emit({
          contextPatch: { classpath },
          defaultsPatch: { typeOptions: { classpath } as any },
          resolved: ['typeOptions.classpath'],
        });
      })().catch(e => log.warn(`Java probe (classpath) failed: ${(e as Error).message}`));
    }
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const mainClasses = (context.mainClasses as MainClassCandidate[] | undefined) ?? [];
    const jdks = (context.jdks as string[] | undefined) ?? [];
    const gradleInstalls = (context.gradleInstalls as string[] | undefined) ?? [];
    const mavenInstalls = (context.mavenInstalls as string[] | undefined) ?? [];
    const detectedBuildTool = (context.buildTool as string | undefined) ?? 'maven';
    const detectedGradle = (context.gradleCommand as string | undefined) ?? './gradlew';
    const detectedBuildRoot = (context.buildRoot as string | undefined) ?? '';
    const hasApplicationPlugin = Boolean(context.hasApplicationPlugin);

    // For Java we ignore the Spring tag — every main class is a legitimate
    // candidate. Sort stays stable (findMainClasses already sorts).
    const mainClassOptions = mainClasses.map(m => ({ value: m.fqn, label: m.fqn }));
    const jdkOptions = jdks.map(p => ({ value: p, label: p }));
    const gradleInstallOptions = gradleInstalls.map(p => ({ value: p, label: p }));
    const mavenInstallOptions = mavenInstalls.map(p => ({ value: p, label: p }));

    const launchHelp =
      `How to start the app. Maven uses \`mvn exec:java\` (runs in the Maven JVM — vmArgs ignored). ` +
      `Gradle uses the \`run\` task from the \`application\` plugin (vmArgs also ignored; set them in ` +
      `\`applicationDefaultJvmArgs\` in build.gradle). java-main runs \`java -cp … MainClass\` directly ` +
      `and is the only mode where vmArgs work reliably. Detected build tool: ${detectedBuildTool}.` +
      (context.buildTool === 'gradle' && !hasApplicationPlugin
        ? ` ⚠️ build.gradle does NOT apply the \`application\` plugin — \`./gradlew run\` will fail. Add \`plugins { application }\` and set \`application.mainClass\`, or switch to java-main mode.`
        : '');

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Java App',
          help: 'Display name shown in the sidebar. Purely cosmetic.',
          examples: ['Import job', 'CLI tool'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          validateBuildPath: 'either',
          help: 'Path to the project root, relative to the workspace folder.',
          examples: ['', 'backend', 'tools/importer'],
        },
        {
          kind: 'select',
          key: 'typeOptions.launchMode',
          label: 'Launch mode',
          options: [
            { value: 'maven', label: 'Maven (mvn exec:java)' },
            { value: 'gradle', label: 'Gradle (application plugin: run)' },
            { value: 'java-main', label: 'java -cp … MainClass' },
            { value: 'maven-custom', label: 'Maven — custom command' },
            { value: 'gradle-custom', label: 'Gradle — custom command' },
          ],
          help: launchHelp,
        },
        {
          kind: 'textarea',
          key: 'typeOptions.customArgs',
          label: 'Custom command',
          required: true,
          rows: 2,
          placeholder: ':systemtest:systemtestDev --tests "de.telit.pkg.*Test"',
          help:
            'Free-form command tail appended to the build-tool binary. Use this for ad-hoc invocations that don\'t fit the standard main-class/program-args split — e.g. running a specific Gradle test task with --tests filters. Quoted arguments are preserved. Program args, VM args, and Main class are all IGNORED in custom modes.',
          examples: [
            ':api:test --tests "com.example.*IT"',
            'clean build -x test',
            ':systemtest:systemtestDev --tests "de.telit.zebra.systemtest.exceptionbearbeitung.tests.*.intf.*"',
          ],
          inspectable: true,
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven-custom', 'gradle-custom'] },
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
          dependsOn: { key: 'typeOptions.launchMode', equals: ['gradle', 'gradle-custom'] },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.gradlePath',
          label: 'Gradle installation',
          options: gradleInstallOptions,
          placeholder: '/opt/gradle/gradle-8.5',
          help: 'Gradle install directory. Used only when "Gradle command" is "gradle" (system). Leave blank to use `gradle` from PATH.',
          examples: ['/opt/gradle/gradle-8.5', '/usr/share/gradle'],
          dependsOn: { key: 'typeOptions.gradleCommand', equals: 'gradle' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mavenPath',
          label: 'Maven installation',
          options: mavenInstallOptions,
          placeholder: '/opt/maven/apache-maven-3.9.6',
          help: 'Maven install directory. Leave blank to use `mvn` from PATH.',
          examples: ['/opt/maven/apache-maven-3.9.6', '/usr/share/maven'],
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven', 'maven-custom'] },
        },
        {
          kind: 'text',
          key: 'typeOptions.buildRoot',
          label: 'Build root',
          placeholder: '(auto-detected)',
          help: `Absolute path to the Gradle/Maven project root. Detected: ${detectedBuildRoot || '(same as project path)'}. Override only if auto-detection picked wrong.`,
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven', 'gradle', 'maven-custom', 'gradle-custom'] },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.jdkPath',
          label: 'JDK',
          options: jdkOptions,
          placeholder: '/path/to/jdk',
          help: 'Java installation. In java-main mode we run `<jdkPath>/bin/java`; in maven/gradle modes we set JAVA_HOME. Leave blank to use `java` from PATH.',
          examples: ['/usr/lib/jvm/jdk-21', '/opt/jdk-17'],
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mainClass',
          label: 'Main class',
          required: true,
          options: mainClassOptions,
          placeholder: 'com.example.Main',
          help: mainClasses.length > 0
            ? `Scanned ${mainClasses.length} candidate(s). Maven's exec:java takes this as -Dexec.mainClass; java-main runs it directly. In Gradle mode the class is read from \`application { mainClass }\` in build.gradle and this field is hidden.`
            : 'Fully qualified class name with a public static void main(String[]) method. Required except in Gradle mode.',
          examples: ['com.example.Main', 'com.example.cli.App'],
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven', 'java-main'] },
        },
        {
          kind: 'textarea',
          key: 'typeOptions.classpath',
          label: 'Classpath',
          required: true,
          rows: 3,
          placeholder: 'target/classes:lib/*',
          help: 'Colon-separated on macOS/Linux, semicolon on Windows. Click "Recompute classpath" to populate from your build tool. Values containing "*" are a placeholder hint — recompute before saving.',
          dependsOn: { key: 'typeOptions.launchMode', equals: 'java-main' },
          action: { id: 'recomputeClasspath', label: 'Recompute classpath', busyLabel: 'Recomputing…' },
        },
        {
          kind: 'text',
          key: 'typeOptions.module',
          label: 'Module (optional)',
          placeholder: 'api',
          help: 'For multi-module Gradle projects, the submodule name. Used to scope the run task as :<module>:run.',
          examples: ['api', 'tools/importer'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'gradle' },
        },
        {
          kind: 'number',
          key: 'port',
          label: 'Port (optional)',
          min: 1,
          max: 65535,
          help: 'Informational — the app itself is responsible for binding.',
          examples: ['8080'],
        },
        {
          kind: 'number',
          key: 'typeOptions.debugPort',
          label: 'Debug port',
          min: 1,
          max: 65535,
          help: 'JDWP port used when running in debug mode. Default 5005.',
          examples: ['5005', '5006'],
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          help:
            'Sets FORCE_COLOR=1 / CLICOLOR_FORCE=1 so libraries that auto-detect TTY don\'t strip ANSI codes in the integrated terminal.',
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['JAVA_HOME=/opt/jdk-21', 'CONFIG_FILE=${workspaceFolder}/conf'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--config=app.yml',
          help: 'Passed to the Java app. ' + VAR_SYNTAX_HINT,
          examples: ['--config=app.yml', '-v -n 100'],
          inspectable: true,
          // programArgs are IGNORED in maven-custom / gradle-custom — those
          // modes use the `customArgs` field instead. Hiding the field here
          // prevents users from typing into a slot that won't take effect.
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven', 'gradle', 'java-main'] },
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args',
          placeholder: '-Xmx1g',
          help:
            'JVM flags applied directly to the `java` command line. ' +
            VAR_SYNTAX_HINT,
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC', '-Dapp.home=${workspaceFolder}'],
          inspectable: true,
          // vmArgs are ONLY honored in java-main mode. Maven's exec:java
          // runs inside the Maven JVM itself; Gradle's `run` task reads
          // JVM args from `applicationDefaultJvmArgs` in build.gradle, not
          // the CLI. The -custom modes drive the tool directly from
          // `customArgs`. Hide the field everywhere else so the input
          // simply isn't available when it wouldn't do anything.
          dependsOn: { key: 'typeOptions.launchMode', equals: 'java-main' },
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
      ],
    };
  }

  buildCommand(cfg: RunConfig, folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'java') {
      throw new Error('JavaAdapter received non-java config');
    }
    switch (cfg.typeOptions.launchMode) {
      case 'maven':         return buildMaven(cfg);
      case 'gradle':        return buildGradle(cfg, folder);
      case 'java-main':     return buildJavaMain(cfg);
      case 'maven-custom':  return buildMavenCustom(cfg);
      case 'gradle-custom': return buildGradleCustom(cfg);
    }
  }

  async prepareLaunch(
    cfg: RunConfig,
    _folder: vscode.WorkspaceFolder,
    ctx: { debug: boolean; debugPort?: number },
  ): Promise<{ env?: Record<string, string> }> {
    if (cfg.type !== 'java') return {};
    const env: Record<string, string> = {};
    if (cfg.typeOptions.colorOutput) {
      env.FORCE_COLOR = '1';
      env.CLICOLOR_FORCE = '1';
    }
    if (cfg.typeOptions.jdkPath) {
      env.JAVA_HOME = cfg.typeOptions.jdkPath;
    }
    if (ctx.debug) {
      const port = ctx.debugPort ?? cfg.typeOptions.debugPort ?? 5005;
      const jdwp = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${port}`;
      const mode = cfg.typeOptions.launchMode;
      // Maven (standard + custom): inject into MAVEN_OPTS. Using
      // JAVA_TOOL_OPTIONS here would bind JDWP in both the Maven JVM AND the
      // forked plugin JVM, producing "Address already in use" on the second
      // bind.
      if (mode === 'maven' || mode === 'maven-custom') {
        env.MAVEN_OPTS = jdwp;
      } else if (mode === 'gradle' || mode === 'gradle-custom') {
        // Gradle's forked test/run tasks inherit JAVA_TOOL_OPTIONS. Same
        // pattern Spring Boot's Gradle bootRun flow uses.
        env.JAVA_TOOL_OPTIONS = jdwp;
      }
      // java-main: the Java debugger's request: 'launch' drives JDWP; no env.
    }
    return { env };
  }

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    if (cfg.type !== 'java') {
      throw new Error('JavaAdapter received non-java config');
    }
    const to = cfg.typeOptions;
    const port = typeof to.debugPort === 'number' ? to.debugPort : 5005;

    if (to.launchMode === 'java-main') {
      const classPaths = to.classpath.split(/[;:]/).map(s => s.trim()).filter(Boolean);
      const vmArgs = (cfg.vmArgs ?? '').trim();
      const args = splitArgs(cfg.programArgs ?? '').join(' ');
      return {
        type: 'java',
        request: 'launch',
        name: cfg.name,
        mainClass: to.mainClass,
        projectName: '',
        classPaths,
        modulePaths: [],
        sourcePaths: [],
        ...(to.jdkPath ? { javaExec: `${to.jdkPath.replace(/[/\\]$/, '')}/bin/java` } : {}),
        ...(vmArgs ? { vmArgs } : {}),
        ...(args ? { args } : {}),
        env: cfg.env ?? {},
        console: 'integratedTerminal',
        shortenCommandLine: 'auto',
      };
    }

    const projectUri = resolveProjectUri(folder, cfg.projectPath);
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

// Lightweight build-tool probe used by detectStreaming. Unlike detectJavaApp
// this does NOT bail when Spring Boot / Quarkus / Tomcat markers are present
// — the user explicitly picked "Java Application", so we serve them whatever
// project they pointed at (typically because they want a custom Gradle/Maven
// command against a framework project).
async function probeBuildTool(folder: vscode.Uri): Promise<{
  buildTool: 'maven' | 'gradle' | null;
  hasApplicationPlugin: boolean;
  hasSourceTree: boolean;
}> {
  const hasPom = await fileExists(vscode.Uri.joinPath(folder, 'pom.xml'));
  const hasGradleKts = await fileExists(vscode.Uri.joinPath(folder, 'build.gradle.kts'));
  const hasGradle = hasGradleKts || (await fileExists(vscode.Uri.joinPath(folder, 'build.gradle')));
  const hasSrcMainJava = await fileExists(vscode.Uri.joinPath(folder, 'src/main/java'));
  const hasSrcMainKotlin = await fileExists(vscode.Uri.joinPath(folder, 'src/main/kotlin'));
  const buildTool: 'maven' | 'gradle' | null = hasPom ? 'maven' : hasGradle ? 'gradle' : null;

  let hasApplicationPlugin = false;
  if (buildTool === 'gradle') {
    const uri = hasGradleKts
      ? vscode.Uri.joinPath(folder, 'build.gradle.kts')
      : vscode.Uri.joinPath(folder, 'build.gradle');
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      hasApplicationPlugin =
        /(^|[\s(\[,;])application\b/m.test(text) ||
        /org\.gradle\.application/.test(text);
    } catch { /* best-effort */ }
  }

  return {
    buildTool,
    hasApplicationPlugin,
    hasSourceTree: hasSrcMainJava || hasSrcMainKotlin,
  };
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

function mavenBinary(to: Extract<RunConfig, { type: 'java' }>['typeOptions']): string {
  return to.mavenPath ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn` : 'mvn';
}

function gradleBinary(to: Extract<RunConfig, { type: 'java' }>['typeOptions']): string {
  if (to.gradleCommand === './gradlew') return './gradlew';
  return to.gradlePath ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle` : 'gradle';
}

function buildMaven(cfg: Extract<RunConfig, { type: 'java' }>) {
  const to = cfg.typeOptions;
  const args: string[] = ['exec:java', `-Dexec.mainClass=${to.mainClass}`];
  const programArgs = splitArgs(cfg.programArgs ?? '');
  if (programArgs.length > 0) {
    args.push(`-Dexec.args=${shellQuote(programArgs.join(' '))}`);
  }
  return { command: mavenBinary(to), args };
}

function buildGradle(
  cfg: Extract<RunConfig, { type: 'java' }>,
  folder?: vscode.WorkspaceFolder,
) {
  const to = cfg.typeOptions;
  let task = 'run';
  if (to.buildRoot && folder) {
    const projectAbs = resolveProjectUri(folder, cfg.projectPath).fsPath;
    const modulePrefix = gradleModulePrefix(to.buildRoot, projectAbs);
    if (modulePrefix) task = `${modulePrefix}:run`;
  }

  const args: string[] = ['--console=plain', task];
  const programArgs = splitArgs(cfg.programArgs ?? '');
  if (programArgs.length > 0) {
    args.push(`--args=${shellQuote(programArgs.join(' '))}`);
  }
  // VM args are intentionally NOT passed: Gradle's run task reads them from
  // application { applicationDefaultJvmArgs } in build.gradle. See the help
  // text on the vmArgs field.
  return { command: gradleBinary(to), args };
}

function buildMavenCustom(cfg: Extract<RunConfig, { type: 'java' }>) {
  // Raw Maven command tail — whatever the user typed, shell-split to preserve
  // quoted values. No mainClass, no exec.args wrapping.
  const to = cfg.typeOptions;
  const args = splitArgs(to.customArgs ?? '');
  return { command: mavenBinary(to), args };
}

function buildGradleCustom(cfg: Extract<RunConfig, { type: 'java' }>) {
  const to = cfg.typeOptions;
  const args = splitArgs(to.customArgs ?? '');
  return { command: gradleBinary(to), args };
}

function buildJavaMain(cfg: Extract<RunConfig, { type: 'java' }>) {
  const to = cfg.typeOptions;
  const javaBin = to.jdkPath
    ? `${to.jdkPath.replace(/[/\\]$/, '')}/bin/java`
    : 'java';
  const args: string[] = [];

  const vmArgs = splitArgs(cfg.vmArgs ?? '');
  if (vmArgs.length) args.push(...vmArgs);

  if (to.classpath.trim()) args.push('-cp', to.classpath.trim());

  args.push(to.mainClass);

  const programArgs = splitArgs(cfg.programArgs ?? '');
  if (programArgs.length) args.push(...programArgs);

  return { command: javaBin, args };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
