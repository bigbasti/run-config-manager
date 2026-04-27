import { z } from 'zod';
import type { RunFile, Result } from './types';

export const PackageManagerSchema = z.enum(['npm', 'yarn', 'pnpm']);
export const JavaBuildToolSchema = z.enum(['maven', 'gradle']);

export const NpmTypeOptionsSchema = z.object({
  scriptName: z.string().min(1),
  packageManager: PackageManagerSchema,
});

export const SpringBootLaunchModeSchema = z.enum(['maven', 'gradle', 'java-main']);
export const GradleCommandSchema = z.enum(['./gradlew', 'gradle']);

export const SpringBootTypeOptionsSchema = z
  .object({
    launchMode: SpringBootLaunchModeSchema,
    buildTool: JavaBuildToolSchema,
    gradleCommand: GradleCommandSchema,
    profiles: z.string(),
    mainClass: z.string(),
    classpath: z.string(),
    jdkPath: z.string(),
    module: z.string(),
    gradlePath: z.string(),
    mavenPath: z.string(),
    buildRoot: z.string(),
    debugPort: z.number().int().min(1).max(65535).optional(),
    rebuildOnSave: z.boolean().optional(),
    colorOutput: z.boolean().optional(),
  })
  .superRefine((opts, ctx) => {
    if (opts.launchMode === 'java-main') {
      if (!opts.mainClass.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'mainClass is required for java-main launch',
          path: ['mainClass'],
        });
      }
      if (!opts.classpath.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'classpath is required for java-main launch',
          path: ['classpath'],
        });
      }
    }
  });

const commonFields = {
  id: z.string().uuid(),
  name: z.string().min(1),
  projectPath: z.string(),
  workspaceFolder: z.string(),
  env: z.record(z.string(), z.string()),
  programArgs: z.string(),
  vmArgs: z.string(),
  port: z.number().int().positive().optional(),
};

export const JavaLaunchModeSchema = z.enum([
  'maven',
  'gradle',
  'java-main',
  'maven-custom',
  'gradle-custom',
]);

export const JavaTypeOptionsSchema = z
  .object({
    launchMode: JavaLaunchModeSchema,
    buildTool: JavaBuildToolSchema,
    gradleCommand: GradleCommandSchema,
    mainClass: z.string(),
    classpath: z.string(),
    customArgs: z.string(),
    jdkPath: z.string(),
    module: z.string(),
    gradlePath: z.string(),
    mavenPath: z.string(),
    buildRoot: z.string(),
    debugPort: z.number().int().min(1).max(65535).optional(),
    colorOutput: z.boolean().optional(),
  })
  .superRefine((opts, ctx) => {
    // mainClass is required for java-main (the class we `java`) and for
    // maven (passed as -Dexec.mainClass=). Gradle's `run` task reads it from
    // the `application` plugin block in build.gradle. Custom modes ignore it.
    if ((opts.launchMode === 'maven' || opts.launchMode === 'java-main') && !opts.mainClass.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mainClass is required for ${opts.launchMode} launch`,
        path: ['mainClass'],
      });
    }
    if (opts.launchMode === 'java-main' && !opts.classpath.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'classpath is required for java-main launch',
        path: ['classpath'],
      });
    }
    if ((opts.launchMode === 'maven-custom' || opts.launchMode === 'gradle-custom')
        && !opts.customArgs.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `customArgs is required for ${opts.launchMode} launch`,
        path: ['customArgs'],
      });
    }
  });

export const CustomShellSchema = z.enum(['default', 'bash', 'sh', 'zsh', 'pwsh', 'cmd']);

export const CustomCommandTypeOptionsSchema = z
  .object({
    command: z.string(),
    cwd: z.string(),
    shell: CustomShellSchema,
    interactive: z.boolean(),
    colorOutput: z.boolean().optional(),
  })
  .superRefine((opts, ctx) => {
    if (!opts.command.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command is required',
        path: ['command'],
      });
    }
  });

export const MavenGoalTypeOptionsSchema = z
  .object({
    goal: z.string(),
    jdkPath: z.string(),
    mavenPath: z.string(),
    buildRoot: z.string(),
    colorOutput: z.boolean().optional(),
  })
  .superRefine((opts, ctx) => {
    if (!opts.goal.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'goal is required — at least one Maven phase or goal',
        path: ['goal'],
      });
    }
  });

export const GradleTaskTypeOptionsSchema = z
  .object({
    task: z.string(),
    gradleCommand: GradleCommandSchema,
    jdkPath: z.string(),
    gradlePath: z.string(),
    buildRoot: z.string(),
    colorOutput: z.boolean().optional(),
  })
  .superRefine((opts, ctx) => {
    if (!opts.task.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task is required — at least one Gradle task name',
        path: ['task'],
      });
    }
  });

export const QuarkusLaunchModeSchema = z.enum(['maven', 'gradle']);

export const QuarkusTypeOptionsSchema = z
  .object({
    launchMode: QuarkusLaunchModeSchema,
    buildTool: JavaBuildToolSchema,
    gradleCommand: GradleCommandSchema,
    profile: z.string(),
    jdkPath: z.string(),
    module: z.string(),
    gradlePath: z.string(),
    mavenPath: z.string(),
    buildRoot: z.string(),
    debugPort: z.number().int().min(1).max(65535).optional(),
    colorOutput: z.boolean().optional(),
  });

export const ArtifactKindSchema = z.enum(['war', 'exploded']);
export const TomcatBuildToolSchema = z.enum(['gradle', 'maven', 'none']);

export const TomcatTypeOptionsSchema = z
  .object({
    tomcatHome: z.string(),
    jdkPath: z.string(),
    httpPort: z.number().int().min(1).max(65535),
    httpsPort: z.number().int().min(1).max(65535).optional(),
    ajpPort: z.number().int().min(1).max(65535).optional(),
    jmxPort: z.number().int().min(1).max(65535).optional(),
    debugPort: z.number().int().min(1).max(65535).optional(),
    buildProjectPath: z.string(),
    buildRoot: z.string(),
    buildTool: TomcatBuildToolSchema,
    gradleCommand: GradleCommandSchema,
    gradlePath: z.string(),
    mavenPath: z.string(),
    artifactPath: z.string(),
    artifactKind: ArtifactKindSchema,
    applicationContext: z.string(),
    profiles: z.string(),
    vmOptions: z.string(),
    reloadable: z.boolean(),
    rebuildOnSave: z.boolean(),
    colorOutput: z.boolean().optional(),
  })
  .superRefine((opts, ctx) => {
    if (!opts.tomcatHome.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tomcatHome is required',
        path: ['tomcatHome'],
      });
    }
    if (!opts.artifactPath.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'artifactPath is required — pick a WAR or exploded directory',
        path: ['artifactPath'],
      });
    }
  });

export const DockerTypeOptionsSchema = z
  .object({
    containerId: z.string(),
    containerName: z.string().optional(),
  })
  .superRefine((opts, ctx) => {
    if (!opts.containerId.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pick a container from the dropdown, or paste its id.',
        path: ['containerId'],
      });
    }
  });

export const RunConfigSchema = z.discriminatedUnion('type', [
  z.object({
    ...commonFields,
    type: z.literal('npm'),
    typeOptions: NpmTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('spring-boot'),
    typeOptions: SpringBootTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('tomcat'),
    typeOptions: TomcatTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('quarkus'),
    typeOptions: QuarkusTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('java'),
    typeOptions: JavaTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('maven-goal'),
    typeOptions: MavenGoalTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('gradle-task'),
    typeOptions: GradleTaskTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('custom-command'),
    typeOptions: CustomCommandTypeOptionsSchema,
  }),
  z.object({
    ...commonFields,
    type: z.literal('docker'),
    typeOptions: DockerTypeOptionsSchema,
  }),
]);

export const RunFileSchema = z.object({
  version: z.literal(1),
  configurations: z.array(RunConfigSchema),
});

export function parseRunFile(raw: string): Result<RunFile, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const result = RunFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join('.');
    return { ok: false, error: `Schema error at "${path}": ${issue.message}` };
  }
  return { ok: true, value: result.data };
}

export function stringifyRunFile(file: RunFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}
