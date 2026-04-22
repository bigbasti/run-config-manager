import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { Inbound, Outbound } from '../shared/protocol';
import type { FormSchema } from '../shared/formSchema';
import type { RunConfigService } from '../services/RunConfigService';
import { log } from '../utils/logger';
import { relativeFromWorkspace, resolveProjectUri } from '../utils/paths';
import { recomputeClasspath } from '../adapters/spring-boot/recomputeClasspath';

interface OpenArgs {
  mode: 'create' | 'edit';
  folderKey: string;
  folder: vscode.WorkspaceFolder;
  existing?: RunConfig;
  seedDefaults?: Partial<RunConfig>;
  schema: FormSchema;
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
      | 'spring-boot';

    const baseCommon = {
      name: '',
      projectPath: '',
      workspaceFolder: this.args.folder.name,
      env: {},
      programArgs: '',
      vmArgs: '',
    };

    const typeDefaults: Record<string, unknown> =
      type === 'npm'
        ? { scriptName: '', packageManager: 'npm' }
        : { buildTool: 'maven', profiles: '' };

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
    };
    this.panel.webview.postMessage(init);
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
          const cp = await recomputeClasspath({
            projectRoot: resolveProjectUri(this.args.folder, msg.config.projectPath),
            buildTool: to.buildTool,
            gradleCommand: to.gradleCommand,
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

  // Fill missing keys so the config passes schema validation even if the webview
  // posted a partial object (e.g., the user never touched the script select).
  private sanitize(cfg: RunConfig): RunConfig {
    const common = {
      ...cfg,
      env: cfg.env ?? {},
      programArgs: cfg.programArgs ?? '',
      vmArgs: cfg.vmArgs ?? '',
    };
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
        },
      };
    }
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
