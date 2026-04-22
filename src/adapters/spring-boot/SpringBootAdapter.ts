import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema } from '../../shared/formSchema';
import { readSpringBootInfo } from './detectSpringBoot';
import { splitArgs } from '../npm/splitArgs';

export class SpringBootAdapter implements RuntimeAdapter {
  readonly type = 'spring-boot' as const;
  readonly label = 'Spring Boot';
  // Debug support is deferred — needs the Java debug extension and a
  // two-step start-then-attach dance. Will be its own sub-project.
  readonly supportsDebug = false;

  async detect(folder: vscode.Uri): Promise<DetectionResult | null> {
    const info = await readSpringBootInfo(folder);
    if (!info) return null;
    // Only claim detection when we actually see Spring Boot evidence.
    // If the project is Maven/Gradle but NOT Spring Boot, return null so the
    // user sees the "no project detected" warning.
    if (!info.hasSpringBootApplication) return null;

    return {
      defaults: {
        type: 'spring-boot',
        typeOptions: {
          buildTool: info.buildTool,
          profiles: '',
        },
      },
      context: { buildTool: info.buildTool },
    };
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const detectedBuildTool = (context.buildTool as string | undefined) ?? 'maven';
    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'My Spring App',
          help: 'Display name shown in the sidebar. Purely cosmetic — pick whatever you like.',
          examples: ['API server', 'Backend dev'],
        },
        {
          kind: 'folderPath',
          key: 'projectPath',
          label: 'Project path',
          relativeTo: 'workspaceFolder',
          help: 'Path to the Spring Boot project, relative to the workspace folder. Leave blank if pom.xml / build.gradle lives at the workspace root.',
          examples: ['', 'backend', 'services/api'],
        },
      ],
      typeSpecific: [
        {
          kind: 'select',
          key: 'typeOptions.buildTool',
          label: 'Build tool',
          options: [
            { value: 'maven', label: 'Maven (mvn spring-boot:run)' },
            { value: 'gradle', label: 'Gradle (./gradlew bootRun)' },
          ],
          help: `We auto-detect from pom.xml / build.gradle (detected: ${detectedBuildTool}). Override if your project has both.`,
          examples: ['maven', 'gradle'],
        },
        {
          kind: 'text',
          key: 'typeOptions.profiles',
          label: 'Active profiles',
          placeholder: 'dev,local',
          help: 'Spring profiles to activate (comma-separated). Passed as -Dspring-boot.run.profiles for Maven or --args=\'--spring.profiles.active=...\' for Gradle.',
          examples: ['dev', 'dev,local', 'prod'],
        },
        {
          kind: 'number',
          key: 'port',
          label: 'Port (optional)',
          min: 1,
          max: 65535,
          help: 'Informational only — lets you remember which port the app binds to. Spring Boot reads the port from application.properties / profile config.',
          examples: ['8080', '8081'],
        },
      ],
      advanced: [
        {
          kind: 'kv',
          key: 'env',
          label: 'Environment variables',
          help: 'Extra env vars merged on top of VS Code\'s inherited env (e.g. JAVA_HOME override, SPRING_DATASOURCE_URL).',
          examples: ['SPRING_PROFILES_ACTIVE=dev', 'JAVA_HOME=/opt/jdk-21'],
        },
        {
          kind: 'text',
          key: 'programArgs',
          label: 'Program args',
          placeholder: '--server.port=8081',
          help: 'Arguments passed to the Spring Boot app. For Maven these become -Dspring-boot.run.arguments; for Gradle they go into --args=\'...\'.',
          examples: ['--server.port=8081', '--debug'],
        },
        {
          kind: 'text',
          key: 'vmArgs',
          label: 'VM args',
          placeholder: '-Xmx1g',
          help: 'JVM flags passed via -Dspring-boot.run.jvmArguments (Maven) or JAVA_OPTS-style (Gradle).',
          examples: ['-Xmx1g', '-Xmx2g -XX:+UseG1GC'],
        },
      ],
    };
  }

  buildCommand(cfg: RunConfig): { command: string; args: string[] } {
    if (cfg.type !== 'spring-boot') throw new Error('SpringBootAdapter received non-spring-boot config');
    const to = cfg.typeOptions;
    const programArgs = splitArgs(cfg.programArgs ?? '');
    const vmArgs = (cfg.vmArgs ?? '').trim();
    const profiles = to.profiles?.trim();

    if (to.buildTool === 'gradle') {
      // ./gradlew bootRun takes program args via --args='...'. VM args go
      // through JAVA_OPTS env (set at shell level by user if needed).
      const args: string[] = ['bootRun'];
      const runArgs: string[] = [];
      if (profiles) runArgs.push(`--spring.profiles.active=${profiles}`);
      runArgs.push(...programArgs);
      if (runArgs.length > 0) args.push(`--args=${shellQuote(runArgs.join(' '))}`);
      return { command: './gradlew', args };
    }

    // Maven default.
    const args: string[] = ['spring-boot:run'];
    if (profiles) args.push(`-Dspring-boot.run.profiles=${profiles}`);
    if (programArgs.length > 0) {
      args.push(`-Dspring-boot.run.arguments=${shellQuote(programArgs.join(' '))}`);
    }
    if (vmArgs) args.push(`-Dspring-boot.run.jvmArguments=${shellQuote(vmArgs)}`);
    return { command: 'mvn', args };
  }
}

// Wrap a token in single quotes for shell-safe passing. Inner single quotes
// get the standard 'xx'\''xx' escape.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
