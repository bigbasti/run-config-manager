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

interface OpenArgs {
  mode: 'create' | 'edit';
  folderKey: string;
  folder: vscode.WorkspaceFolder;
  existing?: RunConfig;
  seedDefaults?: Partial<RunConfig>;
  schema: FormSchema;
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
      | 'quarkus';

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
    };
    this.panel.webview.postMessage(init);

    // If streaming detection is enabled, kick it off now (non-blocking).
    if (this.args.streaming && this.args.mode === 'create') {
      this.runStreamingDetection().catch(e => log.error('streaming detection', e));
    }
  }

  private async runStreamingDetection(): Promise<void> {
    const s = this.args.streaming;
    if (!s || !s.adapter.detectStreaming) return;
    const context: Record<string, unknown> = { ...s.initialContext };
    const pending = new Set<string>(s.pending);

    const emit = (patch: StreamingPatch) => {
      Object.assign(context, patch.contextPatch);
      for (const k of patch.resolved ?? []) pending.delete(k);

      const schema = s.adapter.getFormSchema(context);
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
        const reply: Inbound = { cmd: 'folderPicked', path: rel };
        this.panel.webview.postMessage(reply);
        return;
      }
      case 'recomputeClasspath': {
        if (msg.config.type !== 'spring-boot') return;
        const to = msg.config.typeOptions;
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
        const cwd = springRoot
          ?? quarkusRoot
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
          if (this.args.mode === 'create') {
            const { id, ...rest } = sanitized;
            await this.svc.create(this.args.folderKey, rest);
          } else {
            await this.svc.update(this.args.folderKey, sanitized);
          }
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
