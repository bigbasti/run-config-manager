import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { detectJdks } from '../spring-boot/detectJdks';
import { probeJdksStreaming, readJdks, jdkOption } from '../spring-boot/probeJdksStreaming';
import { detectBuildTools } from '../spring-boot/detectBuildTools';
import { detectTomcatInstalls, findTomcatArtifacts } from './detectTomcat';
import { prepareTomcatLaunch, catalinaExecutable } from './tomcatRuntime';
import { resolveProjectUri } from '../../utils/paths';
import { findGradleRoot } from '../spring-boot/findBuildRoot';
import { findSpringProfiles } from '../spring-boot/findProfiles';
import { hasSpringBootDevTools } from '../spring-boot/detectDevTools';
import { hasCustomLogback } from '../spring-boot/detectCustomLogback';
import { dependsOnField } from '../sharedFields';
import type { PrepareContext, PrepareResult } from '../RuntimeAdapter';
import { log } from '../../utils/logger';

// Shared help-text footer — mirrors the Spring Boot adapter's pattern.
const VAR_SYNTAX_HINT =
  'Supports ${VAR}, ${env:VAR}, ${workspaceFolder}, ${userHome}, and ${cwd}/${projectPath}. ' +
  'Unresolved variables expand to empty strings at launch.';

// The Run-side scaffolding (writing CATALINA_BASE, editing server.xml, etc.)
// lives in tomcatRuntime.ts. This adapter is responsible only for detect /
// form / buildCommand / debug — the bits all adapters share.
export class TomcatAdapter implements RuntimeAdapter {
  readonly type = 'tomcat' as const;
  readonly label = 'Tomcat';
  readonly supportsDebug = true;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    log.debug(`Tomcat detect: ${folder.fsPath}`);
    // Tomcat has no auto-detect from project files alone — any web project
    // could be deployed. We consider any folder a valid Tomcat target and
    // defer the "is this project buildable?" decision to the user.
    const [tomcatInstalls, jdks, buildTools, artifacts, gradleRoot, profiles, devTools, customLogback] = await Promise.all([
      detectTomcatInstalls(),
      detectJdks(),
      detectBuildTools(),
      findTomcatArtifacts(folder),
      findGradleRoot(folder),
      findSpringProfiles(folder),
      hasSpringBootDevTools(folder),
      hasCustomLogback(folder),
    ]);
    log.info(
      `Tomcat detect: tomcatInstalls=${tomcatInstalls.length}, jdks=${jdks.length}, ` +
      `artifacts=${artifacts.length}`,
    );

    const firstArtifact = artifacts[0];
    // Only fill buildRoot when walking up actually moved — for single-module
    // projects we leave it empty to keep run.json tidy.
    const buildRoot = gradleRoot.fsPath === folder.fsPath ? '' : gradleRoot.fsPath;

    return {
      defaults: {
        type: 'tomcat',
        typeOptions: {
          tomcatHome: tomcatInstalls[0] ?? '',
          jdkPath: jdks[0] ?? '',
          httpPort: 8080,
          buildProjectPath: '',
          buildRoot,
          buildTool: 'gradle',
          gradleCommand: './gradlew',
          gradlePath: buildTools.gradleInstalls[0] ?? '',
          mavenPath: buildTools.mavenInstalls[0] ?? '',
          artifactPath: firstArtifact?.path ?? '',
          artifactKind: firstArtifact?.kind ?? 'war',
          applicationContext: '/',
          profiles: '',
          vmOptions: '',
          reloadable: true,
          rebuildOnSave: false,
        },
      },
      context: {
        tomcatInstalls,
        jdks: jdks.map(p => ({ path: p })),
        gradleInstalls: buildTools.gradleInstalls,
        mavenInstalls: buildTools.mavenInstalls,
        artifacts,
        buildRoot: gradleRoot.fsPath,
        profiles,
        hasDevTools: devTools,
        hasCustomLogback: customLogback,
      },
    };
  }

  async detectStreaming(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    log.debug(`Tomcat detectStreaming: probing ${folder.fsPath}`);
    // Initial: establish that this is a tomcat config so the form knows which
    // schema to render. No fast-path signal here; tomcat is user-declared.
    emit({
      contextPatch: {},
      defaultsPatch: {
        type: 'tomcat' as const,
        typeOptions: {
          httpPort: 8080,
          applicationContext: '/',
          artifactKind: 'war',
          buildTool: 'gradle',
          gradleCommand: './gradlew',
          reloadable: true,
          rebuildOnSave: false,
        } as any,
      },
      resolved: [],
    });

    (async () => {
      const tomcatInstalls = await detectTomcatInstalls();
      log.debug(`Tomcat probe: tomcatInstalls=${tomcatInstalls.length}`);
      emit({
        contextPatch: { tomcatInstalls },
        defaultsPatch: tomcatInstalls[0]
          ? { typeOptions: { tomcatHome: tomcatInstalls[0] } as any }
          : undefined,
        resolved: ['typeOptions.tomcatHome'],
      });
    })().catch(e => log.warn(`Tomcat probe (tomcatInstalls) failed: ${(e as Error).message}`));

    probeJdksStreaming(emit, 'tomcat').catch(e =>
      log.warn(`Tomcat probe (jdks) failed: ${(e as Error).message}`),
    );

    (async () => {
      const bt = await detectBuildTools();
      log.debug(`Tomcat probe: gradleInstalls=${bt.gradleInstalls.length}, mavenInstalls=${bt.mavenInstalls.length}`);
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
    })().catch(e => log.warn(`Tomcat probe (buildTools) failed: ${(e as Error).message}`));

    (async () => {
      const artifacts = await findTomcatArtifacts(folder);
      log.debug(`Tomcat probe: artifacts=${artifacts.length}`);
      const first = artifacts[0];
      emit({
        contextPatch: { artifacts },
        defaultsPatch: first
          ? {
              typeOptions: {
                artifactPath: first.path,
                artifactKind: first.kind,
              } as any,
            }
          : undefined,
        resolved: ['typeOptions.artifactPath', 'typeOptions.artifactKind'],
      });
    })().catch(e => log.warn(`Tomcat probe (artifacts) failed: ${(e as Error).message}`));

    // Gradle root walk-up: for multi-module projects where the chosen project
    // is a submodule (e.g. /git/zebra/api) and the wrapper lives at the root
    // (/git/zebra/gradlew), populate buildRoot so prepareLaunch runs `./gradlew`
    // from the right cwd. Fires only when the user is using Gradle.
    (async () => {
      const root = await findGradleRoot(folder);
      if (root.fsPath !== folder.fsPath) {
        log.debug(`Tomcat probe: gradleRoot=${root.fsPath}`);
        emit({
          contextPatch: { buildRoot: root.fsPath },
          defaultsPatch: { typeOptions: { buildRoot: root.fsPath } as any },
          resolved: ['typeOptions.buildRoot'],
        });
      }
    })().catch(e => log.warn(`Tomcat probe (gradleRoot) failed: ${(e as Error).message}`));

    // Spring profile scan — harmless for non-Spring webapps (just yields []).
    // When the deployed artifact is Spring-based, the profile dropdown
    // populates and picking one adds -Dspring.profiles.active=… to
    // CATALINA_OPTS at launch.
    (async () => {
      const profiles = await findSpringProfiles(folder);
      log.debug(`Tomcat probe: springProfiles=${profiles.length}`);
      emit({ contextPatch: { profiles }, resolved: ['typeOptions.profiles'] });
    })().catch(e => log.warn(`Tomcat probe (profiles) failed: ${(e as Error).message}`));

    // DevTools presence — same rationale as Spring Boot. Tomcat's
    // rebuildOnSave is a gradle-only watcher that only yields a hot
    // reload when DevTools is on the deployed webapp's classpath.
    (async () => {
      const devTools = await hasSpringBootDevTools(folder);
      log.debug(`Tomcat probe: devtools=${devTools}`);
      emit({ contextPatch: { hasDevTools: devTools } });
    })().catch(e => log.warn(`Tomcat probe (devtools) failed: ${(e as Error).message}`));

    // Custom Logback / Log4j2 — same rationale: overrides the
    // -Dlogging.pattern.console we inject via CATALINA_OPTS when
    // colorOutput is on.
    (async () => {
      const customLogback = await hasCustomLogback(folder);
      log.debug(`Tomcat probe: customLogback=${customLogback}`);
      emit({ contextPatch: { hasCustomLogback: customLogback } });
    })().catch(e => log.warn(`Tomcat probe (logback) failed: ${(e as Error).message}`));
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const tomcatInstalls = (context.tomcatInstalls as string[] | undefined) ?? [];
    const jdks = readJdks(context.jdks);
    const gradleInstalls = (context.gradleInstalls as string[] | undefined) ?? [];
    const mavenInstalls = (context.mavenInstalls as string[] | undefined) ?? [];
    const artifacts = (context.artifacts as Array<{ path: string; kind: string; label: string }> | undefined) ?? [];
    const detectedProfiles = (context.profiles as string[] | undefined) ?? [];
    const profileOptions = detectedProfiles.map(p => ({ value: p, label: p }));
    // Tri-state: undefined while probing, true/false once resolved. We
    // only fire the warning when definitively false to avoid flashing
    // yellow while streaming detect catches up.
    const hasDevTools = context.hasDevTools as boolean | undefined;
    const hasCustomLogbackCfg = context.hasCustomLogback as boolean | undefined;

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'Local Tomcat',
          help: 'Display name shown in the sidebar.',
          examples: ['Zebra on Tomcat', 'Backend (Tomcat)'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to the web-app project (the one whose WAR / exploded dir you want to deploy).',
          examples: ['', 'api', 'webapp'],
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.tomcatHome',
          label: 'Tomcat installation',
          required: true,
          options: tomcatInstalls.map(p => ({ value: p, label: p })),
          placeholder: '/opt/apache-tomcat-10.1.18',
          help:
            'Absolute path to the Tomcat install (CATALINA_HOME). Must contain bin/catalina.sh and conf/server.xml. ' +
            'Auto-detected from CATALINA_HOME / TOMCAT_HOME / /opt/apache-tomcat-*.',
          examples: ['/opt/apache-tomcat-10.1.18', '/usr/share/tomcat10'],
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.jdkPath',
          label: 'JDK',
          options: jdks.map(jdkOption),
          placeholder: '/usr/lib/jvm/zulu-17-amd64',
          help: 'JDK to run Tomcat with. Leave blank for `java` from PATH.',
          examples: ['/usr/lib/jvm/zulu-17-amd64', '/opt/jdk-21'],
          action: { id: 'openJdkDownload', label: '☁', title: 'Download and install a JDK', inline: true },
        },
      ],
      typeSpecific: [
        // Ports section.
        {
          kind: 'number',
          key: 'typeOptions.httpPort',
          label: 'HTTP port',
          min: 1,
          max: 65535,
          help: 'Port for the HTTP connector. Written into server.xml of the per-config CATALINA_BASE.',
          examples: ['8080', '8181'],
        },
        {
          kind: 'number',
          key: 'typeOptions.httpsPort',
          label: 'HTTPS port (optional)',
          min: 1,
          max: 65535,
          help: 'If set, enables the HTTPS connector. Your Tomcat install must have the SSL connector configured.',
          examples: ['8443'],
        },
        {
          kind: 'number',
          key: 'typeOptions.ajpPort',
          label: 'AJP port (optional)',
          min: 1,
          max: 65535,
          help: 'If set, enables the AJP connector.',
          examples: ['8009'],
        },
        {
          kind: 'number',
          key: 'typeOptions.jmxPort',
          label: 'JMX port (optional)',
          min: 1,
          max: 65535,
          help: 'Enables JMX remote by passing -Dcom.sun.management.jmxremote.port=<n>.',
          examples: ['1099'],
        },
        {
          kind: 'number',
          key: 'typeOptions.debugPort',
          label: 'Debug port',
          min: 1,
          max: 65535,
          help: 'JDWP port used when running in debug mode. Default 8000.',
          examples: ['8000', '5005'],
        },
        // Deployment section.
        {
          kind: 'folderPath',
          key: 'typeOptions.buildProjectPath',
          label: 'Build project path',
          validateBuildPath: 'either',
          help:
            'Path (relative to workspace folder) of the project that produces the artifact. ' +
            'Leave blank to use the Project path field above. ' +
            'Used for the `gradle :<module>:war` task scoping in multi-module projects.',
          examples: ['', 'api', 'web'],
        },
        {
          kind: 'select',
          key: 'typeOptions.buildTool',
          label: 'Build tool',
          options: [
            { value: 'gradle', label: 'Gradle' },
            { value: 'maven', label: 'Maven' },
            { value: 'none', label: 'None (artifact is already built)' },
          ],
          help: 'Which build tool to invoke before deploying. Choose None if you build the artifact externally.',
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.gradlePath',
          label: 'Gradle installation',
          options: gradleInstalls.map(p => ({ value: p, label: p })),
          placeholder: '/opt/gradle/gradle-8.5',
          help: 'Gradle install dir. Only used when "Build tool" = Gradle AND the Gradle command is set to `gradle` (system).',
          dependsOn: { key: 'typeOptions.buildTool', equals: 'gradle' },
        },
        {
          kind: 'select',
          key: 'typeOptions.gradleCommand',
          label: 'Gradle command',
          options: [
            { value: './gradlew', label: './gradlew (wrapper)' },
            { value: 'gradle', label: 'gradle (system)' },
          ],
          help: 'Prefer the wrapper. Fall back to system `gradle` if the project has no wrapper.',
          dependsOn: { key: 'typeOptions.buildTool', equals: 'gradle' },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.mavenPath',
          label: 'Maven installation',
          options: mavenInstalls.map(p => ({ value: p, label: p })),
          placeholder: '/opt/maven/apache-maven-3.9.6',
          help: 'Maven install dir. Leave blank to use `mvn` from PATH.',
          dependsOn: { key: 'typeOptions.buildTool', equals: 'maven' },
        },
        {
          kind: 'text',
          key: 'typeOptions.buildRoot',
          label: 'Build root (optional)',
          placeholder: '(auto — same as Project path)',
          help:
            'Absolute path to the Gradle/Maven root (where settings.gradle / reactor pom.xml lives). ' +
            'Leave blank to use the Project path above.',
          dependsOn: { key: 'typeOptions.buildTool', equals: ['gradle', 'maven'] },
        },
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.artifactPath',
          label: 'Artifact to deploy',
          required: true,
          options: artifacts.map(a => ({ value: a.path, label: a.label })),
          placeholder: '/git/…/build/libs/app.war',
          help:
            'WAR file or exploded web-app directory to deploy to Tomcat. ' +
            'Auto-scanned from build/libs/*.war (Gradle), build/exploded/* (Gradle exploded), and target/*.war (Maven). ' +
            'Pick "Custom…" to point to a WAR anywhere on disk.',
          examples: ['/git/project/build/libs/api.war'],
        },
        {
          kind: 'select',
          key: 'typeOptions.artifactKind',
          label: 'Artifact kind',
          options: [
            { value: 'war', label: 'WAR file (packaged)' },
            { value: 'exploded', label: 'Exploded directory' },
          ],
          help:
            'Exploded deployments support hot reload: Tomcat watches WEB-INF/classes and reloads the webapp. ' +
            'Packaged WARs redeploy by re-exploding the file — slower but matches production layout.',
        },
        {
          kind: 'text',
          key: 'typeOptions.applicationContext',
          label: 'Application context',
          placeholder: '/',
          help: 'Path under which Tomcat mounts the webapp. "/" = root context.',
          examples: ['/', '/api', '/zebra'],
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
            ? `Detected ${detectedProfiles.length} profile(s) in the webapp's resources. Selected profiles are passed to the JVM as -Dspring.profiles.active=<csv> via CATALINA_OPTS. Safe to leave blank for non-Spring webapps — the flag is only added when profiles are picked.`
            : 'Spring profiles to activate. No profile files detected in this project, but you can still type them (passed via -Dspring.profiles.active). Leave blank if the webapp isn\'t Spring-based.',
          examples: ['dev', 'dev,local', 'prod'],
        },
        {
          kind: 'boolean',
          key: 'typeOptions.reloadable',
          label: 'Reloadable context (hot reload)',
          help:
            'Sets <Context reloadable="true"/> so Tomcat reloads the webapp when WEB-INF/classes changes. ' +
            'Best paired with an exploded deployment and "Rebuild on save".',
          // Reloadable only applies to exploded deployments — Tomcat watches
          // WEB-INF/classes directories, and a packaged WAR's classes live
          // inside the archive until it's re-exploded on the next (re)deploy.
          // Warn when both flags disagree so the user knows why saves don't
          // trigger reloads.
          warning:
            'Reloadable contexts only apply to exploded deployments — Tomcat watches ' +
            'WEB-INF/classes as a directory, and a packaged WAR stays as an archive until ' +
            'it\'s redeployed. Switch "Artifact kind" below to "Exploded directory", or ' +
            'disable this checkbox.',
          warningDependsOn: {
            all: [
              { key: 'typeOptions.reloadable', equals: true },
              { key: 'typeOptions.artifactKind', equals: 'war' },
            ],
          },
        },
        {
          kind: 'boolean',
          key: 'typeOptions.rebuildOnSave',
          label: 'Rebuild on save',
          help:
            'Spawns `./gradlew -t :<module>:classes` in the background so edits recompile automatically. ' +
            'Combined with "Reloadable context" this gives a fast iteration loop. ' +
            'Requires Gradle (Maven has no built-in watch task).',
          dependsOn: { key: 'typeOptions.buildTool', equals: 'gradle' },
          // For Spring-Boot-on-Tomcat the Gradle watcher recompiles classes,
          // but hot reload in the deployed webapp still comes from DevTools.
          // Without DevTools on the webapp's classpath the rebuild just
          // touches class files that Tomcat doesn't redeploy on its own
          // (unless Reloadable is also true + artifact is exploded — but
          // even then the reload is context-level, not DevTools-fast).
          warning: hasDevTools === false
            ? 'spring-boot-devtools not found in the deployed webapp\'s build file. Rebuilds will still run, but hot reload needs DevTools on the classpath. Add `developmentOnly "org.springframework.boot:spring-boot-devtools"` (Gradle) or the <dependency> block (Maven) to the webapp module. Without DevTools, you\'re relying on Tomcat\'s context-level reload — which requires Reloadable + an exploded artifact.'
            : undefined,
          warningDependsOn: { key: 'typeOptions.rebuildOnSave', equals: true },
        },
        {
          kind: 'boolean',
          key: 'typeOptions.colorOutput',
          label: 'Colored log output',
          help:
            'Forces ANSI colors in the terminal by setting FORCE_COLOR=1 / CLICOLOR_FORCE=1 ' +
            'and, for Spring Boot apps, spring.output.ansi.enabled=ALWAYS. Also injects ' +
            '-Dlogging.pattern.console=… via CATALINA_OPTS so Spring Boot\'s default Logback ' +
            'console appender emits %clr(…) ANSI wrappers.',
          warning: hasCustomLogbackCfg === true
            ? 'A custom logback / log4j2 config was found in src/main/resources with its own <pattern>. Our colored-output pattern is injected via -Dlogging.pattern.console, which the project\'s file overrides. FORCE_COLOR still takes effect for child processes, but the main log line format comes from your logback file. Either reference ${LOG_PATTERN} in your custom pattern, or delete the custom logback file to fall back to Spring Boot\'s default.'
            : undefined,
          warningDependsOn: { key: 'typeOptions.colorOutput', equals: true },
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env. ' + VAR_SYNTAX_HINT,
          examples: ['CATALINA_OPTS=-Xms512m', 'JPDA_ADDRESS=localhost:8000'],
        },
        {
          kind: 'text',
          key: 'typeOptions.vmOptions',
          label: 'VM options',
          placeholder: '-Xmx1g -Dapp.home=${workspaceFolder}',
          help:
            'JVM flags appended to CATALINA_OPTS. ' + VAR_SYNTAX_HINT,
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC -Dapp.home=${workspaceFolder}'],
          inspectable: true,
        },
        dependsOnField((context.dependencyOptions as any[] | undefined) ?? []),
      ],
    };
  }

  buildCommand(cfg: RunConfig, folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    if (cfg.type !== 'tomcat') throw new Error('TomcatAdapter received non-tomcat config');
    void folder;
    return { command: catalinaExecutable(cfg), args: ['run'] };
  }

  async prepareLaunch(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    ctx: PrepareContext,
  ): Promise<PrepareResult> {
    return prepareTomcatLaunch(cfg, folder, ctx);
  }

  getDebugConfig(cfg: RunConfig, folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
    if (cfg.type !== 'tomcat') throw new Error('TomcatAdapter received non-tomcat config');
    const port = cfg.typeOptions.debugPort ?? 8000;

    // Source mapping for attach-mode Java debug. Without sourcePaths, the
    // Java debugger connects fine but can't bind breakpoints because it
    // doesn't know which source files correspond to the remote classes.
    // We walk the workspace for standard Maven/Gradle source layouts under
    // the chosen build root. (Synchronous-ish here because getDebugConfig
    // itself is sync; we restrict to shallow well-known paths.)
    const sourcePaths = collectSourcePaths(cfg, folder);

    return {
      type: 'java',
      request: 'attach',
      name: cfg.name,
      hostName: 'localhost',
      port,
      timeout: 60_000,
      // Same "don't consult the redhat.java project model" trick we use for
      // java-main. Prevents the debugger from stalling on workspace indexing.
      projectName: '',
      sourcePaths,
    };
  }
}

// Best-effort list of source roots to hand the Java debugger. We DON'T scan
// the filesystem here (getDebugConfig is sync + cheap). We list the known
// conventional paths; the debugger silently ignores non-existent entries.
function collectSourcePaths(
  cfg: Extract<RunConfig, { type: 'tomcat' }>,
  folder: vscode.WorkspaceFolder,
): string[] {
  const root = cfg.typeOptions.buildRoot || folder.uri.fsPath;
  const wsRoot = folder.uri.fsPath;
  const project = cfg.typeOptions.buildProjectPath || cfg.projectPath;
  const projectAbs = project ? `${wsRoot.replace(/[/\\]$/, '')}/${project}` : wsRoot;

  const paths = new Set<string>([
    // The submodule we're launching.
    `${projectAbs}/src/main/java`,
    `${projectAbs}/src/main/kotlin`,
    `${projectAbs}/src/main/resources`,
    // Build root itself (for single-module or reactor-level source).
    `${root}/src/main/java`,
    `${root}/src/main/kotlin`,
    // Compiled classes — needed so the debugger resolves class names.
    `${projectAbs}/build/classes/java/main`,
    `${projectAbs}/build/resources/main`,
    `${projectAbs}/target/classes`,
  ]);
  return Array.from(paths);
}

// Exported for tests / runtime helpers.
export function resolveBuildProjectUri(
  cfg: Extract<RunConfig, { type: 'tomcat' }>,
  folder: vscode.WorkspaceFolder,
): vscode.Uri {
  const to = cfg.typeOptions;
  const rel = to.buildProjectPath || cfg.projectPath;
  return resolveProjectUri(folder, rel);
}
