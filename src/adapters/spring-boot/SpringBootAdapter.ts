import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readSpringBootInfo } from './detectSpringBoot';
import { findMainClasses, type MainClassCandidate } from './findMainClasses';
import { detectJdks } from './detectJdks';
import { suggestClasspath } from './suggestClasspath';
import { detectBuildTools } from './detectBuildTools';
import { findGradleRoot, findMavenRoot, gradleModulePrefix } from './findBuildRoot';
import { findSpringProfiles } from './findProfiles';
import { resolveProjectUri } from '../../utils/paths';

// Shared help-text footer for fields where ${VAR} expansion applies. The
// actual expansion happens at launch (ExecutionService / DebugService) —
// the stored text keeps its ${VAR} literal so the same config works across
// environments. Click the "Test variables" icon in the side panel to see
// which variables resolve vs. fail in the current environment.
const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';
import { splitArgs } from '../npm/splitArgs';

export class SpringBootAdapter implements RuntimeAdapter {
  readonly type = 'spring-boot' as const;
  readonly label = 'Spring Boot';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    const info = await readSpringBootInfo(folder);
    if (!info) return null;
    if (!info.hasSpringBootApplication) return null;

    const [mainClasses, gradleCommand, jdks, classpath, buildTools, gradleRoot, mavenRoot, profiles] =
      await Promise.all([
        findMainClasses(folder),
        detectGradleCommand(folder),
        detectJdks(),
        suggestClasspath(folder, info.buildTool),
        detectBuildTools(),
        info.buildTool === 'gradle' ? findGradleRoot(folder) : Promise.resolve(folder),
        info.buildTool === 'maven' ? findMavenRoot(folder) : Promise.resolve(folder),
        findSpringProfiles(folder),
      ]);

    // If the user selected a sub-module, the build root might be a parent dir.
    // Store it so recompute / run can cd to the right place.
    const buildRoot = info.buildTool === 'gradle' ? gradleRoot.fsPath : mavenRoot.fsPath;
    // If the wrapper exists in the detected root (not the sub-module), prefer it.
    const effectiveGradleCommand: 'gradle' | './gradlew' =
      info.buildTool === 'gradle' && (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
        ? './gradlew'
        : gradleCommand;

    return {
      defaults: {
        type: 'spring-boot',
        typeOptions: {
          launchMode: info.buildTool,
          buildTool: info.buildTool,
          gradleCommand: effectiveGradleCommand,
          profiles: '',
          mainClass: mainClasses[0]?.fqn ?? '',
          classpath,
          jdkPath: jdks[0] ?? '',
          module: '',
          gradlePath: buildTools.gradleInstalls[0] ?? '',
          mavenPath: buildTools.mavenInstalls[0] ?? '',
          buildRoot: buildRoot === folder.fsPath ? '' : buildRoot,
        },
      },
      context: {
        buildTool: info.buildTool,
        gradleCommand: effectiveGradleCommand,
        mainClasses,
        jdks,
        gradleInstalls: buildTools.gradleInstalls,
        mavenInstalls: buildTools.mavenInstalls,
        buildRoot,
        profiles,
      },
    };
  }

  // Streaming variant: emits partial contexts as each probe finishes so the
  // webview can render the editor immediately and fill fields in place.
  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: import('../RuntimeAdapter').StreamingPatch) => void,
  ): Promise<void> {
    // Fast: is this a Spring Boot project? If not, early-exit silently — the
    // editor was already opened with whatever the user is editing.
    const info = await readSpringBootInfo(folder);
    if (!info || !info.hasSpringBootApplication) return;

    // Emit the build-tool verdict immediately so the form knows whether it's
    // Maven or Gradle — this drives which recompute path we dispatch later.
    emit({
      contextPatch: { buildTool: info.buildTool },
      defaultsPatch: {
        type: 'spring-boot' as const,
        typeOptions: {
          buildTool: info.buildTool,
          launchMode: info.buildTool,  // default launch mode follows build tool
        } as any,
      },
      resolved: [],
    });

    // gradleCommand + buildRoot: file-system stats, sub-second.
    (async () => {
      const gradleCommand = await detectGradleCommand(folder);
      const gradleRoot = info.buildTool === 'gradle' ? await findGradleRoot(folder) : folder;
      const mavenRoot = info.buildTool === 'maven' ? await findMavenRoot(folder) : folder;
      const buildRoot = info.buildTool === 'gradle' ? gradleRoot.fsPath : mavenRoot.fsPath;
      const effective: 'gradle' | './gradlew' =
        info.buildTool === 'gradle' && (await fileExists(vscode.Uri.joinPath(gradleRoot, 'gradlew')))
          ? './gradlew'
          : gradleCommand;
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
    })().catch(() => {});

    // Profiles: directory walk, usually <1s.
    (async () => {
      const profiles = await findSpringProfiles(folder);
      emit({ contextPatch: { profiles }, resolved: ['typeOptions.profiles'] });
    })().catch(() => {});

    // Main classes: file-system walk with regex, can take several seconds.
    (async () => {
      const mainClasses = await findMainClasses(folder);
      emit({
        contextPatch: { mainClasses },
        defaultsPatch: mainClasses[0]
          ? { typeOptions: { mainClass: mainClasses[0].fqn } as any }
          : undefined,
        resolved: ['typeOptions.mainClass'],
      });
    })().catch(() => {});

    // JDK probe: filesystem + (possibly) Java extension API.
    (async () => {
      const jdks = await detectJdks();
      emit({
        contextPatch: { jdks },
        defaultsPatch: jdks[0] ? { typeOptions: { jdkPath: jdks[0] } as any } : undefined,
        resolved: ['typeOptions.jdkPath'],
      });
    })().catch(() => {});

    // Build-tool installs.
    (async () => {
      const bt = await detectBuildTools();
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
    })().catch(() => {});

    // Classpath hint: fast path (Java extension) + fallback to static string.
    (async () => {
      const classpath = await suggestClasspath(folder, info.buildTool);
      emit({
        contextPatch: { classpath },
        defaultsPatch: { typeOptions: { classpath } as any },
        resolved: ['typeOptions.classpath'],
      });
    })().catch(() => {});
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const mainClasses = (context.mainClasses as MainClassCandidate[] | undefined) ?? [];
    const jdks = (context.jdks as string[] | undefined) ?? [];
    const gradleInstalls = (context.gradleInstalls as string[] | undefined) ?? [];
    const mavenInstalls = (context.mavenInstalls as string[] | undefined) ?? [];
    const detectedBuildTool = (context.buildTool as string | undefined) ?? 'maven';
    const detectedGradle = (context.gradleCommand as string | undefined) ?? './gradlew';
    const detectedBuildRoot = (context.buildRoot as string | undefined) ?? '';

    const mainClassOptions = mainClasses.map(m => ({
      value: m.fqn,
      label: m.isSpringBoot ? `🚀 ${m.fqn}` : m.fqn,
    }));

    const jdkOptions = jdks.map(p => ({ value: p, label: p }));
    const gradleInstallOptions = gradleInstalls.map(p => ({ value: p, label: p }));
    const mavenInstallOptions = mavenInstalls.map(p => ({ value: p, label: p }));
    const detectedProfiles = (context.profiles as string[] | undefined) ?? [];
    const profileOptions = detectedProfiles.map(p => ({ value: p, label: p }));

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Spring App',
          help: 'Display name shown in the sidebar. Purely cosmetic.',
          examples: ['API server', 'Backend dev'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to the Spring Boot project root, relative to the workspace folder.',
          examples: ['', 'backend', 'services/api'],
        },
        {
          kind: 'select',
          key: 'typeOptions.launchMode',
          label: 'Launch mode',
          options: [
            { value: 'maven', label: 'Maven (mvn spring-boot:run)' },
            { value: 'gradle', label: 'Gradle (bootRun)' },
            { value: 'java-main', label: 'java -cp ... MainClass' },
          ],
          help: `How to start the app. Maven/Gradle invoke the build tool's Spring Boot task (slower but picks up source changes). java-main runs the compiled class directly — fastest, but you must build first. Detected build tool: ${detectedBuildTool}.`,
        },
        {
          kind: 'csvChecklist',
          key: 'typeOptions.profiles',
          label: 'Active profiles',
          options: profileOptions,
          placeholder: detectedProfiles.length
            ? 'Custom profiles (comma-separated)'
            : 'dev,local',
          help: detectedProfiles.length
            ? `Detected ${detectedProfiles.length} profile(s) from application-*.{properties,yml,yaml}. Check the ones you want active; add custom ones in the text field.`
            : 'Spring profiles to activate (comma-separated). No application-<profile>.properties files detected — type profile names manually.',
          examples: ['dev', 'dev,local', 'prod'],
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
          help: `Gradle install directory. Used only when "Gradle command" is set to "gradle" (system). Leave blank to use "gradle" from PATH. Auto-detected installs appear in the dropdown.`,
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
          help: `Absolute path to the Gradle/Maven project root (where settings.gradle / reactor pom.xml lives). Detected: ${detectedBuildRoot || '(same as project path)'}. Override only if auto-detection picked wrong.`,
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven', 'gradle', 'java-main'] },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.jdkPath',
          label: 'JDK',
          options: jdkOptions,
          placeholder: '/path/to/jdk',
          help: 'Java installation to use. Leave blank to use `java` from PATH.',
          examples: ['/usr/lib/jvm/jdk-21', '/opt/jdk-17'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'java-main' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mainClass',
          label: 'Main class',
          options: mainClassOptions,
          placeholder: 'com.example.MyApp',
          help: mainClasses.length > 0
            ? `Scanned ${mainClasses.length} candidate(s). 🚀 marks @SpringBootApplication classes.`
            : 'No main classes detected. Type the fully qualified class name.',
          examples: ['com.example.MyApp', 'com.example.Server'],
          dependsOn: { key: 'typeOptions.launchMode', equals: 'java-main' },
        },
        {
          kind: 'textarea',
          key: 'typeOptions.classpath',
          label: 'Classpath',
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
          help: 'For multi-module projects, the submodule name or relative path. Purely informational in v1.',
          examples: ['api', 'services/auth'],
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
          help: 'JDWP port used when running in debug mode. Default 5005. Only relevant for Maven / Gradle launch modes (java-main lets the debugger pick the port).',
          examples: ['5005', '5006'],
          dependsOn: { key: 'typeOptions.launchMode', equals: ['maven', 'gradle'] },
        },
        {
          kind: 'boolean',
          key: 'typeOptions.rebuildOnSave',
          label: 'Rebuild on save (hot reload)',
          help:
            'When enabled, starting this config also runs `./gradlew -t :<module>:classes` in the background so edits recompile automatically. ' +
            'For hot reload to take effect the app must have `spring-boot-devtools` on its classpath — DevTools watches build/classes/java/main ' +
            'and triggers a fast warm-restart of the Spring context. ' +
            'Requires Gradle (Maven mode has no built-in watch task). Uses the Gradle command / installation you selected above.',
          dependsOn: { key: 'typeOptions.launchMode', equals: ['gradle', 'java-main'] },
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['SPRING_PROFILES_ACTIVE=dev', 'JAVA_HOME=/opt/jdk-21', 'DB_URL=${DB_URL}'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--server.port=8081',
          help: 'Passed to the Spring Boot app. ' + VAR_SYNTAX_HINT,
          examples: ['--server.port=8081', '--debug', '--config=${workspaceFolder}/conf'],
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args',
          placeholder: '-Xmx1g',
          help:
            'JVM flags. Applied directly in java-main mode; wrapped in ' +
            '-Dspring-boot.run.jvmArguments for Maven; ignored by Gradle. ' +
            VAR_SYNTAX_HINT,
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC', '-Dapp.home=${workspaceFolder}'],
        },
      ],
    };
  }

  buildCommand(cfg: RunConfig, folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'spring-boot') {
      throw new Error('SpringBootAdapter received non-spring-boot config');
    }
    switch (cfg.typeOptions.launchMode) {
      case 'maven':     return buildMaven(cfg);
      case 'gradle':    return buildGradle(cfg, folder);
      case 'java-main': return buildJavaMain(cfg);
    }
  }

  getDebugConfig(cfg: RunConfig, _folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    if (cfg.type !== 'spring-boot') {
      throw new Error('SpringBootAdapter received non-spring-boot config');
    }
    const to = cfg.typeOptions;
    const port = typeof to.debugPort === 'number' ? to.debugPort : 5005;

    if (to.launchMode === 'java-main') {
      // Direct launch under the Java debugger. Needs vscjava.vscode-java-debug
      // (the DebugService guards on adapter.supportsDebug + extension presence).
      const classPaths = to.classpath
        .split(/[;:]/)
        .map(s => s.trim())
        .filter(Boolean);
      const vmArgs = (cfg.vmArgs ?? '').trim();
      const args = splitArgs(cfg.programArgs ?? '').join(' ');
      const profiles = to.profiles.trim();
      const composedVmArgs = profiles
        ? (vmArgs ? `${vmArgs} -Dspring.profiles.active=${profiles}` : `-Dspring.profiles.active=${profiles}`)
        : vmArgs;
      return {
        type: 'java',
        request: 'launch',
        name: cfg.name,
        mainClass: to.mainClass,
        // Empty projectName tells the Java debugger NOT to resolve the project
        // from redhat.java's workspace model — it uses only the classPaths we
        // provide. Otherwise the debugger waits for the Java extension to
        // finish indexing the entire workspace before starting the JVM.
        projectName: '',
        classPaths,
        // Don't let the debugger tack on anything from the resolved project.
        modulePaths: [],
        sourcePaths: [],
        ...(to.jdkPath ? { javaExec: `${to.jdkPath.replace(/[/\\]$/, '')}/bin/java` } : {}),
        ...(composedVmArgs ? { vmArgs: composedVmArgs } : {}),
        ...(args ? { args } : {}),
        env: cfg.env ?? {},
        console: 'integratedTerminal',
        // Skip the "resolve main class" workflow — we already know it.
        shortenCommandLine: 'auto',
      };
    }

    // Maven/Gradle: attach to a JDWP port. The DebugService is responsible
    // for starting the build tool with the matching -agentlib:jdwp flag
    // before calling startDebugging with this attach config.
    return {
      type: 'java',
      request: 'attach',
      name: cfg.name,
      hostName: 'localhost',
      port,
      // Attach retries on connection-refused until the JVM opens the socket.
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

function mavenBinary(to: Extract<RunConfig, { type: 'spring-boot' }>['typeOptions']): string {
  return to.mavenPath ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn` : 'mvn';
}

function gradleBinary(to: Extract<RunConfig, { type: 'spring-boot' }>['typeOptions']): string {
  // If user picked wrapper, trust it — cwd is set to buildRoot so `./gradlew` resolves.
  if (to.gradleCommand === './gradlew') return './gradlew';
  return to.gradlePath ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle` : 'gradle';
}

function buildMaven(cfg: Extract<RunConfig, { type: 'spring-boot' }>) {
  const to = cfg.typeOptions;
  const programArgs = splitArgs(cfg.programArgs ?? '');
  const vmArgs = (cfg.vmArgs ?? '').trim();
  const profiles = to.profiles.trim();

  const args: string[] = ['spring-boot:run'];
  if (profiles) args.push(`-Dspring-boot.run.profiles=${profiles}`);
  if (programArgs.length > 0) {
    args.push(`-Dspring-boot.run.arguments=${shellQuote(programArgs.join(' '))}`);
  }
  if (vmArgs) args.push(`-Dspring-boot.run.jvmArguments=${shellQuote(vmArgs)}`);
  return { command: mavenBinary(to), args };
}

function buildGradle(
  cfg: Extract<RunConfig, { type: 'spring-boot' }>,
  folder?: vscode.WorkspaceFolder,
) {
  const to = cfg.typeOptions;
  const programArgs = splitArgs(cfg.programArgs ?? '');
  const profiles = to.profiles.trim();

  // In multi-module projects, scope bootRun to the chosen submodule so we
  // don't accidentally launch the first module Gradle happens to find.
  // Example: buildRoot /git/dds2, projectPath tardis-api → task :tardis-api:bootRun.
  let task = 'bootRun';
  if (to.buildRoot && folder) {
    const projectAbs = resolveProjectUri(folder, cfg.projectPath).fsPath;
    const modulePrefix = gradleModulePrefix(to.buildRoot, projectAbs);
    if (modulePrefix) task = `${modulePrefix}:bootRun`;
  }

  const args: string[] = [task];
  const runArgs: string[] = [];
  if (profiles) runArgs.push(`--spring.profiles.active=${profiles}`);
  runArgs.push(...programArgs);
  if (runArgs.length > 0) args.push(`--args=${shellQuote(runArgs.join(' '))}`);
  return { command: gradleBinary(to), args };
}

function buildJavaMain(cfg: Extract<RunConfig, { type: 'spring-boot' }>) {
  const to = cfg.typeOptions;
  const javaBin = to.jdkPath
    ? `${to.jdkPath.replace(/[/\\]$/, '')}/bin/java`
    : 'java';
  const args: string[] = [];

  const vmArgs = splitArgs(cfg.vmArgs ?? '');
  if (vmArgs.length) args.push(...vmArgs);

  if (to.classpath.trim()) args.push('-cp', to.classpath.trim());

  const profiles = to.profiles.trim();
  if (profiles) args.push(`-Dspring.profiles.active=${profiles}`);

  args.push(to.mainClass);

  const programArgs = splitArgs(cfg.programArgs ?? '');
  if (programArgs.length) args.push(...programArgs);

  return { command: javaBin, args };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
