import type { RunConfig } from './types';

export function buildCommandPreview(cfg: RunConfig): string {
  let base: string;
  if (cfg.type === 'npm') {
    const pm = cfg.typeOptions.packageManager;
    const script = cfg.typeOptions.scriptName || '<script>';
    base = `${pm} run ${script}`;
  } else if (cfg.type === 'spring-boot') {
    const to = cfg.typeOptions;
    if (to.launchMode === 'java-main') {
      const javaBin = to.jdkPath ? `${to.jdkPath.replace(/[/\\]$/, '')}/bin/java` : 'java';
      const vm = cfg.vmArgs?.trim() ? ` ${cfg.vmArgs.trim()}` : '';
      const cp = to.classpath?.trim() ? ` -cp ${to.classpath.trim()}` : '';
      const prof = to.profiles?.trim() ? ` -Dspring.profiles.active=${to.profiles.trim()}` : '';
      const mc = to.mainClass || '<MainClass>';
      const pa = cfg.programArgs?.trim() ? ` ${cfg.programArgs.trim()}` : '';
      base = `${javaBin}${vm}${cp}${prof} ${mc}${pa}`;
    } else if (to.launchMode === 'gradle') {
      const profiles = to.profiles?.trim();
      const rest: string[] = [];
      if (profiles) rest.push(`--spring.profiles.active=${profiles}`);
      if (cfg.programArgs?.trim()) rest.push(cfg.programArgs.trim());
      base = rest.length
        ? `${to.gradleCommand} bootRun --args='${rest.join(' ')}'`
        : `${to.gradleCommand} bootRun`;
    } else {
      const profiles = to.profiles?.trim();
      base = profiles
        ? `mvn spring-boot:run -Dspring-boot.run.profiles=${profiles}`
        : 'mvn spring-boot:run';
    }
  } else if (cfg.type === 'tomcat') {
    const to = cfg.typeOptions;
    const home = to.tomcatHome || '<TOMCAT_HOME>';
    const ctx = (to.applicationContext || '/').trim();
    base = `${home}/bin/catalina.sh run  # deploy ${to.artifactPath || '<artifact>'} → ${ctx} on :${to.httpPort}`;
  } else {
    return `(unsupported type: ${(cfg as RunConfig).type})`;
  }

  const programArgsApplied =
    cfg.type === 'spring-boot' && cfg.typeOptions.launchMode === 'java-main';
  const args = (cfg.programArgs ?? '').trim();
  const withArgs = !programArgsApplied && args ? `${base} -- ${args}` : base;
  return cfg.projectPath ? `cd ${cfg.projectPath} && ${withArgs}` : withArgs;
}
