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
  } else if (cfg.type === 'quarkus') {
    const to = cfg.typeOptions;
    const port = typeof to.debugPort === 'number' && to.debugPort > 0 ? to.debugPort : 5005;
    const prof = to.profile?.trim() ? ` -Dquarkus.profile=${to.profile.trim()}` : '';
    if (to.launchMode === 'gradle') {
      base = `${to.gradleCommand} --console=plain quarkusDev${prof} -Ddebug=${port}`;
    } else {
      base = `mvn quarkus:dev${prof} -Ddebug=${port}`;
    }
  } else if (cfg.type === 'java') {
    const to = cfg.typeOptions;
    if (to.launchMode === 'java-main') {
      const javaBin = to.jdkPath ? `${to.jdkPath.replace(/[/\\]$/, '')}/bin/java` : 'java';
      const vm = cfg.vmArgs?.trim() ? ` ${cfg.vmArgs.trim()}` : '';
      const cp = to.classpath?.trim() ? ` -cp ${to.classpath.trim()}` : '';
      const mc = to.mainClass || '<MainClass>';
      const pa = cfg.programArgs?.trim() ? ` ${cfg.programArgs.trim()}` : '';
      base = `${javaBin}${vm}${cp} ${mc}${pa}`;
    } else if (to.launchMode === 'gradle-custom') {
      // Raw Gradle tail — whatever the user typed in customArgs.
      const tail = to.customArgs?.trim() || '<args>';
      base = `${to.gradleCommand} ${tail}`;
    } else if (to.launchMode === 'maven-custom') {
      const tail = to.customArgs?.trim() || '<args>';
      base = `mvn ${tail}`;
    } else if (to.launchMode === 'gradle') {
      const pa = cfg.programArgs?.trim() ? ` --args='${cfg.programArgs.trim()}'` : '';
      base = `${to.gradleCommand} --console=plain run${pa}`;
    } else {
      const mc = to.mainClass || '<MainClass>';
      const pa = cfg.programArgs?.trim() ? ` -Dexec.args='${cfg.programArgs.trim()}'` : '';
      base = `mvn exec:java -Dexec.mainClass=${mc}${pa}`;
    }
  } else if (cfg.type === 'maven-goal') {
    const to = cfg.typeOptions;
    const mvn = to.mavenPath ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn` : 'mvn';
    base = `${mvn} ${to.goal?.trim() || '<goal>'}`;
  } else if (cfg.type === 'gradle-task') {
    const to = cfg.typeOptions;
    const gradle = to.gradleCommand === './gradlew'
      ? './gradlew'
      : to.gradlePath ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle` : 'gradle';
    base = `${gradle} --console=plain ${to.task?.trim() || '<task>'}`;
  } else if (cfg.type === 'custom-command') {
    // Show the command verbatim; the cwd prefix is added by the common
    // suffix logic below (reads cfg.projectPath). When the user set an
    // explicit typeOptions.cwd override, prefer it.
    const to = cfg.typeOptions;
    const cmd = to.command?.trim() || '<command>';
    if (to.cwd?.trim()) {
      return `cd ${to.cwd.trim()} && ${cmd}`;
    }
    base = cmd;
  } else {
    return `(unsupported type: ${(cfg as RunConfig).type})`;
  }

  // Adapters that bake programArgs into their preview, or don't use
  // programArgs at all (maven-goal / gradle-task drive everything from their
  // goal/task field). Only spring-boot's maven/gradle preview and npm still
  // need the trailing `-- <args>` suffix.
  const programArgsApplied =
    (cfg.type === 'spring-boot' && cfg.typeOptions.launchMode === 'java-main') ||
    cfg.type === 'java' ||
    cfg.type === 'quarkus' ||
    cfg.type === 'tomcat' ||
    cfg.type === 'maven-goal' ||
    cfg.type === 'gradle-task' ||
    cfg.type === 'custom-command';
  const args = (cfg.programArgs ?? '').trim();
  const withArgs = !programArgsApplied && args ? `${base} -- ${args}` : base;
  return cfg.projectPath ? `cd ${cfg.projectPath} && ${withArgs}` : withArgs;
}
