import type { RunConfig } from './types';

// Renders what we'll actually execute at run time, so the user isn't surprised
// when they hit Run. Mirrors ExecutionService.buildCwd + the adapter
// buildCommand paths — when those change, this must too.
//
// `workspaceFolderPath` is the absolute fs path of the workspace folder the
// config belongs to. Required to compute the real cwd (buildRoot wins over
// projectPath for JVM configs) and the Gradle `:module:task` prefix when the
// user selected a submodule. Falls back to the legacy `cd <projectPath>`
// preview when omitted (e.g., rendering from the tree provider which doesn't
// always have the folder context handy).
export function buildCommandPreview(cfg: RunConfig, workspaceFolderPath?: string): string {
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
      const task = moduleTask('bootRun', cfg, workspaceFolderPath);
      base = rest.length
        ? `${to.gradleCommand} ${task} --args='${rest.join(' ')}'`
        : `${to.gradleCommand} ${task}`;
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
      const task = moduleTask('quarkusDev', cfg, workspaceFolderPath);
      base = `${to.gradleCommand} --console=plain ${task}${prof} -Ddebug=${port}`;
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
      const task = moduleTask('run', cfg, workspaceFolderPath);
      base = `${to.gradleCommand} --console=plain ${task}${pa}`;
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

  const cwdLabel = previewCwd(cfg, workspaceFolderPath);
  return cwdLabel ? `cd ${cwdLabel} && ${withArgs}` : withArgs;
}

// Mirrors ExecutionService.buildCwd — when buildRoot is set on a JVM
// Maven/Gradle config, that's the real cwd, not projectPath. Returns a
// workspace-relative label ('.' for the workspace root itself) when we can
// compute it, or the raw string when we don't have the workspace folder.
function previewCwd(cfg: RunConfig, workspaceFolderPath?: string): string {
  const br = buildRootFor(cfg);
  if (br) return displayPath(br, workspaceFolderPath);
  if (cfg.projectPath) return cfg.projectPath;
  return '';
}

function buildRootFor(cfg: RunConfig): string | undefined {
  if (cfg.type === 'spring-boot') {
    const to = cfg.typeOptions;
    if ((to.launchMode === 'maven' || to.launchMode === 'gradle') && to.buildRoot) {
      return to.buildRoot;
    }
  }
  if (cfg.type === 'quarkus' && cfg.typeOptions.buildRoot) return cfg.typeOptions.buildRoot;
  if (cfg.type === 'java') {
    const to = cfg.typeOptions;
    if ((to.launchMode === 'maven' || to.launchMode === 'gradle') && to.buildRoot) {
      return to.buildRoot;
    }
  }
  return undefined;
}

// Gradle `:module:task` prefix derived from buildRoot + projectPath. Mirrors
// gradleModulePrefix in findBuildRoot.ts but works off the webview's string
// fields. Returns the bare task when we can't compute a prefix.
function moduleTask(baseTask: string, cfg: RunConfig, workspaceFolderPath?: string): string {
  const br = buildRootFor(cfg);
  if (!br || !workspaceFolderPath) return baseTask;
  const projectAbs = joinPath(workspaceFolderPath, cfg.projectPath ?? '');
  if (projectAbs === br) return baseTask;
  if (!projectAbs.startsWith(br + '/')) return baseTask;
  const rel = projectAbs.slice(br.length + 1);
  return `:${rel.split('/').join(':')}:${baseTask}`;
}

// Produce a short, human-readable rendering of the absolute path for the
// preview line. Inside the workspace → relative path (or '.' for the root),
// otherwise the absolute path itself.
function displayPath(abs: string, workspaceFolderPath?: string): string {
  if (!workspaceFolderPath) return abs;
  if (abs === workspaceFolderPath) return '.';
  if (abs.startsWith(workspaceFolderPath + '/')) {
    return abs.slice(workspaceFolderPath.length + 1);
  }
  return abs;
}

function joinPath(a: string, b: string): string {
  if (!b) return a;
  if (b.startsWith('/')) return b;
  return `${a}/${b}`;
}
