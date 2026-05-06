import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { Inbound, Outbound } from '../shared/protocol';
import type { FormSchema } from '../shared/formSchema';
import type { RunConfigService } from '../services/RunConfigService';
import type { RuntimeAdapter, StreamingPatch } from '../adapters/RuntimeAdapter';
import { log } from '../utils/logger';
import { relativeFromWorkspace, resolveProjectUri } from '../utils/paths';
import { recomputeClasspath, RecomputeTimeoutError } from '../adapters/spring-boot/recomputeClasspath';
import { detectSpringBootPort, detectQuarkusPort, safeDetect } from '../services/detectProjectPort';
import { makeRunContext, resolveConfig } from '../utils/resolveVars';
import { discoverGradleTasks } from '../adapters/gradle-task/discoverGradleTasks';
import { discoverMavenGoals } from '../adapters/maven-goal/discoverMavenGoals';
import { validateBuildProjectPath } from '../utils/validateBuildProjectPath';
import { RunConfigSchema } from '../shared/schema';
import type { DockerService } from '../services/DockerService';
import { BuildToolSettingsService } from '../services/BuildToolSettingsService';
import { loadEnvFiles } from '../services/EnvFileLoader';
import { JdkInstallerService, type JdkPackage, CancelledError, ChecksumUnavailableError, jdkInstallDirName } from '../services/JdkInstallerService';
import { TomcatInstallerService, type TomcatPackage } from '../services/TomcatInstallerService';
import { MavenInstallerService, type MavenPackage } from '../services/MavenInstallerService';
import { GradleInstallerService, type GradleVersion as GradleVersionPkg } from '../services/GradleInstallerService';
import { probeJdkVersion } from '../adapters/spring-boot/detectJdks';

interface OpenArgs {
  mode: 'create' | 'edit';
  folderKey: string;
  folder: vscode.WorkspaceFolder;
  existing?: RunConfig;
  seedDefaults?: Partial<RunConfig>;
  schema: FormSchema;
  // Adapter handling this panel, independent of streaming. Needed so the
  // `loadTasks`/`loadGoals` action buttons can rebuild the form schema after
  // populating options. Always set; required.
  adapter: RuntimeAdapter;
  // Optional: field-level errors to surface on first render (red border +
  // message). Used by the Fix flow to highlight which fields made the
  // invalid entry fail schema validation. Cleared as the user edits.
  initialFieldErrors?: Array<{ fieldKey: string; message: string }>;
  // When set, the webview is opened immediately and detection runs async;
  // each StreamingPatch posts a schemaUpdate message + (in create mode) fills
  // in any blank default fields.
  streaming?: {
    adapter: RuntimeAdapter;
    initialContext: Record<string, unknown>;
    pending: string[];          // field keys showing spinners on first paint
  };
  // Optional DockerService used to refresh / inspect containers from the
  // Docker form. Absent for non-Docker flows (no-op for those).
  docker?: DockerService;
  // Candidate list for the shared "Depends on" field. Assembled by the
  // caller (extension.ts) from the current run-configs in the folder, the
  // native launch configs, and workspace-sourced native tasks — minus the
  // config currently being edited. Kept out of the adapter so the adapter
  // doesn't need to know about other services.
  dependencyOptions?: Array<{ value: string; label: string; group?: string; description?: string }>;
}

export class EditorPanel {
  private static instance: EditorPanel | undefined;

  private panel: vscode.WebviewPanel;
  private args: OpenArgs;
  // Shared across loadBuildToolSettings calls. Stateless, but hang on to
  // one instance to avoid allocating per message.
  private readonly settingsSvc = new BuildToolSettingsService();
  // JDK installer — used by the download-jdk dialog. Stateless across
  // panels in practice, but kept per-panel so a cancel from one editor
  // can't accidentally abort another's install.
  private readonly jdkInstaller = new JdkInstallerService();
  // Cached package lists for the download dialog so flipping the vendor
  // dropdown doesn't re-hit the network. Cleared on dispose.
  private readonly jdkPackages = new Map<string, JdkPackage[]>();
  // Tomcat installer + per-major cache (same lifetime model as JDK).
  private readonly tomcatInstaller = new TomcatInstallerService();
  private readonly tomcatPackages = new Map<number, TomcatPackage[]>();
  private readonly mavenInstaller = new MavenInstallerService();
  private readonly mavenPackages = new Map<number, MavenPackage[]>();
  private readonly gradleInstaller = new GradleInstallerService();
  private gradleVersions: GradleVersionPkg[] | undefined;
  // Cumulative detection context for the currently-open form. Starts from
  // args.streaming?.initialContext, grows as streaming patches arrive, and
  // is mutated by action handlers (loadTasks / loadGoals) so subsequent
  // schema rebuilds keep their added options.
  private context: Record<string, unknown> = {};

  private constructor(
    args: OpenArgs,
    private readonly ctx: vscode.ExtensionContext,
    private readonly svc: RunConfigService,
  ) {
    this.args = args;
    this.panel = vscode.window.createWebviewPanel(
      'runConfigEditor',
      args.mode === 'create' ? 'New Run Configuration' : `Edit: ${args.existing?.name ?? ''}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview')],
      },
    );
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg as Outbound));
    this.panel.onDidDispose(() => { if (EditorPanel.instance === this) EditorPanel.instance = undefined; });
  }

  static open(
    args: OpenArgs,
    ctx: vscode.ExtensionContext,
    svc: RunConfigService,
  ): EditorPanel {
    if (EditorPanel.instance) {
      EditorPanel.instance.args = args;
      // Reset per-form context so options from the previous edit don't
      // leak into the next one (loaded Gradle tasks, Maven goals, etc.).
      EditorPanel.instance.context = {};
      EditorPanel.instance.panel.title = args.mode === 'create' ? 'New Run Configuration' : `Edit: ${args.existing?.name ?? ''}`;
      EditorPanel.instance.panel.reveal(vscode.ViewColumn.Active);
      EditorPanel.instance.sendInit();
      return EditorPanel.instance;
    }
    EditorPanel.instance = new EditorPanel(args, ctx, svc);
    return EditorPanel.instance;
  }

  private sendInit(): void {
    // Seed the persistent form context with the dependency candidates so
    // every subsequent getFormSchema call (initial + streaming rebuilds +
    // loadTasks/loadGoals) sees the same list. The caller assembles it
    // once — stale entries between clicks aren't worth the churn.
    if (this.args.dependencyOptions) {
      this.context.dependencyOptions = this.args.dependencyOptions;
    }

    const seed = (this.args.seedDefaults ?? {}) as Record<string, unknown>;
    const type = ((seed.type as string | undefined) ?? this.args.existing?.type ?? 'npm') as
      | 'npm'
      | 'spring-boot'
      | 'tomcat'
      | 'quarkus'
      | 'java'
      | 'maven-goal'
      | 'gradle-task'
      | 'custom-command'
      | 'docker';

    const baseCommon = {
      name: '',
      projectPath: '',
      workspaceFolder: this.args.folder.name,
      env: {},
      programArgs: '',
      vmArgs: '',
    };

    // For Spring Boot / Quarkus in streaming mode we deliberately leave
    // build-tool fields unset so detection can populate them. Pre-filling
    // 'maven' here would survive mergeBlanks (it's truthy) and poison the
    // recompute path when the project is actually Gradle.
    const isStreaming = Boolean(this.args.streaming);
    let typeDefaults: Record<string, unknown>;
    if (type === 'npm') {
      typeDefaults = { scriptName: '', packageManager: 'npm' };
    } else if (type === 'tomcat') {
      // Seed only the non-detected fields. tomcatHome / jdkPath / artifactPath
      // all come from streaming detection and pre-filling them would poison
      // mergeBlanks the same way buildTool did for Spring Boot.
      typeDefaults = {
        httpPort: 8080,
        applicationContext: '/',
        artifactKind: 'war',
        buildTool: 'gradle',
        gradleCommand: './gradlew',
        reloadable: true,
        rebuildOnSave: false,
      };
    } else if (type === 'quarkus') {
      // Same detection-friendly defaults as spring-boot: leave buildTool
      // unset in streaming mode so detection can supply it.
      typeDefaults = isStreaming
        ? { profile: '', debugPort: 5005, colorOutput: true }
        : { buildTool: 'maven', profile: '', debugPort: 5005, colorOutput: true };
    } else if (type === 'java') {
      // Same mergeBlanks rationale as spring-boot/quarkus: omit buildTool in
      // streaming mode so detection picks it up cleanly.
      typeDefaults = isStreaming
        ? { debugPort: 5005, colorOutput: true }
        : { buildTool: 'maven', debugPort: 5005, colorOutput: true };
    } else if (type === 'maven-goal') {
      typeDefaults = { goal: '', colorOutput: true };
    } else if (type === 'gradle-task') {
      typeDefaults = isStreaming
        ? { task: '', colorOutput: true }
        : { task: '', gradleCommand: './gradlew', colorOutput: true };
    } else if (type === 'custom-command') {
      typeDefaults = { command: '', cwd: '', shell: 'default', interactive: false, colorOutput: true };
    } else {
      typeDefaults = isStreaming ? { profiles: '' } : { buildTool: 'maven', profiles: '' };
    }

    const seedTypeOptions = (seed.typeOptions as Record<string, unknown> | undefined) ?? {};

    const config: Record<string, unknown> = this.args.existing
      ? { ...this.args.existing }
      : {
          ...baseCommon,
          ...seed,
          type,
          // Merge typeOptions so detection can contribute without losing other fields.
          typeOptions: { ...typeDefaults, ...seedTypeOptions },
        };

    const init: Inbound = {
      cmd: 'init',
      mode: this.args.mode,
      config: config as Partial<RunConfig>,
      schema: this.args.schema,
      pending: this.args.streaming?.pending,
      workspaceFolderPath: this.args.folder.uri.fsPath,
    };
    this.panel.webview.postMessage(init);

    // Pre-populated field errors (Fix-invalid flow) — send immediately
    // after init so the webview's listener processes them on the same
    // frame as the initial render.
    if (this.args.initialFieldErrors && this.args.initialFieldErrors.length > 0) {
      this.panel.webview.postMessage({
        cmd: 'fieldErrors',
        errors: this.args.initialFieldErrors,
      } satisfies Inbound);
    }

    // If streaming detection is enabled, kick it off now (non-blocking).
    if (this.args.streaming && this.args.mode === 'create') {
      this.runStreamingDetection().catch(e => log.error('streaming detection', e));
    }
  }

  private async runStreamingDetection(): Promise<void> {
    const s = this.args.streaming;
    if (!s || !s.adapter.detectStreaming) return;
    // Seed the persistent context from the streaming initial context —
    // action handlers (loadTasks / loadGoals) will later grow it.
    this.context = { ...s.initialContext };
    const pending = new Set<string>(s.pending);

    const emit = (patch: StreamingPatch) => {
      Object.assign(this.context, patch.contextPatch);
      for (const k of patch.resolved ?? []) pending.delete(k);

      const schema = s.adapter.getFormSchema(this.context);
      const msg: Inbound = {
        cmd: 'schemaUpdate',
        schema,
        pending: Array.from(pending),
      };
      this.panel.webview.postMessage(msg);

      // In create mode, also seed any blank default fields — users see the
      // detected main class / JDK / etc. populate as soon as we find them.
      if (patch.defaultsPatch) {
        const configPatch: Inbound = { cmd: 'configPatch', patch: patch.defaultsPatch };
        this.panel.webview.postMessage(configPatch);
      }
    };

    const projectUri = this.args.seedDefaults?.projectPath
      ? vscode.Uri.joinPath(this.args.folder.uri, this.args.seedDefaults.projectPath)
      : this.args.folder.uri;
    await s.adapter.detectStreaming(projectUri, emit);
  }

  private async handleMessage(msg: Outbound): Promise<void> {
    switch (msg.cmd) {
      case 'ready':
        this.sendInit();
        return;
      case 'cancel':
        this.panel.dispose();
        return;
      case 'pickFolder': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: this.args.folder.uri,
        });
        if (!picked || picked.length === 0) return;
        const rel = relativeFromWorkspace(this.args.folder, picked[0]);
        log.debug(`pickFolder picked: ${rel}`);
        const reply: Inbound = { cmd: 'folderPicked', path: rel };
        this.panel.webview.postMessage(reply);
        return;
      }
      case 'loadTasks': {
        // Action handler for the gradle-task / maven-goal form's "Load
        // tasks" / "Load phases & plugin prefixes" button. Runs discovery,
        // stores results in the persistent context, and re-emits the
        // schema so the selectOrCustom widget picks up the new options.
        //
        // We surface progress through three channels:
        //   1. Status-bar withProgress (bottom-left, "Loading Gradle
        //      tasks…") for ambient feedback.
        //   2. Info-level log line in the Output channel at each step —
        //      user opening "Output → Run Configurations" sees exactly
        //      what the extension is doing.
        //   3. showInformationMessage toast on success, showWarningMessage
        //      on empty result, showErrorMessage on failure. User never has
        //      to wonder whether the click did anything.
        const cfg = msg.config;
        const label = cfg.type === 'gradle-task' ? 'Gradle tasks' : 'Maven phases & plugin goals';
        log.info(`Load ${label}: "${cfg.name || '(unnamed)'}" — starting`);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: `Loading ${label}…`,
          },
          async () => {
            try {
              if (cfg.type === 'gradle-task') {
                const to = cfg.typeOptions;
                const cwd = to.buildRoot || resolveProjectUri(this.args.folder, cfg.projectPath).fsPath;
                const binary = to.gradleCommand === './gradlew'
                  ? './gradlew'
                  : to.gradlePath ? `${to.gradlePath.replace(/[/\\]$/, '')}/bin/gradle` : 'gradle';
                const env = to.jdkPath ? { JAVA_HOME: to.jdkPath } : undefined;
                log.info(`Load ${label}: running ${binary} tasks --all (cwd=${cwd}) — may take up to 60s on a cold daemon`);
                const tasks = await discoverGradleTasks({ cwd, gradleBinary: binary, env });
                log.info(`Load ${label}: discovered ${tasks.length} task(s)`);
                this.context.loadedTasks = tasks;
                const schema = this.args.adapter.getFormSchema(this.context);
                this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
                if (tasks.length === 0) {
                  vscode.window.showWarningMessage(
                    `No Gradle tasks returned. Check "Output → Run Configurations" for details — common causes: wrong build root, Gradle daemon timeout, or the project has no runnable tasks.`,
                  );
                  this.panel.webview.postMessage({
                    cmd: 'error',
                    message: 'No tasks returned from Gradle. See the Output channel.',
                  } satisfies Inbound);
                } else {
                  vscode.window.showInformationMessage(
                    `Loaded ${tasks.length} Gradle task${tasks.length === 1 ? '' : 's'}.`,
                  );
                }
              } else if (cfg.type === 'maven-goal') {
                const to = cfg.typeOptions;
                const projectRoot = to.buildRoot
                  ? vscode.Uri.file(to.buildRoot)
                  : resolveProjectUri(this.args.folder, cfg.projectPath);
                const mavenBinary = to.mavenPath
                  ? `${to.mavenPath.replace(/[/\\]$/, '')}/bin/mvn`
                  : 'mvn';
                log.info(`Load ${label}: parsing pom.xml at ${projectRoot.fsPath} and probing plugins via ${mavenBinary} help:describe`);
                const goals = await discoverMavenGoals({
                  folder: projectRoot,
                  mavenBinary,
                  javaHome: to.jdkPath || undefined,
                });
                log.info(`Load ${label}: ${goals.length} entries (lifecycle phases + plugin goals)`);
                this.context.loadedGoals = goals;
                const schema = this.args.adapter.getFormSchema(this.context);
                this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
                vscode.window.showInformationMessage(
                  `Loaded ${goals.length} Maven entr${goals.length === 1 ? 'y' : 'ies'} (lifecycle phases + plugin goals).`,
                );
              } else {
                // Shouldn't happen — the action button is only defined on
                // those two form schemas. Make sure the webview's busy state
                // still clears by emitting a schemaUpdate with whatever we
                // have.
                log.warn(`Load ${label}: unexpected config type ${cfg.type}`);
                this.panel.webview.postMessage({
                  cmd: 'schemaUpdate',
                  schema: this.args.adapter.getFormSchema(this.context),
                } satisfies Inbound);
              }
            } catch (e) {
              const msgText = (e as Error).message;
              log.error(`Load ${label} failed`, e);
              vscode.window.showErrorMessage(`Loading ${label} failed: ${msgText}`);
              this.panel.webview.postMessage({
                cmd: 'error',
                message: `Load failed: ${msgText}`,
              } satisfies Inbound);
              // Ensure the webview's busy state clears even on the error
              // path — schemaUpdate + error together cover both channels.
              this.panel.webview.postMessage({
                cmd: 'schemaUpdate',
                schema: this.args.adapter.getFormSchema(this.context),
              } satisfies Inbound);
            }
          },
        );
        return;
      }
      case 'recomputeClasspath': {
        if (msg.config.type !== 'spring-boot') return;
        const to = msg.config.typeOptions;
        log.info(`Recompute classpath: "${msg.config.name}" (${to.buildTool})`);
        try {
          const projectRoot = resolveProjectUri(this.args.folder, msg.config.projectPath);
          const buildRoot = to.buildRoot ? vscode.Uri.file(to.buildRoot) : projectRoot;
          const cp = await recomputeClasspath({
            projectRoot,
            buildRoot,
            buildTool: to.buildTool,
            gradleCommand: to.gradleCommand,
            gradlePath: to.gradlePath,
            mavenPath: to.mavenPath,
            jdkPath: to.jdkPath,
          });
          const reply: Inbound = { cmd: 'classpathComputed', classpath: cp };
          this.panel.webview.postMessage(reply);
        } catch (e) {
          // Timeouts get a dedicated message. The Gradle daemon takes 60-120s
          // on first run of a project; a retry with the daemon warm almost
          // always completes in single-digit seconds. We toast the hint so
          // it's visible even if the user has scrolled the form; the banner
          // in the form itself carries the same wording for later reference.
          if (e instanceof RecomputeTimeoutError) {
            const hint =
              `Recompute timed out. This is almost always the Gradle/Maven ` +
              `daemon warming up on first run — click "Recompute classpath" ` +
              `again; the retry normally finishes in a few seconds.`;
            vscode.window.showWarningMessage(hint, 'Show details').then(choice => {
              if (choice === 'Show details') log.show();
            });
            this.panel.webview.postMessage({
              cmd: 'error',
              message: `Classpath recompute timed out — click Recompute again. ${e.partialStderr.trim() ? 'See "Output → Run Configurations" for the build tool\'s last output.' : ''}`.trim(),
            } satisfies Inbound);
            log.warn(`recomputeClasspath timed out after 90s. Stderr tail:\n${e.partialStderr.slice(-2000)}`);
          } else {
            this.panel.webview.postMessage({
              cmd: 'error',
              message: `Classpath recompute failed: ${(e as Error).message}`,
            } satisfies Inbound);
            log.error('recomputeClasspath', e);
          }
        }
        return;
      }
      case 'inspectContainer': {
        // Docker form: user picked a container (or one was restored from disk
        // on init). Fetch inspect metadata, stash it in the persistent
        // context, and re-emit the schema so the info panel shows details.
        if (!this.args.docker) return;
        log.debug(`Docker inspect: ${msg.containerId}`);
        try {
          const info = await this.args.docker.inspect(msg.containerId);
          this.context.selectedContainerId = msg.containerId;
          this.context.selectedContainerInfo = info ?? undefined;
          // Keep the container summary list fresh too — inspect doesn't
          // trigger a poll on its own.
          this.context.containers = this.args.docker.list();
          this.context.dockerAvailable = this.args.docker.isAvailable();
          this.context.dockerError = this.args.docker.listError();
          const schema = this.args.adapter.getFormSchema(this.context);
          this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
        } catch (e) {
          log.warn(`inspectContainer failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'detectPort': {
        // Fired by the webview when a field that influences port detection
        // changes (Spring Boot / Quarkus profiles). We re-read the relevant
        // application file for the new profile and reply with a configPatch
        // that sets `port` — mergeBlanks on the webview side means we never
        // overwrite a port the user typed manually.
        const cfg = msg.config;
        try {
          const projectRoot = resolveProjectUri(this.args.folder, cfg.projectPath ?? '');
          let port: number | null = null;
          if (cfg.type === 'spring-boot') {
            port = await safeDetect('spring-boot:port', () =>
              detectSpringBootPort(projectRoot, cfg.typeOptions.profiles));
          } else if (cfg.type === 'quarkus') {
            port = await safeDetect('quarkus:port', () =>
              detectQuarkusPort(projectRoot, cfg.typeOptions.profile));
          }
          if (port) {
            log.debug(`Port re-detect: ${cfg.type} profile=${(cfg as any).typeOptions.profiles ?? (cfg as any).typeOptions.profile} → ${port}`);
            this.panel.webview.postMessage({
              cmd: 'configPatch',
              patch: { port },
              // Authoritative — the picked profile declares this port, so
              // overwrite any previous value (which came from a different
              // profile, or from an earlier detection).
              force: true,
            } satisfies Inbound);
          }
        } catch (e) {
          log.warn(`detectPort failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'loadBuildToolSettings': {
        // Fired by the webview whenever the form's buildTool (or the
        // project path, for Gradle's project-root fallback) changes. We
        // read the active settings file and reply with proxy host/port so
        // the panel at the bottom of the form stays in sync.
        log.debug(`loadBuildToolSettings: ${msg.buildTool} projectPath="${msg.projectPath}"`);
        try {
          const projectRoot = resolveProjectUri(this.args.folder, msg.projectPath ?? '');
          const info = await this.settingsSvc.load(msg.buildTool, projectRoot, {
            mavenPath: msg.mavenPath,
            gradlePath: msg.gradlePath,
          });
          this.panel.webview.postMessage({
            cmd: 'buildToolSettings',
            buildTool: info.buildTool,
            activeFilePath: info.activeFilePath,
            ...(info.sourceLabel ? { sourceLabel: info.sourceLabel } : {}),
            proxyHost: info.proxyHost,
            proxyPort: info.proxyPort,
            nonProxyHosts: info.nonProxyHosts,
            overriddenFiles: info.overriddenFiles,
            ...(info.note ? { note: info.note } : {}),
            searchedPaths: info.searchedPaths,
          } satisfies Inbound);
        } catch (e) {
          // Informational panel — don't surface errors as banners; just log.
          log.warn(`loadBuildToolSettings failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'buildToolSettings',
            buildTool: msg.buildTool,
            proxyHost: null,
            proxyPort: null,
            nonProxyHosts: null,
            overriddenFiles: [],
            searchedPaths: [],
            note: `Could not read settings file: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'openSettingsFile': {
        // Open the file in a side-by-side editor so the form panel stays
        // visible. Use showTextDocument with ViewColumn.Beside — matches
        // how the launch/task content provider opens read-only JSON.
        log.debug(`openSettingsFile: ${msg.filePath}`);
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.filePath));
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        } catch (e) {
          vscode.window.showErrorMessage(`Could not open ${msg.filePath}: ${(e as Error).message}`);
          log.warn(`openSettingsFile failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'pickEnvFile': {
        // File picker scoped to .env files. We allow any extension though
        // — many projects use `.env.local`, `.env.dev`, etc.
        log.debug('pickEnvFile');
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          defaultUri: this.args.folder.uri,
          openLabel: 'Add .env file',
          // No `filters` — `.env` files don't carry a conventional
          // extension and applying a filter would hide them.
        });
        if (!picked || picked.length === 0) return;
        const rel = relativeFromWorkspace(this.args.folder, picked[0]);
        log.debug(`pickEnvFile picked: ${rel}`);
        this.panel.webview.postMessage({ cmd: 'envFilePicked', path: rel } satisfies Inbound);
        return;
      }
      case 'loadEnvFiles': {
        // Asked by the webview on init, when files are added/removed, and
        // also via "edit existing config" so the count pills always
        // reflect the current files. Errors per-file are surfaced via
        // the `error` tag on each entry — we never reject the whole batch.
        log.debug(`loadEnvFiles: ${msg.paths.length} path(s)`);
        const result = await loadEnvFiles(msg.paths, this.args.folder.uri.fsPath);
        this.panel.webview.postMessage({
          cmd: 'envFilesLoaded',
          files: result.files.map(f => ({
            path: f.path,
            loaded: f.loaded,
            count: Object.keys(f.variables).length,
            variables: f.variables,
            ...(f.error ? { error: f.error } : {}),
            ...(f.errorDetail ? { errorDetail: f.errorDetail } : {}),
          })),
        } satisfies Inbound);
        return;
      }
      case 'listJdkDownloads': {
        // Initial dialog open. Return distro list immediately and load the
        // first distro's packages so the version dropdown is populated on
        // first paint.
        log.debug('listJdkDownloads');
        try {
          const distros = this.jdkInstaller.listDistributions();
          const first = distros[0]?.apiName;
          const packagesByDistro: Record<string, ReturnType<JdkInstallerService['listPackages']> extends Promise<infer T> ? T : never> = {};
          if (first) {
            const pkgs = await this.jdkInstaller.listPackages(first);
            this.jdkPackages.set(first, pkgs);
            packagesByDistro[first] = pkgs;
          }
          this.panel.webview.postMessage({
            cmd: 'jdkDownloadList',
            distros: distros.map(d => ({ apiName: d.apiName, label: d.label })),
            packagesByDistro: Object.fromEntries(
              Object.entries(packagesByDistro).map(([k, v]) => [k, v.map(toPackageDto)]),
            ),
            installRoot: this.jdkInstaller.getInstallRoot(),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listJdkDownloads failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'jdkDownloadError',
            message: `Could not load JDK distributions: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'listJdkPackages': {
        // Vendor switched — fetch (or reuse cached) packages for the new
        // distro. Caching avoids repeat network hits when the user flips
        // back and forth.
        log.debug(`listJdkPackages: ${msg.distro}`);
        try {
          let pkgs = this.jdkPackages.get(msg.distro);
          if (!pkgs) {
            pkgs = await this.jdkInstaller.listPackages(msg.distro);
            this.jdkPackages.set(msg.distro, pkgs);
          }
          this.panel.webview.postMessage({
            cmd: 'jdkPackageList',
            distro: msg.distro,
            packages: pkgs.map(toPackageDto),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listJdkPackages failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'jdkDownloadError',
            message: `Could not load packages for ${msg.distro}: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'downloadJdk': {
        // Find the cached package, then run install with progress streaming
        // back to the webview. On success we add the new JDK to context.jdks
        // and re-emit the schema so the dropdown shows it; the dialog
        // selects it via the `jdkDownloadComplete` message.
        log.info(`downloadJdk: ${msg.distro}/${msg.packageId}`);
        const pkgs = this.jdkPackages.get(msg.distro) ?? [];
        const pkg = pkgs.find(p => p.id === msg.packageId);
        if (!pkg) {
          this.panel.webview.postMessage({
            cmd: 'jdkDownloadError',
            message: 'Package not found — please refresh the dialog.',
          } satisfies Inbound);
          return;
        }
        try {
          const result = await this.jdkInstaller.install(pkg, p => {
            this.panel.webview.postMessage({
              cmd: 'jdkDownloadProgress',
              state: p.state,
              fraction: p.fraction,
              ...(p.detail ? { detail: p.detail } : {}),
            } satisfies Inbound);
          }, { allowUnverified: msg.allowUnverified });
          // Probe version of the freshly-installed JDK so the dropdown
          // shows "Java 21.0.2 (Temurin)" right away. Best-effort.
          const probed = await probeJdkVersion(result.jdkHome).catch(() => ({}));
          // Push the new JDK into the persistent context and re-emit schema
          // so the form's dropdown picks it up. We append to existing entries
          // and dedupe by path.
          const existing = (this.context.jdks as Array<{ path: string; version?: string; vendor?: string }> | undefined) ?? [];
          const merged = existing.some(j => j.path === result.jdkHome)
            ? existing
            : [...existing, { path: result.jdkHome, ...probed }];
          this.context.jdks = merged;
          if (this.args.adapter) {
            const schema = this.args.adapter.getFormSchema(this.context);
            this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
          }
          this.panel.webview.postMessage({
            cmd: 'jdkDownloadComplete',
            jdkHome: result.jdkHome,
            versionLabel: result.versionLabel,
            distro: result.distro,
          } satisfies Inbound);
          // Patch the form so the new JDK is preselected, regardless of
          // whether the user already typed something in the field.
          this.panel.webview.postMessage({
            cmd: 'configPatch',
            patch: { typeOptions: { jdkPath: result.jdkHome } } as any,
            force: true,
          } satisfies Inbound);
        } catch (e) {
          const cancelled = e instanceof CancelledError;
          // Foojay didn't ship a SHA-256 for this package — bounce a
          // dedicated message so the dialog can surface a "Install anyway"
          // confirmation instead of a generic error. The user re-clicks
          // download with allowUnverified=true to proceed.
          if (e instanceof ChecksumUnavailableError) {
            log.warn(`downloadJdk: ${e.message} — awaiting user confirmation`);
            this.panel.webview.postMessage({
              cmd: 'jdkDownloadNeedsConfirmation',
              message: e.message,
            } satisfies Inbound);
            return;
          }
          log.warn(`downloadJdk: ${cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'jdkDownloadError',
            message: cancelled ? 'Download cancelled.' : (e as Error).message,
            ...(cancelled ? { cancelled: true } : {}),
          } satisfies Inbound);
        }
        return;
      }
      case 'cancelJdkDownload': {
        log.debug('cancelJdkDownload');
        this.jdkInstaller.cancel();
        return;
      }
      case 'listTomcatDownloads': {
        log.debug('listTomcatDownloads');
        try {
          const majors = await this.tomcatInstaller.listMajors();
          const first = majors[0]?.major;
          const versionsByMajor: Record<number, TomcatPackage[]> = {};
          if (first !== undefined) {
            const versions = await this.tomcatInstaller.listVersions(first);
            this.tomcatPackages.set(first, versions);
            versionsByMajor[first] = versions;
          }
          this.panel.webview.postMessage({
            cmd: 'tomcatDownloadList',
            majors,
            versionsByMajor: Object.fromEntries(
              Object.entries(versionsByMajor).map(([k, v]) => [k, v.map(toTomcatDto)]),
            ) as Record<number, ReturnType<typeof toTomcatDto>[]>,
            installRoot: this.tomcatInstaller.getInstallRoot(),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listTomcatDownloads failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'tomcatDownloadError',
            message: `Could not load Tomcat versions from Apache: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'listTomcatVersions': {
        log.debug(`listTomcatVersions: ${msg.major}`);
        try {
          let versions = this.tomcatPackages.get(msg.major);
          if (!versions) {
            versions = await this.tomcatInstaller.listVersions(msg.major);
            this.tomcatPackages.set(msg.major, versions);
          }
          this.panel.webview.postMessage({
            cmd: 'tomcatVersionList',
            major: msg.major,
            versions: versions.map(toTomcatDto),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listTomcatVersions failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'tomcatDownloadError',
            message: `Could not list Tomcat ${msg.major} versions: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'downloadTomcat': {
        log.info(`downloadTomcat: tomcat-${msg.major} v${msg.version}`);
        const versions = this.tomcatPackages.get(msg.major) ?? [];
        const pkg = versions.find(v => v.version === msg.version);
        if (!pkg) {
          this.panel.webview.postMessage({
            cmd: 'tomcatDownloadError',
            message: 'Tomcat version not found — please refresh the dialog.',
          } satisfies Inbound);
          return;
        }
        try {
          const result = await this.tomcatInstaller.install(pkg, p => {
            this.panel.webview.postMessage({
              cmd: 'tomcatDownloadProgress',
              state: p.state,
              fraction: p.fraction,
              ...(p.detail ? { detail: p.detail } : {}),
            } satisfies Inbound);
          });
          // Add the new install to context so the tomcatHome dropdown
          // picks it up, then preselect it on the form. Same dance as
          // the JDK install completion flow.
          const existing = (this.context.tomcatInstalls as string[] | undefined) ?? [];
          if (!existing.includes(result.tomcatHome)) {
            this.context.tomcatInstalls = [...existing, result.tomcatHome];
            if (this.args.adapter) {
              const schema = this.args.adapter.getFormSchema(this.context);
              this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
            }
          }
          this.panel.webview.postMessage({
            cmd: 'tomcatDownloadComplete',
            tomcatHome: result.tomcatHome,
            version: result.version,
            major: result.major,
          } satisfies Inbound);
          this.panel.webview.postMessage({
            cmd: 'configPatch',
            patch: { typeOptions: { tomcatHome: result.tomcatHome } } as any,
            force: true,
          } satisfies Inbound);
        } catch (e) {
          const cancelled = e instanceof CancelledError;
          log.warn(`downloadTomcat: ${cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'tomcatDownloadError',
            message: cancelled ? 'Download cancelled.' : (e as Error).message,
            ...(cancelled ? { cancelled: true } : {}),
          } satisfies Inbound);
        }
        return;
      }
      case 'cancelTomcatDownload': {
        log.debug('cancelTomcatDownload');
        this.tomcatInstaller.cancel();
        return;
      }
      case 'listMavenDownloads': {
        log.debug('listMavenDownloads');
        try {
          const majors = await this.mavenInstaller.listMajors();
          const first = majors[0]?.major;
          const versionsByMajor: Record<number, MavenPackage[]> = {};
          if (first !== undefined) {
            const versions = await this.mavenInstaller.listVersions(first);
            this.mavenPackages.set(first, versions);
            versionsByMajor[first] = versions;
          }
          this.panel.webview.postMessage({
            cmd: 'mavenDownloadList',
            majors,
            versionsByMajor: Object.fromEntries(
              Object.entries(versionsByMajor).map(([k, v]) => [k, v.map(toMavenDto)]),
            ) as Record<number, ReturnType<typeof toMavenDto>[]>,
            installRoot: this.mavenInstaller.getInstallRoot(),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listMavenDownloads failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'mavenDownloadError',
            message: `Could not load Maven versions: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'listMavenVersions': {
        log.debug(`listMavenVersions: ${msg.major}`);
        try {
          let versions = this.mavenPackages.get(msg.major);
          if (!versions) {
            versions = await this.mavenInstaller.listVersions(msg.major);
            this.mavenPackages.set(msg.major, versions);
          }
          this.panel.webview.postMessage({
            cmd: 'mavenVersionList',
            major: msg.major,
            versions: versions.map(toMavenDto),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listMavenVersions failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'mavenDownloadError',
            message: `Could not list Maven ${msg.major} versions: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'downloadMaven': {
        log.info(`downloadMaven: maven-${msg.major} v${msg.version}`);
        const versions = this.mavenPackages.get(msg.major) ?? [];
        const pkg = versions.find(v => v.version === msg.version);
        if (!pkg) {
          this.panel.webview.postMessage({
            cmd: 'mavenDownloadError',
            message: 'Maven version not found — please refresh the dialog.',
          } satisfies Inbound);
          return;
        }
        try {
          const result = await this.mavenInstaller.install(pkg, p => {
            this.panel.webview.postMessage({
              cmd: 'mavenDownloadProgress',
              state: p.state,
              fraction: p.fraction,
              ...(p.detail ? { detail: p.detail } : {}),
            } satisfies Inbound);
          });
          // Slot the new install into the Maven dropdown.
          const existing = (this.context.mavenInstalls as string[] | undefined) ?? [];
          if (!existing.includes(result.mavenHome)) {
            this.context.mavenInstalls = [...existing, result.mavenHome];
            if (this.args.adapter) {
              const schema = this.args.adapter.getFormSchema(this.context);
              this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
            }
          }
          this.panel.webview.postMessage({
            cmd: 'mavenDownloadComplete',
            mavenHome: result.mavenHome,
            version: result.version,
            major: result.major,
          } satisfies Inbound);
          this.panel.webview.postMessage({
            cmd: 'configPatch',
            patch: { typeOptions: { mavenPath: result.mavenHome } } as any,
            force: true,
          } satisfies Inbound);
        } catch (e) {
          const cancelled = e instanceof CancelledError;
          log.warn(`downloadMaven: ${cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'mavenDownloadError',
            message: cancelled ? 'Download cancelled.' : (e as Error).message,
            ...(cancelled ? { cancelled: true } : {}),
          } satisfies Inbound);
        }
        return;
      }
      case 'cancelMavenDownload': {
        log.debug('cancelMavenDownload');
        this.mavenInstaller.cancel();
        return;
      }
      case 'listGradleDownloads': {
        log.debug('listGradleDownloads');
        try {
          const versions = await this.gradleInstaller.listVersions();
          this.gradleVersions = versions;
          this.panel.webview.postMessage({
            cmd: 'gradleDownloadList',
            versions: versions.map(toGradleDto),
            installRoot: this.gradleInstaller.getInstallRoot(),
          } satisfies Inbound);
        } catch (e) {
          log.warn(`listGradleDownloads failed: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'gradleDownloadError',
            message: `Could not load Gradle versions: ${(e as Error).message}`,
          } satisfies Inbound);
        }
        return;
      }
      case 'downloadGradle': {
        log.info(`downloadGradle: ${msg.version}`);
        const v = (this.gradleVersions ?? []).find(x => x.version === msg.version);
        if (!v) {
          this.panel.webview.postMessage({
            cmd: 'gradleDownloadError',
            message: 'Gradle version not found — please refresh the dialog.',
          } satisfies Inbound);
          return;
        }
        try {
          const result = await this.gradleInstaller.install(v, p => {
            this.panel.webview.postMessage({
              cmd: 'gradleDownloadProgress',
              state: p.state,
              fraction: p.fraction,
              ...(p.detail ? { detail: p.detail } : {}),
            } satisfies Inbound);
          });
          const existing = (this.context.gradleInstalls as string[] | undefined) ?? [];
          if (!existing.includes(result.gradleHome)) {
            this.context.gradleInstalls = [...existing, result.gradleHome];
            if (this.args.adapter) {
              const schema = this.args.adapter.getFormSchema(this.context);
              this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
            }
          }
          this.panel.webview.postMessage({
            cmd: 'gradleDownloadComplete',
            gradleHome: result.gradleHome,
            version: result.version,
          } satisfies Inbound);
          this.panel.webview.postMessage({
            cmd: 'configPatch',
            patch: { typeOptions: { gradlePath: result.gradleHome } } as any,
            force: true,
          } satisfies Inbound);
        } catch (e) {
          const cancelled = e instanceof CancelledError;
          log.warn(`downloadGradle: ${cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
          this.panel.webview.postMessage({
            cmd: 'gradleDownloadError',
            message: cancelled ? 'Download cancelled.' : (e as Error).message,
            ...(cancelled ? { cancelled: true } : {}),
          } satisfies Inbound);
        }
        return;
      }
      case 'cancelGradleDownload': {
        log.debug('cancelGradleDownload');
        this.gradleInstaller.cancel();
        return;
      }
      case 'refreshContainers': {
        if (!this.args.docker) return;
        log.debug('Docker refresh containers');
        try {
          await this.args.docker.refresh();
          this.context.containers = this.args.docker.list();
          this.context.dockerAvailable = this.args.docker.isAvailable();
          this.context.dockerError = this.args.docker.listError();
          const schema = this.args.adapter.getFormSchema(this.context);
          this.panel.webview.postMessage({ cmd: 'schemaUpdate', schema } satisfies Inbound);
        } catch (e) {
          log.warn(`refreshContainers failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'validateProjectPath': {
        // Fires on blur of a folderPath field whose schema declared
        // `validateBuildPath`. Fast filesystem stats only — no shelling
        // out — so we don't debounce or throttle.
        log.debug(`Validate projectPath (${msg.buildTool}): "${msg.projectPath}"`);
        try {
          const result = await validateBuildProjectPath(
            this.args.folder,
            msg.projectPath,
            msg.buildTool,
          );
          const reply: Inbound = result.ok
            ? { cmd: 'projectPathValidated', fieldKey: msg.fieldKey, ok: true }
            : {
                cmd: 'projectPathValidated',
                fieldKey: msg.fieldKey,
                ok: false,
                reason: result.reason,
                suggestion: result.suggestion,
              };
          this.panel.webview.postMessage(reply);
        } catch (e) {
          log.warn(`validateProjectPath failed: ${(e as Error).message}`);
          // Silent failure — don't nag the user about a best-effort check.
          const reply: Inbound = { cmd: 'projectPathValidated', fieldKey: msg.fieldKey, ok: true };
          this.panel.webview.postMessage(reply);
        }
        return;
      }
      case 'testVariables': {
        const cfg = msg.config;
        const springRoot = cfg.type === 'spring-boot'
          && (cfg.typeOptions.launchMode === 'maven' || cfg.typeOptions.launchMode === 'gradle')
          && cfg.typeOptions.buildRoot
            ? cfg.typeOptions.buildRoot
            : null;
        const quarkusRoot = cfg.type === 'quarkus' && cfg.typeOptions.buildRoot
          ? cfg.typeOptions.buildRoot
          : null;
        const javaRoot = cfg.type === 'java'
          && (cfg.typeOptions.launchMode === 'maven' || cfg.typeOptions.launchMode === 'gradle')
          && cfg.typeOptions.buildRoot
            ? cfg.typeOptions.buildRoot
            : null;
        const mavenGoalRoot = cfg.type === 'maven-goal' && cfg.typeOptions.buildRoot
          ? cfg.typeOptions.buildRoot
          : null;
        const gradleTaskRoot = cfg.type === 'gradle-task' && cfg.typeOptions.buildRoot
          ? cfg.typeOptions.buildRoot
          : null;
        const cwd = springRoot
          ?? quarkusRoot
          ?? javaRoot
          ?? mavenGoalRoot
          ?? gradleTaskRoot
          ?? resolveProjectUri(this.args.folder, cfg.projectPath ?? '').fsPath;
        const ctx = makeRunContext({ workspaceFolder: this.args.folder.uri.fsPath, cwd });
        const { unresolved } = resolveConfig(cfg, ctx);
        const reply: Inbound = {
          cmd: 'variablesTested',
          unresolved,
          builtins: {
            workspaceFolder: ctx.workspaceFolder,
            userHome: ctx.userHome,
            cwd: ctx.cwd,
          },
        };
        this.panel.webview.postMessage(reply);
        return;
      }
      case 'save':
        try {
          const sanitized = this.sanitize(msg.config);
          log.debug(
            `Save (${this.args.mode}): ${sanitized.type} "${sanitized.name}" ` +
            `→ ${this.args.folderKey}`,
          );
          // Pre-flight Zod check so we can surface per-field errors (red
          // border + inline message under the offending input) instead of
          // a single generic banner. In create mode the webview hasn't been
          // given an id yet — svc.create assigns one — so stub a valid uuid
          // just for the check. Without the stub, Zod fails on ['id'] which
          // maps to no visible form field and the user sees a count with no
          // highlighted input.
          const stubId = this.args.mode === 'create'
            ? '00000000-0000-4000-8000-000000000000'
            : sanitized.id;
          const parse = RunConfigSchema.safeParse({ ...sanitized, id: stubId });
          if (!parse.success) {
            // Defense in depth: drop any ['id'] issues — the id is extension-
            // controlled, never the user's fault.
            const errors = parse.error.issues
              .filter(issue => issue.path[0] !== 'id')
              .map(issue => ({
                // Issue paths are arrays like ['typeOptions','mainClass'];
                // the form's field keys use dotted notation so we just join.
                fieldKey: issue.path.join('.'),
                message: issue.message,
              }));
            if (errors.length > 0) {
              log.warn(`Save rejected: ${errors.length} validation error(s)`);
              this.panel.webview.postMessage({ cmd: 'fieldErrors', errors } satisfies Inbound);
              return;
            }
          }
          // Happy path — clear any lingering field errors from a previous
          // rejected submit.
          this.panel.webview.postMessage({ cmd: 'fieldErrors', errors: [] } satisfies Inbound);

          if (this.args.mode === 'create') {
            const { id, ...rest } = sanitized;
            await this.svc.create(this.args.folderKey, rest);
          } else {
            // Authoritative-id guard: in edit mode, the panel's own record
            // of which config is being edited wins over whatever the
            // webview posted. Protects against stale-state bugs where the
            // webview somehow shipped a different id than we opened the
            // panel with (caught a wrong-config-overwrite bug in the wild).
            const expectedId = this.args.existing?.id;
            if (expectedId && sanitized.id !== expectedId) {
              log.warn(
                `Save id mismatch: webview posted id=${sanitized.id} but panel was opened for id=${expectedId}. ` +
                `Coercing to the opened id.`,
              );
            }
            const toSave = expectedId
              ? ({ ...sanitized, id: expectedId } as RunConfig)
              : sanitized;
            await this.svc.update(this.args.folderKey, toSave);
          }
          log.info(`${this.args.mode === 'create' ? 'Created' : 'Updated'}: "${sanitized.name}"`);
          this.panel.dispose();
        } catch (e) {
          const err: Inbound = { cmd: 'error', message: (e as Error).message };
          this.panel.webview.postMessage(err);
          log.error('Save failed', e);
        }
        return;
    }
  }

  private sanitize(cfg: RunConfig): RunConfig {
    return sanitizeConfig(cfg);
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview', 'assets', 'main.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview', 'assets', 'main.css'),
    );
    const nonce = makeNonce();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
 content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}" />
<title>Run Configuration</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Project a JdkPackage down to the DTO the webview consumes. Strips
// internal fields (sha256, directUrl) we don't want flowing into the
// webview's state — they're only needed server-side during install.
function toPackageDto(p: JdkPackage) {
  return {
    id: p.id,
    distro: p.distro,
    versionLabel: p.versionLabel,
    majorVersion: p.majorVersion,
    filename: p.filename,
    size: p.size,
    lts: p.lts,
    // Same name the installer will create on disk — keeps the dialog's
    // "Will be installed to:" preview honest.
    installDirName: jdkInstallDirName(p),
  };
}

function toTomcatDto(p: TomcatPackage) {
  return {
    major: p.major,
    version: p.version,
    versionLabel: p.versionLabel,
    installDirName: `apache-tomcat-${p.version}`,
  };
}

function toMavenDto(p: MavenPackage) {
  return {
    major: p.major,
    version: p.version,
    versionLabel: p.versionLabel,
    installDirName: `apache-maven-${p.version}`,
  };
}

function toGradleDto(v: GradleVersionPkg) {
  return {
    version: v.version,
    versionLabel: v.version + (v.current ? ' (latest)' : ''),
    installDirName: `gradle-${v.version}`,
    current: v.current,
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Fill missing keys so the config passes schema validation even if the webview
// posted a partial object (e.g., the user never touched the script select).
// Each branch MUST mirror the schema's typeOptions shape exactly. When a new
// RunConfigType is added, extend the switch — the exhaustiveness guard at the
// end throws loudly if it's missed, which is how we catch the "saved as npm"
// regression that the Quarkus bug exposed.
export function sanitizeConfig(cfg: RunConfig): RunConfig {
  // Normalise dependsOn: drop empty refs, clamp delays, omit field entirely
  // when the list is empty so saved JSON stays tidy.
  const deps = (cfg.dependsOn ?? [])
    .filter(d => d && typeof d.ref === 'string' && d.ref.trim())
    .map(d => ({
      ref: d.ref.trim(),
      ...(typeof d.delaySeconds === 'number' && d.delaySeconds > 0
        ? { delaySeconds: Math.min(600, Math.max(0, Math.floor(d.delaySeconds))) }
        : {}),
    }));
  // Normalise group: trim whitespace and drop the field entirely when
  // empty (an empty string would treat the config as "in a group named ''"
  // which the tree provider would then render as a nameless folder).
  const groupTrimmed = cfg.group?.trim();
  // Normalise envFiles: trim each path, drop empties, drop the array
  // entirely when nothing's left so saved run.json stays tidy.
  const envFiles = (cfg.envFiles ?? [])
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  const common = {
    ...cfg,
    env: cfg.env ?? {},
    programArgs: cfg.programArgs ?? '',
    vmArgs: cfg.vmArgs ?? '',
    ...(deps.length > 0 ? { dependsOn: deps } : { dependsOn: undefined }),
    ...(groupTrimmed ? { group: groupTrimmed } : { group: undefined }),
    ...(envFiles.length > 0 ? { envFiles } : { envFiles: undefined }),
  };
  // Remove explicit undefined slots so JSON.stringify doesn't leave
  // `"dependsOn": null` / `"group": null` artefacts on disk.
  if (common.dependsOn === undefined) delete (common as any).dependsOn;
  if (common.group === undefined) delete (common as any).group;
  if (common.envFiles === undefined) delete (common as any).envFiles;
  if (cfg.type === 'tomcat') {
    const to = cfg.typeOptions as Partial<import('../shared/types').TomcatTypeOptions> | undefined;
    return {
      ...common,
      type: 'tomcat',
      typeOptions: {
        tomcatHome: to?.tomcatHome ?? '',
        jdkPath: to?.jdkPath ?? '',
        httpPort: to?.httpPort ?? 8080,
        httpsPort: to?.httpsPort,
        ajpPort: to?.ajpPort,
        jmxPort: to?.jmxPort,
        debugPort: to?.debugPort,
        buildProjectPath: to?.buildProjectPath ?? '',
        buildRoot: to?.buildRoot ?? '',
        buildTool: (to?.buildTool ?? 'gradle') as 'gradle' | 'maven' | 'none',
        gradleCommand: (to?.gradleCommand ?? './gradlew') as './gradlew' | 'gradle',
        gradlePath: to?.gradlePath ?? '',
        mavenPath: to?.mavenPath ?? '',
        artifactPath: to?.artifactPath ?? '',
        artifactKind: (to?.artifactKind ?? 'war') as 'war' | 'exploded',
        applicationContext: to?.applicationContext ?? '/',
        profiles: to?.profiles ?? '',
        vmOptions: to?.vmOptions ?? '',
        reloadable: to?.reloadable ?? true,
        rebuildOnSave: to?.rebuildOnSave ?? false,
        colorOutput: to?.colorOutput,
      },
    };
  }
  if (cfg.type === 'spring-boot') {
    const to = cfg.typeOptions as Partial<import('../shared/types').SpringBootTypeOptions> | undefined;
    const buildTool = to?.buildTool ?? 'maven';
    return {
      ...common,
      type: 'spring-boot',
      typeOptions: {
        launchMode: to?.launchMode ?? buildTool,
        buildTool,
        gradleCommand: to?.gradleCommand ?? './gradlew',
        profiles: to?.profiles ?? '',
        mainClass: to?.mainClass ?? '',
        classpath: to?.classpath ?? '',
        jdkPath: to?.jdkPath ?? '',
        module: to?.module ?? '',
        gradlePath: to?.gradlePath ?? '',
        mavenPath: to?.mavenPath ?? '',
        buildRoot: to?.buildRoot ?? '',
        // Optional fields — forward verbatim so the user's toggles actually
        // persist. Earlier omission silently dropped these on every save.
        ...(typeof to?.debugPort === 'number' ? { debugPort: to.debugPort } : {}),
        ...(typeof to?.rebuildOnSave === 'boolean' ? { rebuildOnSave: to.rebuildOnSave } : {}),
        ...(typeof to?.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
        ...(typeof to?.recomputeClasspathOnRun === 'boolean' ? { recomputeClasspathOnRun: to.recomputeClasspathOnRun } : {}),
      },
    };
  }
  if (cfg.type === 'quarkus') {
    const to = cfg.typeOptions as Partial<import('../shared/types').QuarkusTypeOptions> | undefined;
    const buildTool = to?.buildTool ?? 'maven';
    return {
      ...common,
      type: 'quarkus',
      typeOptions: {
        launchMode: to?.launchMode ?? buildTool,
        buildTool,
        gradleCommand: to?.gradleCommand ?? './gradlew',
        profile: to?.profile ?? '',
        jdkPath: to?.jdkPath ?? '',
        module: to?.module ?? '',
        gradlePath: to?.gradlePath ?? '',
        mavenPath: to?.mavenPath ?? '',
        buildRoot: to?.buildRoot ?? '',
        ...(typeof to?.debugPort === 'number' ? { debugPort: to.debugPort } : {}),
        ...(typeof to?.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
      },
    };
  }
  if (cfg.type === 'java') {
    const to = cfg.typeOptions as Partial<import('../shared/types').JavaTypeOptions> | undefined;
    const buildTool = to?.buildTool ?? 'maven';
    return {
      ...common,
      type: 'java',
      typeOptions: {
        launchMode: to?.launchMode ?? buildTool,
        buildTool,
        gradleCommand: to?.gradleCommand ?? './gradlew',
        mainClass: to?.mainClass ?? '',
        classpath: to?.classpath ?? '',
        customArgs: to?.customArgs ?? '',
        jdkPath: to?.jdkPath ?? '',
        module: to?.module ?? '',
        gradlePath: to?.gradlePath ?? '',
        mavenPath: to?.mavenPath ?? '',
        buildRoot: to?.buildRoot ?? '',
        ...(typeof to?.debugPort === 'number' ? { debugPort: to.debugPort } : {}),
        ...(typeof to?.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
      },
    };
  }
  if (cfg.type === 'maven-goal') {
    const to = cfg.typeOptions as Partial<import('../shared/types').MavenGoalTypeOptions> | undefined;
    return {
      ...common,
      type: 'maven-goal',
      typeOptions: {
        goal: to?.goal ?? '',
        jdkPath: to?.jdkPath ?? '',
        mavenPath: to?.mavenPath ?? '',
        buildRoot: to?.buildRoot ?? '',
        ...(typeof to?.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
      },
    };
  }
  if (cfg.type === 'gradle-task') {
    const to = cfg.typeOptions as Partial<import('../shared/types').GradleTaskTypeOptions> | undefined;
    return {
      ...common,
      type: 'gradle-task',
      typeOptions: {
        task: to?.task ?? '',
        gradleCommand: to?.gradleCommand ?? './gradlew',
        jdkPath: to?.jdkPath ?? '',
        gradlePath: to?.gradlePath ?? '',
        buildRoot: to?.buildRoot ?? '',
        ...(typeof to?.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
      },
    };
  }
  if (cfg.type === 'custom-command') {
    const to = cfg.typeOptions as Partial<import('../shared/types').CustomCommandTypeOptions> | undefined;
    return {
      ...common,
      type: 'custom-command',
      typeOptions: {
        command: to?.command ?? '',
        cwd: to?.cwd ?? '',
        shell: (to?.shell ?? 'default') as import('../shared/types').CustomShell,
        interactive: to?.interactive ?? false,
        ...(typeof to?.colorOutput === 'boolean' ? { colorOutput: to.colorOutput } : {}),
      },
    };
  }
  if (cfg.type === 'npm') {
    const to = cfg.typeOptions as Partial<import('../shared/types').NpmTypeOptions> | undefined;
    return {
      ...common,
      type: 'npm',
      typeOptions: {
        scriptName: to?.scriptName ?? '',
        packageManager: to?.packageManager ?? 'npm',
      },
    };
  }
  if (cfg.type === 'docker') {
    const to = cfg.typeOptions as Partial<import('../shared/types').DockerTypeOptions> | undefined;
    return {
      ...common,
      type: 'docker',
      typeOptions: {
        containerId: to?.containerId ?? '',
        ...(to?.containerName ? { containerName: to.containerName } : {}),
      },
    };
  }
  // Exhaustiveness guard — if a new RunConfigType is added and sanitize
  // isn't updated, fail loudly at save time rather than silently coercing
  // to npm (which is how the Quarkus-save-as-npm bug happened in v1).
  const never: never = cfg;
  throw new Error(`sanitize: unsupported config type: ${(never as any).type}`);
}
