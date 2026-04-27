// Normalises legacy configs: fills in fields added in later versions so Zod
// validation succeeds. Pure; call once on every row read from disk before
// schema parsing. Handles spring-boot (1c fields) and tomcat (profiles field
// added in the profile-plumbing change).
export function migrateSpringBootConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (r.type === 'tomcat') return migrateTomcat(r);
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
      // 1c.2: debug port. Omit when absent so the schema's .optional() holds.
      ...(typeof to.debugPort === 'number' ? { debugPort: to.debugPort } : {}),
      ...(typeof to.rebuildOnSave === 'boolean' ? { rebuildOnSave: to.rebuildOnSave } : {}),
      ...(typeof to.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
    },
  };
}

function migrateTomcat(r: Record<string, unknown>): unknown {
  const to = (r.typeOptions && typeof r.typeOptions === 'object' ? r.typeOptions : {}) as Record<string, unknown>;
  // Only rewrite when the profiles field is missing — everything else in
  // TomcatTypeOptions was present from v1. Keep user-set values untouched.
  if (typeof to.profiles === 'string') return r;
  return { ...r, typeOptions: { ...to, profiles: '' } };
}
