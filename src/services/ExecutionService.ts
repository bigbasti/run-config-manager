import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { RunConfig } from '../shared/types';
import { log, initLogger } from '../utils/logger';
import { runHttpRequest } from './HttpRequestRunner';
import { resolveProjectUri } from '../utils/paths';
import { gradleModulePrefix } from '../adapters/spring-boot/findBuildRoot';
import { makeRunContext, resolveConfig } from '../utils/resolveVars';
import { RunTerminal } from './RunTerminal';
import {
  readyPatternsFor,
  failurePatternsFor,
  rebuildPatternsFor,
  firstMatch,
} from './readyPatterns';
import { makePrettifier } from './prettyOutput';
import { loadEnvFiles } from './EnvFileLoader';

interface Entry {
  execution: vscode.TaskExecution;
  configId: string;
  // Side task (e.g., `gradle -t classes` watcher). Terminated whenever the
  // main task stops; its own lifecycle doesn't affect the config's running
  // state.
  watcher?: vscode.TaskExecution;
  // Timer that marks the config "started" after a fixed delay. Used for
  // runtimes where we can't (or don't want to) observe stdout — Quarkus
  // uses its own interactive shell, so we surrender log scanning and just
  // assume the app is up after 15s. Cleared if the task ends early.
  readyTimer?: NodeJS.Timeout;
  // Ref to the RunTerminal instance, when this config went through the
  // CustomExecution path (vs ShellExecution). Held so stop() can kill
  // the child directly without going through VS Code's
  // TaskExecution.terminate, which would close the pseudoterminal
  // before linger-mode could kick in.
  //
  // It's a ref-holder (not a direct field) because the CustomExecution
  // callback that creates the RunTerminal runs asynchronously — by the
  // time we build the Entry after `executeTask` resolves, the callback
  // may not have run yet. Storing a shared object lets the callback
  // mutate `.current` later and have stop() see the value.
  // Undefined for shell-execution configs (Quarkus, interactive
  // custom-command) — those don't support linger anyway.
  terminalRef?: { current?: RunTerminal };
  // Mirror of resolvedCfg.closeTerminalOnExit at run start. stop()
  // uses this to decide whether to go through the linger-aware
  // bypass or VS Code's normal terminate path. Stored on the entry
  // so the cfg-mutation timing doesn't matter at stop time.
  closeTerminalOnExit?: boolean;
}

export interface RunOpts {
  // When true, prepareLaunch is called with { debug: true } so adapters can
  // wire in JDWP flags. DebugService uses this to attach after the JVM boots.
  debug?: boolean;
  debugPort?: number;
}

export class ExecutionService {
  private running = new Map<string, Entry>();
  // "Preparing" is the window between the user clicking Run and the shell
  // execution actually spawning. For Tomcat this can be 30+ seconds while
  // Gradle builds the WAR. Tree provider reads this to show a distinct
  // busy-but-not-yet-running state.
  private preparing = new Set<string>();
  // "Started" means the log scanner matched a readiness phrase for this
  // config's type. Tree provider upgrades the spinner to a green check.
  // Configs whose output never matches a known pattern just stay in the
  // spinner state — correctness trumps a false "ready" signal.
  private started = new Set<string>();
  // "Failed" means the log scanner matched a startup-failure pattern (e.g.
  // "APPLICATION FAILED TO START"). Renders as a red circle; the process may
  // still be alive but the tree reflects the terminal state.
  private failed = new Set<string>();
  // "Rebuilding" is a transient state that dev servers (Angular, Vite, CRA,
  // webpack, Next.js) enter on file-watch. Scanner flips us here from either
  // started or failed; the next ready/failure pattern moves us back. Renders
  // as a yellow sync-spin in the tree. Mutually exclusive with started and
  // failed while active.
  private rebuilding = new Set<string>();
  // Transient flash for http-request configs: after the request finishes
  // we surface the response class on the tree row for 3 seconds, then
  // clear back to the brand icon. 'success' = 2xx (green check),
  // 'warn' = 4xx (yellow warning), 'error' = 5xx or assert/network
  // failure (red error). Using a 3-state enum (instead of leaning on
  // started/failed) so the existing long-running config state machine
  // isn't disturbed.
  private httpFlash = new Map<string, 'success' | 'warn' | 'error'>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onRunningChanged = this.emitter.event;
  private taskEndSub: vscode.Disposable;

  constructor(private readonly registry: AdapterRegistry) {
    this.taskEndSub = vscode.tasks.onDidEndTask(e => this.handleEnd(e.execution));
  }

  isRunning(configId: string): boolean {
    return this.running.has(configId);
  }

  isPreparing(configId: string): boolean {
    return this.preparing.has(configId);
  }

  isStarted(configId: string): boolean {
    return this.started.has(configId);
  }

  isFailed(configId: string): boolean {
    return this.failed.has(configId);
  }

  isRebuilding(configId: string): boolean {
    return this.rebuilding.has(configId);
  }

  // Reads the post-run flash state for an http-request config. Tree
  // provider checks this on every render to pick the right transient
  // icon. Returns undefined when not flashing.
  httpFlashOf(configId: string): 'success' | 'warn' | 'error' | undefined {
    return this.httpFlash.get(configId);
  }

  // Reveal the integrated terminal for the given running config. VS Code
  // names task terminals "Task - <source>: <taskName>" (versions vary —
  // older builds drop the "Task - " prefix). We match by substring against
  // the config's display name since the source is stable ("Run
  // Configurations"). No-op if the config isn't running or the terminal
  // was already closed.
  focus(configId: string): void {
    const entry = this.running.get(configId);
    if (!entry) return;
    const taskName = entry.execution.task.name;
    const needle = `Run Configurations: ${taskName}`;
    for (const term of vscode.window.terminals) {
      if (term.name === taskName || term.name.includes(needle) || term.name.endsWith(taskName)) {
        term.show(true);
        return;
      }
    }
    log.warn(`focus(${configId}): no terminal found for "${taskName}"`);
  }

  async run(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    opts?: RunOpts,
  ): Promise<vscode.TaskExecution | undefined> {
    if (this.running.has(cfg.id)) return undefined;

    const adapter = this.registry.get(cfg.type);
    if (!adapter) {
      vscode.window.showErrorMessage(`No adapter for type: ${cfg.type}`);
      return undefined;
    }

    // HTTP Request configs bypass the entire ShellExecution machinery —
    // the request is performed in-process, results stream to the user's
    // chosen sink, and the tree row flashes a status icon for 3s
    // before reverting to the brand icon.
    if (cfg.type === 'http-request') {
      await this.runHttpRequest(cfg, folder);
      return undefined;
    }

    // Resolve ${VAR} / ${env:VAR} / ${workspaceFolder} etc. in every text field
    // of the config. Unresolved variables become empty strings and are logged.
    const initialCwd = buildCwd(cfg, folder);
    const ctx = makeRunContext({ workspaceFolder: folder.uri.fsPath, cwd: initialCwd });
    const { value: resolvedCfg, unresolved } = resolveConfig(cfg, ctx);
    if (unresolved.length) {
      log.warn(`Unresolved variable(s) in "${cfg.name}": ${unresolved.join(', ')} (expanded to empty string)`);
    }

    // Let the adapter prep any filesystem state / env vars (Tomcat writes its
    // CATALINA_BASE scaffold here). prepareLaunch may override cwd.
    let prepared: { env?: Record<string, string>; cwd?: string; extraArgs?: string[]; cfg?: RunConfig } = {};
    if (adapter.prepareLaunch) {
      this.preparing.add(cfg.id);
      this.emitter.fire(cfg.id);
      log.debug(`Preparing launch: ${cfg.name} (debug=${opts?.debug ?? false})`);
      try {
        prepared = await adapter.prepareLaunch(resolvedCfg, folder, {
          debug: opts?.debug ?? false,
          debugPort: opts?.debugPort,
        });
        const envKeys = Object.keys(prepared.env ?? {});
        if (envKeys.length || prepared.cwd) {
          log.debug(
            `prepareLaunch result: env=[${envKeys.join(', ')}]` +
            (prepared.cwd ? `, cwd=${prepared.cwd}` : ''),
          );
        }
      } catch (e) {
        this.preparing.delete(cfg.id);
        this.emitter.fire(cfg.id);
        log.error(`prepareLaunch failed for ${cfg.name}`, e);
        vscode.window.showErrorMessage(`Failed to prepare "${cfg.name}": ${(e as Error).message}`);
        return undefined;
      }
      this.preparing.delete(cfg.id);
      this.emitter.fire(cfg.id);
    }

    const cwd = prepared.cwd ?? initialCwd;
    // prepared.cfg lets prepareLaunch swap in a freshly-computed config
    // (Spring Boot's "Recompute classpath on each run" rewrites the
    // classpath right before launch). Falls back to the original when
    // the adapter doesn't override.
    const effectiveCfg = prepared.cfg ?? resolvedCfg;
    const built = adapter.buildCommand(effectiveCfg, folder);
    const command = built.command;
    // Adapters can prepend args via prepared.extraArgs — used by the
    // Spring Boot debug path to inject `--init-script <path>` so JDWP
    // applies only to the bootRun JVM, never to the gradle daemon.
    const args = [...(prepared.extraArgs ?? []), ...built.args];
    log.debug(`buildCommand: ${command} ${args.join(' ')}`);
    log.debug(`cwd: ${cwd}`);
    // Load .env files freshly per launch — the spec is that values are
    // never baked into the saved config, so editing the file is enough
    // to change behaviour. Missing files warn and continue.
    const envFiles = (resolvedCfg.envFiles ?? []) as string[];
    let envFromFiles: Record<string, string> = {};
    if (envFiles.length > 0) {
      const { merged, files } = await loadEnvFiles(envFiles, folder.uri.fsPath);
      envFromFiles = merged;
      const missing = files.filter(f => !f.loaded).map(f => f.path);
      if (missing.length) {
        log.warn(`Run "${cfg.name}": .env file(s) missing/unreadable: ${missing.join(', ')}`);
      }
      const loadedCount = files.filter(f => f.loaded).length;
      const varCount = Object.keys(envFromFiles).length;
      log.debug(
        `Run "${cfg.name}": loaded ${loadedCount}/${files.length} .env file(s), ${varCount} merged var(s)`,
      );
    }
    // Merge precedence (last wins):
    //   1. process.env  — host environment baseline.
    //   2. envFromFiles — .env files in user-declared order; later files
    //                     in the array overwrote earlier ones during load.
    //   3. cfg.env      — explicitly typed env table on the form. Form
    //                     wins over .env so a user override always sticks.
    //   4. prepared.env — adapter additions (e.g. Tomcat CATALINA_BASE).
    //                     Last because adapter knows what it's doing and
    //                     occasionally needs to overwrite user input
    //                     (e.g. JAVA_HOME for forked compilers).
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      ...envFromFiles,
      ...resolvedCfg.env,
      ...(prepared.env ?? {}),
    };

    // Some runtimes need the full PTY instead of our observe-but-can't-type
    // pseudoterminal:
    //  - Quarkus dev mode has an interactive menu (r to reload, s for tests).
    //  - Custom commands with `interactive: true` may prompt / read stdin.
    // ShellExecution hands the terminal to VS Code, at the cost of losing
    // our output prettifier and log-pattern scanning.
    const useShellExecution =
      resolvedCfg.type === 'quarkus' ||
      (resolvedCfg.type === 'custom-command' && resolvedCfg.typeOptions.interactive);

    const readyPatterns = useShellExecution ? [] : readyPatternsFor(resolvedCfg);
    const failPatterns = useShellExecution ? [] : failurePatternsFor(resolvedCfg);
    const rebuildPatterns = useShellExecution ? [] : rebuildPatternsFor(resolvedCfg);
    const markReady = (reason: string) => {
      if (!this.running.has(cfg.id)) return;
      // A ready match clears both the failed and rebuilding flags. This is
      // the happy path after a successful dev-server rebuild — we want the
      // tree to flip straight from yellow to green.
      const wasFailed = this.failed.delete(cfg.id);
      const wasRebuilding = this.rebuilding.delete(cfg.id);
      if (!this.started.has(cfg.id) || wasFailed || wasRebuilding) {
        this.started.add(cfg.id);
        this.emitter.fire(cfg.id);
        log.info(`Ready: ${cfg.name} — ${reason}`);
      }
    };
    const markFailed = (reason: string) => {
      if (!this.running.has(cfg.id)) return;
      const wasRebuilding = this.rebuilding.delete(cfg.id);
      if (!this.failed.has(cfg.id) || wasRebuilding) {
        this.failed.add(cfg.id);
        // Clear started in case a ready signal fired just before the failure.
        this.started.delete(cfg.id);
        this.emitter.fire(cfg.id);
        log.warn(`Failed: ${cfg.name} — ${reason}`);
      }
    };
    const markRebuilding = (reason: string) => {
      if (!this.running.has(cfg.id)) return;
      // Only flip from started / failed. If we're still in the initial
      // starting phase (neither set), let the first ready/failure pattern
      // decide — a "Compiling…" line before the very first "compiled" is
      // expected and shouldn't flip us to yellow.
      if (!this.started.has(cfg.id) && !this.failed.has(cfg.id)) return;
      if (this.rebuilding.has(cfg.id)) return;
      this.rebuilding.add(cfg.id);
      // Rebuilding supersedes started/failed visually; clear both so the
      // tree renders the yellow spinner.
      this.started.delete(cfg.id);
      this.failed.delete(cfg.id);
      this.emitter.fire(cfg.id);
      log.info(`Rebuilding: ${cfg.name} — ${reason}`);
    };

    // Format a RegExp as the literal we embed in the log. `RegExp.toString()`
    // yields the familiar /pattern/flags form.
    const patternLabel = (re: RegExp) => re.toString();

    // ShellExecution insists on Record<string, string>; filter out the
    // undefined entries that come from inheriting process.env.
    const strictEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (typeof v === 'string') strictEnv[k] = v;
    }

    // Shared ref the CustomExecution callback writes its RunTerminal
    // into. We can't capture a plain `let` because by the time stop()
    // looks at the Entry, the callback may not have fired yet — the
    // ref-holder gives both sides a stable object to coordinate
    // through.
    const terminalRef: { current?: RunTerminal } = {};

    const execution2: vscode.ShellExecution | vscode.CustomExecution = useShellExecution
      ? new vscode.ShellExecution(command, args, { cwd, env: strictEnv })
      : new vscode.CustomExecution(async () => {
          const runTerminal = new RunTerminal({
          command,
          args,
          cwd,
          env: mergedEnv,
          // When the user explicitly UNchecked "Close terminal as
          // soon as process ends" (closeTerminalOnExit === false),
          // the terminal lingers after the process ends so logs
          // survive the stop button. Default is close-immediately
          // (field undefined or true).
          keepOpenOnExit: resolvedCfg.closeTerminalOnExit === false,
          prettifier: makePrettifier(resolvedCfg, { cwd }),
          onOutput: chunk => {
            // Priority: failure > ready > rebuild. If a chunk happens to
            // contain both (e.g. a dev server prints an error line right
            // before it announces a new compile), the most-decisive signal
            // wins. Ready beats rebuild because a "compiled successfully"
            // line should flip us green even if the same chunk carries
            // a "Compiling…" line from earlier.
            const failHit = failPatterns.length ? firstMatch(chunk, failPatterns) : null;
            if (failHit) {
              markFailed(`matched failure pattern ${patternLabel(failHit)}`);
              return;
            }
            const readyHit = readyPatterns.length ? firstMatch(chunk, readyPatterns) : null;
            if (readyHit) {
              markReady(`matched readiness pattern ${patternLabel(readyHit)}`);
              return;
            }
            const rebuildHit = rebuildPatterns.length ? firstMatch(chunk, rebuildPatterns) : null;
            if (rebuildHit) {
              markRebuilding(`matched rebuild pattern ${patternLabel(rebuildHit)}`);
            }
          },
          onExit: () => {
            // Handled by onDidEndTask listener; no-op here.
          },
        });
        terminalRef.current = runTerminal;
        return runTerminal;
        });

    const task = new vscode.Task(
      { type: 'run-config', configId: cfg.id } as any,
      folder,
      cfg.name,
      'Run Configurations',
      execution2,
      [],
    );

    try {
      const execution = await vscode.tasks.executeTask(task);
      const entry: Entry = {
        execution,
        configId: cfg.id,
        // Only thread the ref through for CustomExecution configs —
        // ShellExecution doesn't own a RunTerminal.
        terminalRef: useShellExecution ? undefined : terminalRef,
        closeTerminalOnExit: resolvedCfg.closeTerminalOnExit,
      };

      // Quarkus is a long-running dev server: mark it started optimistically
      // after 15s since we can't observe stdout. Custom commands (even the
      // interactive ones) tend to be scripts that exit on their own; no
      // grace timer there — the tree returns to idle when the process ends.
      if (resolvedCfg.type === 'quarkus') {
        entry.readyTimer = setTimeout(() => {
          markReady('elapsed grace period');
        }, 15_000);
      }

      // Opt-in continuous rebuild: spawns a parallel `./gradlew -t :mod:classes`
      // task alongside the main run. DevTools (if present on the classpath)
      // triggers a warm restart each time classes change.
      if (resolvedCfg.type === 'spring-boot' && shouldStartWatcher(resolvedCfg)) {
        try {
          entry.watcher = await startRebuildWatcher(resolvedCfg, folder);
        } catch (e) {
          log.warn(`Rebuild watcher failed to start for ${cfg.name}: ${(e as Error).message}`);
        }
      }

      this.running.set(cfg.id, entry);
      this.emitter.fire(cfg.id);
      log.info(`Started: ${cfg.name} (${command} ${args.join(' ')})`);
      return execution;
    } catch (e) {
      log.error(`Failed to start ${cfg.name}`, e);
      vscode.window.showErrorMessage(`Failed to start "${cfg.name}": ${(e as Error).message}`);
      return undefined;
    }
  }

  // Performs an http-request config in-process: HttpRequestRunner does
  // the actual work; we own the tree-state lifecycle (running spinner →
  // 3s flash → idle). Note we deliberately do NOT add the config to
  // `this.running` past the await — http-request isn't a long-lived
  // process, so the running state is purely transient for the duration
  // of the request. The 3-second post-flash is its own separate state
  // visualized through `httpFlash`.
  private async runHttpRequest(
    cfg: Extract<RunConfig, { type: 'http-request' }>,
    folder: vscode.WorkspaceFolder,
  ): Promise<void> {
    // Mark "preparing" so the tree shows a spinner while we wait. We
    // don't push into `this.running` because there's no long-lived
    // execution to track — the request finishes in milliseconds (or
    // up to timeoutMs) and we're done.
    this.preparing.add(cfg.id);
    this.httpFlash.delete(cfg.id);
    this.emitter.fire(cfg.id);
    try {
      const channel = initLogger();
      const result = await runHttpRequest(cfg, folder, channel);
      this.preparing.delete(cfg.id);
      // Map outcome → flash class.
      const flash: 'success' | 'warn' | 'error' =
        result.outcome.kind === 'success' ? 'success'
        : result.outcome.kind === 'client-error' ? 'warn'
        : 'error';
      this.httpFlash.set(cfg.id, flash);
      this.emitter.fire(cfg.id);
      // Auto-clear the flash after 3 seconds. Re-running the config
      // before then immediately overrides the flash via the prep path
      // above, so users don't see stale state.
      setTimeout(() => {
        // Only clear if still set to the same flash we wrote — a
        // newer run would have replaced it already.
        if (this.httpFlash.get(cfg.id) === flash) {
          this.httpFlash.delete(cfg.id);
          this.emitter.fire(cfg.id);
        }
      }, 3000);
    } catch (e) {
      this.preparing.delete(cfg.id);
      this.httpFlash.set(cfg.id, 'error');
      this.emitter.fire(cfg.id);
      log.error(`http-request "${cfg.name}"`, e);
      setTimeout(() => {
        if (this.httpFlash.get(cfg.id) === 'error') {
          this.httpFlash.delete(cfg.id);
          this.emitter.fire(cfg.id);
        }
      }, 3000);
    }
  }

  async stop(configId: string): Promise<void> {
    const entry = this.running.get(configId);
    if (!entry) return;
    // When the config went through our pseudoterminal AND the user
    // opted into linger mode, kill the child process directly via
    // RunTerminal instead of going through TaskExecution.terminate.
    // The latter makes VS Code call close() on the pseudoterminal
    // *before* our linger logic gets a chance to keep it alive — the
    // terminal would tear down with the child still warm in the
    // output buffer. Going direct lets the child exit naturally so
    // RunTerminal.finish() can flip into linger mode.
    // Only bypass VS Code's terminate path when the user opted into
    // linger (closeTerminalOnExit === false). The bypass exists so
    // RunTerminal can flip into lingering mode before VS Code tears
    // the pseudoterminal down — but for close-immediately configs
    // that bypass adds nothing and triggers VS Code's own
    // "press any key" prompt. Letting terminate() handle the
    // lifecycle there matches the pre-linger behavior exactly.
    const wantsLinger =
      entry.terminalRef?.current !== undefined &&
      entry.closeTerminalOnExit === false;
    if (wantsLinger) {
      entry.terminalRef!.current!.requestStop();
    } else {
      entry.execution.terminate();
    }
    entry.watcher?.terminate();
    if (entry.readyTimer) clearTimeout(entry.readyTimer);
    this.running.delete(configId);
    this.started.delete(configId);
    this.failed.delete(configId);
    this.rebuilding.delete(configId);
    this.emitter.fire(configId);
  }

  private handleEnd(execution: vscode.TaskExecution): void {
    for (const [id, entry] of this.running.entries()) {
      if (entry.execution === execution) {
        // Main task ended — also kill the watcher.
        entry.watcher?.terminate();
        if (entry.readyTimer) clearTimeout(entry.readyTimer);
        this.running.delete(id);
        this.started.delete(id);
        this.failed.delete(id);
        this.rebuilding.delete(id);
        this.emitter.fire(id);
        return;
      }
      // If only the watcher ended (e.g., user killed it manually), leave the
      // main task alone. The map entry's `watcher` reference goes stale;
      // dispose() will no-op when terminate is called on a dead execution.
      if (entry.watcher === execution) {
        entry.watcher = undefined;
        return;
      }
    }
  }

  dispose(): void {
    for (const entry of this.running.values()) {
      try { entry.execution.terminate(); } catch { /* ignore */ }
      try { entry.watcher?.terminate(); } catch { /* ignore */ }
      if (entry.readyTimer) clearTimeout(entry.readyTimer);
    }
    this.running.clear();
    this.started.clear();
    this.failed.clear();
    this.rebuilding.clear();
    this.taskEndSub.dispose();
    this.emitter.dispose();
  }
}

function buildCwd(cfg: RunConfig, folder: vscode.WorkspaceFolder): string {
  if (cfg.type === 'spring-boot') {
    const to = cfg.typeOptions;
    if ((to.launchMode === 'maven' || to.launchMode === 'gradle') && to.buildRoot) {
      return to.buildRoot;
    }
  }
  if (cfg.type === 'quarkus' && cfg.typeOptions.buildRoot) {
    return cfg.typeOptions.buildRoot;
  }
  if (cfg.type === 'java') {
    const to = cfg.typeOptions;
    if ((to.launchMode === 'maven' || to.launchMode === 'gradle') && to.buildRoot) {
      return to.buildRoot;
    }
  }
  return resolveProjectUri(folder, cfg.projectPath).fsPath;
}

function shouldStartWatcher(cfg: RunConfig): boolean {
  if (cfg.type !== 'spring-boot') return false;
  const to = cfg.typeOptions;
  if (!to.rebuildOnSave) return false;
  // Gradle is required for the watcher (no equivalent in Maven without extra
  // plugins). Applies to gradle launchMode (bootRun inherits the classpath
  // directories Gradle rebuilds) and java-main (classpath also points at
  // build/classes/java/main directly).
  return to.launchMode === 'gradle' || to.launchMode === 'java-main';
}

async function startRebuildWatcher(
  cfg: Extract<RunConfig, { type: 'spring-boot' }>,
  folder: vscode.WorkspaceFolder,
): Promise<vscode.TaskExecution> {
  const to = cfg.typeOptions;
  const buildRoot = to.buildRoot || resolveProjectUri(folder, cfg.projectPath).fsPath;
  const projectPath = resolveProjectUri(folder, cfg.projectPath).fsPath;
  const modulePrefix = gradleModulePrefix(buildRoot, projectPath);
  // Run BOTH `classes` and `processResources` under -t. Reasons:
  //   1. `classes` alone misses resource files (application.properties,
  //      templates, static assets) — DevTools then never sees those
  //      changes because Gradle never re-copies them to
  //      build/resources/main.
  //   2. In multi-module projects, adding `:mod:classes` only recompiles
  //      THIS module; when the app depends on sibling modules the user
  //      may need to broaden further. Point that out in the help text,
  //      but keep the default narrow to avoid slow rebuilds.
  //
  // Gradle accepts multiple tasks in a single -t invocation — it runs them
  // both in continuous mode and re-runs whichever one has dirty inputs.
  const classesTask = modulePrefix ? `${modulePrefix}:classes` : 'classes';
  const resourcesTask = modulePrefix ? `${modulePrefix}:processResources` : 'processResources';

  const gradleBinary =
    to.gradleCommand === './gradlew'
      ? './gradlew'
      : to.gradlePath
      ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle`
      : 'gradle';

  // `-t` = --continuous; Gradle re-runs the named tasks whenever their
  // inputs change. --console=plain keeps the watcher's output readable
  // in the integrated terminal (no progress bars competing with the
  // app's stdout in the adjacent terminal).
  const args = ['-t', '--console=plain', classesTask, resourcesTask];
  const shell = new vscode.ShellExecution(gradleBinary, args, {
    cwd: buildRoot,
    env: to.jdkPath ? { JAVA_HOME: to.jdkPath } : undefined,
  });

  const vsTask = new vscode.Task(
    { type: 'run-config-watcher', configId: cfg.id } as any,
    folder,
    `${cfg.name} (watch)`,
    'Run Configurations',
    shell,
    [],
  );
  log.info(`Started rebuild watcher: ${gradleBinary} ${args.join(' ')} (cwd ${buildRoot})`);
  return vscode.tasks.executeTask(vsTask);
}
