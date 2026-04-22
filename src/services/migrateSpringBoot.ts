// Normalises pre-1c spring-boot configs: fills in launchMode + new fields so
// Zod validation succeeds. Pure; call once on every row read from disk before
// schema parsing.
export function migrateSpringBootConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'spring-boot') return raw;

  const to = (r.typeOptions && typeof r.typeOptions === 'object' ? r.typeOptions : {}) as Record<string, unknown>;

  const launchMode =
    (typeof to.launchMode === 'string' ? (to.launchMode as string) : undefined) ??
    (typeof to.buildTool === 'string' ? (to.buildTool as string) : undefined) ??
    'maven';

  const buildTool =
    (typeof to.buildTool === 'string' ? (to.buildTool as string) : undefined) ??
    (launchMode === 'gradle' ? 'gradle' : 'maven');

  const gradleCommand =
    (typeof to.gradleCommand === 'string' ? (to.gradleCommand as string) : undefined) ?? './gradlew';

  return {
    ...r,
    typeOptions: {
      launchMode,
      buildTool,
      gradleCommand,
      profiles: typeof to.profiles === 'string' ? to.profiles : '',
      mainClass: typeof to.mainClass === 'string' ? to.mainClass : '',
      classpath: typeof to.classpath === 'string' ? to.classpath : '',
      jdkPath: typeof to.jdkPath === 'string' ? to.jdkPath : '',
      module: typeof to.module === 'string' ? to.module : '',
      // 1c.1 additions — legacy configs default to empty.
      gradlePath: typeof to.gradlePath === 'string' ? to.gradlePath : '',
      mavenPath: typeof to.mavenPath === 'string' ? to.mavenPath : '',
      buildRoot: typeof to.buildRoot === 'string' ? to.buildRoot : '',
    },
  };
}
