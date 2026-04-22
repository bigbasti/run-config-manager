import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import type { Inbound, Outbound } from '../shared/protocol';
import type { FormSchema } from '../shared/formSchema';
import type { RunConfigService } from '../services/RunConfigService';
import { log } from '../utils/logger';
import { relativeFromWorkspace } from '../utils/paths';

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
    const baseDefaults: Partial<RunConfig> = {
      name: '',
      projectPath: '',
      workspaceFolder: this.args.folder.name,
      env: {},
      programArgs: '',
      vmArgs: '',
      type: 'npm',
      typeOptions: { scriptName: '', packageManager: 'npm' },
    };
    const seed = this.args.seedDefaults ?? {};
    const config: Partial<RunConfig> = this.args.existing
      ? { ...this.args.existing }
      : {
          ...baseDefaults,
          ...seed,
          // Merge typeOptions rather than overwrite, so detection can contribute
          // scriptName/packageManager without losing other future fields.
          typeOptions: { ...baseDefaults.typeOptions!, ...(seed.typeOptions ?? {}) },
        };

    const init: Inbound = {
      cmd: 'init',
      mode: this.args.mode,
      config,
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
    return {
      ...cfg,
      env: cfg.env ?? {},
      programArgs: cfg.programArgs ?? '',
      vmArgs: cfg.vmArgs ?? '',
      typeOptions: {
        scriptName: cfg.typeOptions?.scriptName ?? '',
        packageManager: cfg.typeOptions?.packageManager ?? 'npm',
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
