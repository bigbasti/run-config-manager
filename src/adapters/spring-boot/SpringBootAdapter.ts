import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readSpringBootInfo } from './detectSpringBoot';
import { findMainClasses, type MainClassCandidate } from '../java-shared/findMainClasses';
import { detectJdks } from './detectJdks';
import { probeJdksStreaming, readJdks, jdkOption } from './probeJdksStreaming';
import { suggestClasspath } from './suggestClasspath';
import { detectBuildTools } from './detectBuildTools';
import { findGradleRoot, findMavenRoot, gradleModulePrefix } from './findBuildRoot';
import { findSpringProfiles } from './findProfiles';
import { detectSpringBootPort, safeDetect } from '../../services/detectProjectPort';
import { hasSpringBootDevTools } from './detectDevTools';
import { hasCustomLogback } from './detectCustomLogback';
import { resolveProjectUri } from '../../utils/paths';
import { log } from '../../utils/logger';

// Shared help-text footer for fields where ${VAR} expansion applies. The
// actual expansion happens at launch (ExecutionService / DebugService) —
// the stored text keeps its ${VAR} literal so the same config works across
// environments. Click the "Test variables" icon in the side panel to see
// which variables resolve vs. fail in the current environment.
const VAR_SYNTAX_HINT =
  'Supports ${VAR} and ${env:VAR} (environment variables), ' +
  '${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to an empty string at launch.';

// Colored console pattern for Spring Boot. Each %clr(...){color} wraps a
// segment in the ANSI escape for that color when ansi is enabled.
//
// Passed as a single -D token via JAVA_TOOL_OPTIONS. The JVM tokenises
// JAVA_TOOL_OPTIONS on ASCII whitespace with no quoting support, so we can't
// use literal spaces — we use %X{} or the non-breaking-space pattern trick.
// Logback allows concatenating conversion words directly; we substitute spaces
// inside the pattern with   (non-breaking space) which Logback prints
// and the JVM tokenises fine. The visual result looks like a regular space.
const COLORED_LOG_PATTERN = "%clr(%d{yyyy-MM-dd\\'T\\'HH:mm:ss.SSS}){faint} %clr(%5p) %clr([%t]){faint} %clr(%-40.40logger{39}){cyan} %clr(:){faint} %clr(%replace(%m){'(/[a-zA-Z0-9/._-]+)','\u001b[94m$1\u001b[0m'}) %n%wEx";
import { splitArgs } from '../npm/splitArgs';
import { dependsOnField, envFilesField } from '../sharedFields';

export class SpringBootAdapter implements RuntimeAdapter {
  readonly type = 'spring-boot' as const;
  readonly label = 'Spring Boot';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Spring Boot detect: ${folder.fsPath}`);
    const info = await readSpringBootInfo(folder);
    if (!info || !info.hasSpringBootApplication) {
      log.debug(`Spring Boot detect: no match`);
      return null;
    }

    const [mainClasses, gradleCommand, jdks, classpath, buildTools, gradleRoot, mavenRoot, profiles, devToolsInProject] =
      await Promise.all([
        findMainClasses(folder),
        detectGradleCommand(folder),
        detectJdks(),
        suggestClasspath(folder, info.buildTool),
        detectBuildTools(),
        info.buildTool === 'gradle' ? findGradleRoot(folder) : Promise.resolve(folder),
        info.buildTool === 'maven' ? findMavenRoot(folder) : Promise.resolve(folder),
        findSpringProfiles(folder),
        hasSpringBootDevTools(folder),
      ]);
    // Also check the build root — multi-module projects often declare
    // devtools once at the reactor level rather than per module.
    const devToolsInRoot = info.buildTool === 'gradle'
      ? await hasSpringBootDevTools(gradleRoot)
      : info.buildTool === 'maven'
      ? await hasSpringBootDevTools(mavenRoot)
      : false;
    const hasDevTools = devToolsInProject || devToolsInRoot;
    // Custom logging config in the chosen module — overrides our
    // colorOutput injection. Only probe the module itself; logback files
    // aren't typically declared at the reactor level.
    const hasCustomLoggingConfig = await hasCustomLogback(folder);

    // If the user selected a sub-module, the build root might be a parent dir.
    // Store it so recompute / run can cd to the right place.
    const buildRoot = info.buildTool === 'gradle' ? gradleRoot.fsPath : mavenRoot.fsPath;
    log.info(
      `Spring Boot detect: buildTool=${info.buildTool}, ` +
      `mainClasses=${mainClasses.length}, jdks=${jdks.length}, profiles=${profiles.length}, ` +
      `buildRoot=${buildRoot}`,
    );
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
        // Wrap string paths into JdkInfo[]. Streaming detection later
        // overwrites this with version-enriched entries; the synchronous
        // form keeps the dropdown usable from the first paint.
        jdks: jdks.map(p => ({ path: p })),
        gradleInstalls: buildTools.gradleInstalls,
        mavenInstalls: buildTools.mavenInstalls,
        buildRoot,
        profiles,
        hasDevTools,
        hasCustomLogback: hasCustomLoggingConfig,
      },
    };
  }

  // Streaming variant: emits partial contexts as each probe finishes so the
  // webview can render the editor immediately and fill fields in place.
  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: import('../RuntimeAdapter').StreamingPatch) => void,
  ): Promise<void> {
    log.debug(`Spring Boot detectStreaming: probing ${folder.fsPath}`);
    // Fast: is this a Spring Boot project? If not, early-exit silently — the
    // editor was already opened with whatever the user is editing.
    const info = await readSpringBootInfo(folder);
    if (!info || !info.hasSpringBootApplication) {
      log.debug(`Spring Boot detectStreaming: no Spring Boot markers — bailing`);
      return;
    }
    log.debug(`Spring Boot detectStreaming: buildTool=${info.buildTool}`);

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
      log.debug(`Spring Boot probe: gradleCommand=${effective}, buildRoot=${buildRoot}`);
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
    })().catch(e => log.warn(`Spring Boot probe (gradleCommand/buildRoot) failed: ${(e as Error).message}`));

    // Profiles: directory walk, usually <1s.
    (async () => {
      const profiles = await findSpringProfiles(folder);
      log.debug(`Spring Boot probe: profiles=${profiles.length}`);
      emit({ contextPatch: { profiles }, resolved: ['typeOptions.profiles'] });
    })().catch(e => log.warn(`Spring Boot probe (profiles) failed: ${(e as Error).message}`));

    // Port detection: read application-<profile>.{properties,yml} for
    // server.port. Cheap file read, safe to run in parallel with everything
    // else. Skipped if nothing matches — the port field stays empty rather
    // than being filled with a guess.
    (async () => {
      const port = await safeDetect('spring-boot:port', () => detectSpringBootPort(folder, undefined));
      if (port) {
        log.debug(`Spring Boot probe: port=${port}`);
        emit({ contextPatch: {}, defaultsPatch: { port } as any, resolved: ['port'] });
      }
    })().catch(e => log.warn(`Spring Boot probe (port) failed: ${(e as Error).message}`));

    // DevTools presence — drives the warning shown under the "Rebuild on
    // save" checkbox. If DevTools isn't on the classpath, rebuildOnSave
    // won't actually hot-reload regardless of whether Gradle keeps
    // compiling. Check both the chosen folder (per-module declaration)
    // and its build root (reactor-level declaration) — multi-module
    // projects often put devtools in the root build.gradle.
    (async () => {
      const inProject = await hasSpringBootDevTools(folder);
      if (inProject) {
        log.debug('Spring Boot probe: devtools found in project');
        emit({ contextPatch: { hasDevTools: true } });
        return;
      }
      // Fall back to the build-root probe. Only fires for gradle buildTool
      // where we can determine the root cheaply; for maven the same walk
      // would require the full findMavenRoot pass which is more expensive —
      // we accept the false positive (warning shown for a multi-module
      // Maven project that declares devtools only at the reactor root).
      const gradleRoot = info.buildTool === 'gradle' ? await findGradleRoot(folder) : null;
      const inRoot = gradleRoot ? await hasSpringBootDevTools(gradleRoot) : false;
      log.debug(`Spring Boot probe: devtools project=false, root=${inRoot}`);
      emit({ contextPatch: { hasDevTools: inRoot } });
    })().catch(e => log.warn(`Spring Boot probe (devtools) failed: ${(e as Error).message}`));

    // Custom Logback / Log4j2 config — if present, our colorOutput
    // injection (-Dlogging.pattern.console=…) is overridden by the
    // project's own pattern declaration. The warning on the colorOutput
    // checkbox keys on this flag.
    (async () => {
      const customLogback = await hasCustomLogback(folder);
      log.debug(`Spring Boot probe: custom logback/log4j2 config present=${customLogback}`);
      emit({ contextPatch: { hasCustomLogback: customLogback } });
    })().catch(e => log.warn(`Spring Boot probe (logback) failed: ${(e as Error).message}`));

    // Main classes: file-system walk with regex, can take several seconds.
    (async () => {
      const mainClasses = await findMainClasses(folder);
      log.debug(`Spring Boot probe: mainClasses=${mainClasses.length}`);
      emit({
        contextPatch: { mainClasses },
        defaultsPatch: mainClasses[0]
          ? { typeOptions: { mainClass: mainClasses[0].fqn } as any }
          : undefined,
        resolved: ['typeOptions.mainClass'],
      });
    })().catch(e => log.warn(`Spring Boot probe (mainClasses) failed: ${(e as Error).message}`));

    // JDK probe: filesystem + (possibly) Java extension API. Two-phase —
    // emits paths first, then enriches with versions in a second sweep so
    // the dropdown labels show "Java 21.0.2 (Temurin)" once probed. The
    // helper keeps `typeOptions.jdkPath` in the pending set the whole time
    // so the spinner renders next to the field while versions resolve.
    probeJdksStreaming(emit, 'spring-boot').catch(e =>
      log.warn(`Spring Boot probe (jdks) failed: ${(e as Error).message}`),
    );

    // Build-tool installs.
    (async () => {
      const bt = await detectBuildTools();
      log.debug(`Spring Boot probe: gradleInstalls=${bt.gradleInstalls.length}, mavenInstalls=${bt.mavenInstalls.length}`);
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
    })().catch(e => log.warn(`Spring Boot probe (buildTools) failed: ${(e as Error).message}`));

    // Classpath hint: fast path (Java extension) + fallback to static string.
    (async () => {
      const classpath = await suggestClasspath(folder, info.buildTool);
      log.debug(`Spring Boot probe: classpath length=${classpath.length}`);
      emit({
        contextPatch: { classpath },
        defaultsPatch: { typeOptions: { classpath } as any },
        resolved: ['typeOptions.classpath'],
      });
    })().catch(e => log.warn(`Spring Boot probe (classpath) failed: ${(e as Error).message}`));
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const mainClasses = (context.mainClasses as MainClassCandidate[] | undefined) ?? [];
    const jdks = readJdks(context.jdks);
    const gradleInstalls = (context.gradleInstalls as string[] | undefined) ?? [];
    const mavenInstalls = (context.mavenInstalls as string[] | undefined) ?? [];
    const detectedBuildTool = (context.buildTool as string | undefined) ?? 'maven';
    const detectedGradle = (context.gradleCommand as string | undefined) ?? './gradlew';
    const detectedBuildRoot = (context.buildRoot as string | undefined) ?? '';

    const mainClassOptions = mainClasses.map(m => ({
      value: m.fqn,
      label: m.isSpringBoot ? `🚀 ${m.fqn}` : m.fqn,
    }));

    const jdkOptions = jdks.map(jdkOption);
    const gradleInstallOptions = gradleInstalls.map(p => ({ value: p, label: p }));
    const mavenInstallOptions = mavenInstalls.map(p => ({ value: p, label: p }));
    const detectedProfiles = (context.profiles as string[] | undefined) ?? [];
    const profileOptions = detectedProfiles.map(p => ({ value: p, label: p }));
    // hasDevTools is tri-state:
    //   true  — found the dependency in build.gradle / pom.xml
    //   false — probed and didn't find it (warn the user)
    //   undefined — probe hasn't run yet (no warning — prevents a
    //               flash of yellow while streaming detect catches up)
    const hasDevTools = context.hasDevTools as boolean | undefined;
    // Tri-state like hasDevTools. Only triggers the colorOutput warning
    // when definitely true; undefined (probe pending) stays quiet.
    const hasCustomLogbackCfg = context.hasCustomLogback as boolean | undefined;

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
          validateBuildPath: 'either',
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
          action: { id: 'openGradleDownload', label: '☁', title: 'Download and install a Gradle from gradle.org', inline: true },
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
          action: { id: 'openMavenDownload', label: '☁', title: 'Download and install a Maven from Apache', inline: true },
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
          help:
            'Java installation used for this config. Always shown (no longer ' +
            'just for java-main) — Maven / Gradle also need the right JDK to ' +
            'compile sources that target newer Java releases. Applied as: ' +
            '(1) the `java` binary when launchMode=java-main; ' +
            '(2) `javaExec` on the Java debug attach so breakpoints resolve; ' +
            '(3) JAVA_HOME for the ./gradlew / mvn child process (build-time ' +
            'compilation, bootRun, tests, classpath recompute). ' +
            'Leave blank to inherit JAVA_HOME from the shell that launched VS Code.',
          examples: ['/usr/lib/jvm/jdk-21', '/opt/jdk-17'],
          // Surfaces a ⬇ icon next to the field. The webview intercepts
          // this actionId to open the JDK download dialog (it doesn't
          // round-trip to the extension as a regular load action).
          action: { id: 'openJdkDownload', label: '☁', title: 'Download and install a JDK', inline: true },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mainClass',
          label: 'Main class',
          required: true,
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
            'Launches a second Gradle task in continuous mode alongside the app: ' +
            '`./gradlew -t :<module>:classes :<module>:processResources`. Edits to ' +
            'Java sources and resource files (application*.properties, templates, ' +
            'static/) trigger a recompile → DevTools picks up the classpath change ' +
            'and warm-restarts the Spring context.\n\n' +
            'REQUIREMENTS (all three must hold for hot reload to actually fire):\n' +
            '1) `org.springframework.boot:spring-boot-devtools` on the classpath. ' +
            'Best declared as `developmentOnly` in build.gradle so it\'s excluded from production artifacts.\n' +
            '2) bootRun must fork a separate JVM (the Spring Boot plugin\'s default) ' +
            'so DevTools can restart the app without bringing down Gradle.\n' +
            '3) For multi-module projects: edits to SIBLING modules the app depends on ' +
            'won\'t be picked up by `:<module>:classes` alone. If you need cross-module ' +
            'hot-reload, replace this shortcut with a manually-authored Gradle Task config ' +
            'that runs `-t build -x test -x check` from the build root.\n\n' +
            'If hot reload isn\'t working, open the "(watch)" terminal and verify Gradle ' +
            'is actually rebuilding on your save — if it is but the app doesn\'t reload, ' +
            'the issue is DevTools on the classpath, not the watcher.\n\n' +
            'Requires Gradle — Maven mode has no built-in watch task.',
          // Warn only when we've definitely probed and didn't find DevTools
          // (hasDevTools === false). The undefined case means detection
          // is still in flight — stay quiet until we know.
          warning: hasDevTools === false
            ? 'spring-boot-devtools not found in build.gradle / pom.xml — hot reload will NOT work. '
              + 'Add `developmentOnly "org.springframework.boot:spring-boot-devtools"` (Gradle) or the '
              + '<dependency> block (Maven) to enable it. The watcher will still rebuild on save, but the running app won\'t pick up the changes.'
            : undefined,
          // Gate the warning on the checkbox being ticked — a user who
          // never enables Rebuild on save doesn't need the DevTools hint
          // pushed at them. It only matters when they actually opt in.
          warningDependsOn: { key: 'typeOptions.rebuildOnSave', equals: true },
          dependsOn: { key: 'typeOptions.launchMode', equals: ['gradle', 'java-main'] },
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          help:
            'Forces ANSI colors in the terminal by setting spring.output.ansi.enabled=ALWAYS plus ' +
            'FORCE_COLOR=1 / CLICOLOR_FORCE=1 env vars. Libraries that auto-detect TTY will stop ' +
            'stripping color codes. Also injects -Dlogging.pattern.console=… via JAVA_TOOL_OPTIONS ' +
            'so Spring Boot\'s default Logback console appender emits %clr(…) ANSI wrappers.',
          warning: hasCustomLogbackCfg === true
            ? 'A custom logback / log4j2 config was found in src/main/resources with its own '
              + '<pattern>. Our colored-output pattern is injected via -Dlogging.pattern.console, '
              + 'which the project\'s file overrides. The FORCE_COLOR env vars are still set (so '
              + 'libraries like Spring Boot banner / child processes still colour their output), '
              + 'but the main log line format comes from your logback file. Either reference '
              + '${LOG_PATTERN} in your custom pattern, or delete the custom logback file to '
              + 'fall back to Spring Boot\'s default.'
            : undefined,
          warningDependsOn: { key: 'typeOptions.colorOutput', equals: true },
        },
      ],
      advanced: [
        envFilesField(),
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help:
            'Merged on top of inherited env. ' +
            'Note: JAVA_OPTS is NOT read by Gradle / Spring Boot bootRun — it\'s a ' +
            'convention of shell wrappers (catalina.sh, maven) only. Put JVM flags ' +
            'in the "VM args" field above (they\'re injected via JAVA_TOOL_OPTIONS for ' +
            'gradle mode). ' + VAR_SYNTAX_HINT,
          examples: ['SPRING_PROFILES_ACTIVE=dev', 'JAVA_HOME=/opt/jdk-21', 'DB_URL=${DB_URL}'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--server.port=8081',
          help: 'Passed to the Spring Boot app. ' + VAR_SYNTAX_HINT,
          examples: ['--server.port=8081', '--debug', '--config=${workspaceFolder}/conf'],
          inspectable: true,
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args',
          placeholder: '-Xmx1g',
          help:
            'JVM flags. Applied directly in java-main mode; wrapped in ' +
            '-Dspring-boot.run.jvmArguments for Maven; injected via ' +
            'JAVA_TOOL_OPTIONS for Gradle (bootRun has no first-class ' +
            'vmArgs channel, but the forked JVM honors JAVA_TOOL_OPTIONS). ' +
            VAR_SYNTAX_HINT,
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC', '-Dapp.home=${workspaceFolder}'],
          inspectable: true,
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
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

  async prepareLaunch(
    cfg: RunConfig,
    _folder: vscode.WorkspaceFolder,
    ctx: { debug: boolean; debugPort?: number },
  ): Promise<{ env?: Record<string, string> }> {
    if (cfg.type !== 'spring-boot') return {};
    const env: Record<string, string> = {};
    // JAVA_HOME steers which JDK Gradle / Maven use for compilation + forked
    // JVMs. Without this, `./gradlew bootRun` uses whatever JDK happened to
    // be on VS Code's PATH — typically too old for projects targeting
    // Java 21, producing:
    //   "Java compilation initialization error: invalid source release: 21"
    // java-main mode uses jdkPath directly as its `java` binary, so JAVA_HOME
    // there is redundant but harmless; we set it uniformly.
    if (cfg.typeOptions.jdkPath) {
      env.JAVA_HOME = cfg.typeOptions.jdkPath;
    }
    // JAVA_TOOL_OPTIONS is picked up by every forked JVM — it's the only
    // channel that reaches `bootRun`'s child process. We compose it from
    // these inputs that all need to apply:
    //   1. colorOutput — ansi + log pattern injection
    //   2. vmArgs (gradle mode only) — user-declared VM args (e.g.
    //      `-Dspring.config.name=foo`). Maven mode already forwards vmArgs
    //      via `-Dspring-boot.run.jvmArguments`; java-main applies them
    //      directly to `java`. Only gradle's `bootRun` had no channel, so we
    //      bridge via JAVA_TOOL_OPTIONS here.
    //   3. JDWP — debug attach (gradle only; for maven the flag goes via
    //      the buildCommand's `-Dspring-boot.run.jvmArguments`, see
    //      DebugService.startAttachFlow).
    //
    // We always set JAVA_TOOL_OPTIONS (even when no parts are present)
    // so that ExecutionService's last-wins merge doesn't let a stale value
    // from process.env or cfg.env survive — this used to break debug:
    // DebugService set cfg.env.JAVA_TOOL_OPTIONS=<jdwp> for gradle, but
    // prepareLaunch overwrote it without the JDWP flag, leaving the
    // forked JVM with no debug socket. Now JDWP is composed in here.
    const toolOptParts: string[] = [];
    if (cfg.typeOptions.colorOutput) {
      env.FORCE_COLOR = '1';
      env.CLICOLOR_FORCE = '1';
      env.SPRING_OUTPUT_ANSI_ENABLED = 'ALWAYS';
      toolOptParts.push(
        `-Dspring.output.ansi.enabled=ALWAYS`,
        `-Dlogging.pattern.console=${COLORED_LOG_PATTERN}`,
      );
    }
    if (cfg.typeOptions.launchMode === 'gradle') {
      const vm = (cfg.vmArgs ?? '').trim();
      if (vm) toolOptParts.push(vm);
      // suspend=n so bootRun reaches "Started" before the user attaches;
      // server=y is mandatory for attach mode. address=*:<port> binds on
      // every interface, matching how IntelliJ's bootRun debug works.
      if (ctx.debug && cfg.typeOptions.launchMode === 'gradle') {
        const port = ctx.debugPort ?? cfg.typeOptions.debugPort ?? 5005;
        toolOptParts.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${port}`);
      }
    }
    if (toolOptParts.length) {
      env.JAVA_TOOL_OPTIONS = toolOptParts.join(' ');
    }
    return { env };
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
