import type { RunConfig } from './types';

// Pure, synchronous preview used by the webview (no vscode imports).
// Mirrors each adapter's buildCommand for display purposes only.
export function buildCommandPreview(cfg: RunConfig): string {
  let base: string;
  if (cfg.type === 'npm') {
    const pm = cfg.typeOptions.packageManager;
    const script = cfg.typeOptions.scriptName || '<script>';
    base = `${pm} run ${script}`;
  } else if (cfg.type === 'spring-boot') {
    const profiles = cfg.typeOptions.profiles?.trim();
    if (cfg.typeOptions.buildTool === 'gradle') {
      base = profiles ? `./gradlew bootRun --args='${profiles}'` : './gradlew bootRun';
    } else {
      base = profiles
        ? `mvn spring-boot:run -Dspring-boot.run.profiles=${profiles}`
        : 'mvn spring-boot:run';
    }
  } else {
    return `(unsupported type: ${(cfg as RunConfig).type})`;
  }

  const args = (cfg.programArgs ?? '').trim();
  const withArgs = args ? `${base} -- ${args}` : base;
  return cfg.projectPath ? `cd ${cfg.projectPath} && ${withArgs}` : withArgs;
}
