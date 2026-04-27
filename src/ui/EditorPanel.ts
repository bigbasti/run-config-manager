import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { Inbound, Outbound } from '../shared/protocol';
import type { FormSchema } from '../shared/formSchema';
import type { RunConfigService } from '../services/RunConfigService';
import type { RuntimeAdapter, StreamingPatch } from '../adapters/RuntimeAdapter';
import { log } from '../utils/logger';
import { relativeFromWorkspace, resolveProjectUri } from '../utils/paths';
import { recomputeClasspath } from '../adapters/spring-boot/recomputeClasspath';
import { makeRunContext, resolveConfig } from '../utils/resolveVars';
import { discoverGradleTasks } from '../adapters/gradle-task/discoverGradleTasks';
import { discoverMavenGoals } from '../adapters/maven-goal/discoverMavenGoals';
import { validateBuildProjectPath } from '../utils/validateBuildProjectPath';
import { RunConfigSchema } from '../shared/schema';

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
}

export class EditorPanel {
  private static instance: EditorPanel | undefined;

  private panel: vscode.WebviewPanel;
  private args: OpenArgs;
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
    const seed = (this.args.seedDefaults ?? {}) as Record<string, unknown>;
    const type = ((seed.type as string | undefined) ?? this.args.existing?.type ?? 'npm') as
      | 'npm'
      | 'spring-boot'
      | 'tomcat'
      | 'quarkus'
      | 'java'
      | 'maven-goal'
      | 'gradle-task'
      | 'custom-command';

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
          const err: Inbound = { cmd: 'error', message: `Classpath recompute failed: ${(e as Error).message}` };
          this.panel.webview.postMessage(err);
          log.error('recomputeClasspath', e);
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
  const common = {
    ...cfg,
    env: cfg.env ?? {},
    programArgs: cfg.programArgs ?? '',
    vmArgs: cfg.vmArgs ?? '',
  };
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
  // Exhaustiveness guard — if a new RunConfigType is added and sanitize
  // isn't updated, fail loudly at save time rather than silently coercing
  // to npm (which is how the Quarkus-save-as-npm bug happened in v1).
  const never: never = cfg;
  throw new Error(`sanitize: unsupported config type: ${(never as any).type}`);
}
