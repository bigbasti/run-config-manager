import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormField, FormSchema } from '../../shared/formSchema';
import { readSpringBootInfo } from './detectSpringBoot';
import { findMainClasses, type MainClassCandidate } from './findMainClasses';
import { detectJdks } from './detectJdks';
import { suggestClasspath } from './suggestClasspath';
import { splitArgs } from '../npm/splitArgs';

export class SpringBootAdapter implements RuntimeAdapter {
  readonly type = 'spring-boot' as const;
  readonly label = 'Spring Boot';
  readonly supportsDebug = false;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    const info = await readSpringBootInfo(folder);
    if (!info) return null;
    if (!info.hasSpringBootApplication) return null;

    const [mainClasses, gradleCommand, jdks, classpath] = await Promise.all([
      findMainClasses(folder),
      detectGradleCommand(folder),
      detectJdks(),
      suggestClasspath(folder, info.buildTool),
    ]);

    return {
      defaults: {
        type: 'spring-boot',
        typeOptions: {
          launchMode: info.buildTool, // default: same as the detected build tool
          buildTool: info.buildTool,
          gradleCommand,
          profiles: '',
          mainClass: mainClasses[0]?.fqn ?? '',
          classpath,
          jdkPath: jdks[0] ?? '',
          module: '',
        },
      },
      context: {
        buildTool: info.buildTool,
        gradleCommand,
        mainClasses,
        jdks,
      },
    };
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const mainClasses = (context.mainClasses as MainClassCandidate[] | undefined) ?? [];
    const jdks = (context.jdks as string[] | undefined) ?? [];
    const detectedBuildTool = (context.buildTool as string | undefined) ?? 'maven';
    const detectedGradle = (context.gradleCommand as string | undefined) ?? './gradlew';

    const mainClassOptions = mainClasses.map(m => ({
      value: m.fqn,
      label: m.isSpringBoot ? `🚀 ${m.fqn}` : m.fqn,
    }));

    const jdkOptions = jdks.map(p => ({ value: p, label: p }));

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
          kind: 'text',
          key: 'typeOptions.profiles',
          label: 'Active profiles',
          placeholder: 'dev,local',
          help: 'Spring profiles to activate (comma-separated).',
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
          help: 'Colon-separated on macOS/Linux, semicolon on Windows. Run "Recompute classpath" (button below) to refresh from your build tool. You must compile at least once so classes exist on disk.',
          dependsOn: { key: 'typeOptions.launchMode', equals: 'java-main' },
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
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Merged on top of inherited env.',
          examples: ['SPRING_PROFILES_ACTIVE=dev', 'JAVA_HOME=/opt/jdk-21'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--server.port=8081',
          help: 'Passed to the Spring Boot app.',
          examples: ['--server.port=8081', '--debug'],
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args',
          placeholder: '-Xmx1g',
          help: 'JVM flags. Applied directly in java-main mode; wrapped in -Dspring-boot.run.jvmArguments for Maven; ignored by Gradle.',
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC'],
        },
      ],
    };
  }

  buildCommand(cfg: RunConfig): { command: string; args: string[] } {
    if (cfg.type !== 'spring-boot') {
      throw new Error('SpringBootAdapter received non-spring-boot config');
    }
    switch (cfg.typeOptions.launchMode) {
      case 'maven':     return buildMaven(cfg);
      case 'gradle':    return buildGradle(cfg);
      case 'java-main': return buildJavaMain(cfg);
    }
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
  return { command: 'mvn', args };
}

function buildGradle(cfg: Extract<RunConfig, { type: 'spring-boot' }>) {
  const to = cfg.typeOptions;
  const programArgs = splitArgs(cfg.programArgs ?? '');
  const profiles = to.profiles.trim();

  const args: string[] = ['bootRun'];
  const runArgs: string[] = [];
  if (profiles) runArgs.push(`--spring.profiles.active=${profiles}`);
  runArgs.push(...programArgs);
  if (runArgs.length > 0) args.push(`--args=${shellQuote(runArgs.join(' '))}`);
  return { command: to.gradleCommand, args };
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
