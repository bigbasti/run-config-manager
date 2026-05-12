import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import type { MonitoringService } from '../services/MonitoringService';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';

// One panel per configId. Re-opening reveals the existing instance so the
// chart history isn't lost on a second click. The panel listens to
// MonitoringService.onChanged and pushes the latest metrics + histogram
// to the webview each time the underlying state mutates.
export class MonitorPanel {
  private static instances = new Map<string, MonitorPanel>();

  private panel: vscode.WebviewPanel;
  private subscription: vscode.Disposable;

  private constructor(
    private readonly cfg: RunConfig,
    private readonly extensionUri: vscode.Uri,
    private readonly monitoring: MonitoringService,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'rcmMonitor',
      `Monitor: ${cfg.name}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media', 'webview')],
      },
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.subscription = monitoring.onChanged(id => {
      if (id === cfg.id) this.pushState();
    });
    this.panel.onDidDispose(() => {
      this.subscription.dispose();
      MonitorPanel.instances.delete(cfg.id);
    });
    this.pushState();
  }

  static open(cfg: RunConfig, extensionUri: vscode.Uri, monitoring: MonitoringService): void {
    const existing = this.instances.get(cfg.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const inst = new MonitorPanel(cfg, extensionUri, monitoring);
    this.instances.set(cfg.id, inst);
  }

  private pushState(): void {
    const state = this.monitoring.state(this.cfg.id);
    if (!state) return;
    if (state.history.length > 0) {
      this.panel.webview.postMessage({
        cmd: 'monitor.tick',
        configId: this.cfg.id,
        metrics: state.history[state.history.length - 1],
        // Send startTime on every tick — the webview can't derive it from
        // the metrics ring buffer (which gets capped at 60 entries, so the
        // oldest buffered tick is NOT the start time).
        startTime: state.startTime,
      });
    }
    if (state.histogram) {
      this.panel.webview.postMessage({
        cmd: 'monitor.histogram',
        configId: this.cfg.id,
        histogram: state.histogram,
      });
    }
  }

  private async onMessage(msg: any): Promise<void> {
    if (msg?.cmd === 'monitor.saveHeapDump' && msg.configId === this.cfg.id) {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(
          os.tmpdir(),
          `${this.cfg.name.replace(/\W+/g, '-')}-${Date.now()}.hprof`,
        )),
        filters: { 'Heap dump': ['hprof'] },
      });
      if (!target) return;
      try {
        const writtenPath = await this.monitoring.saveHeapDump(this.cfg.id, target.fsPath);
        this.panel.webview.postMessage({
          cmd: 'monitor.dumpComplete',
          configId: this.cfg.id,
          path: writtenPath,
        });
        const choice = await vscode.window.showInformationMessage(
          `Heap dump written to ${writtenPath}`,
          'Reveal in Explorer',
        );
        if (choice === 'Reveal in Explorer') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(writtenPath));
        }
      } catch (e) {
        log.warn(`MonitorPanel saveHeapDump failed: ${(e as Error).message}`);
        this.panel.webview.postMessage({
          cmd: 'monitor.error',
          configId: this.cfg.id,
          message: (e as Error).message,
        });
      }
      return;
    }
    if (msg?.cmd === 'monitor.setHistogramPaused' && msg.configId === this.cfg.id) {
      this.monitoring.setHistogramPaused(this.cfg.id, !!msg.paused);
      return;
    }
  }

  private html(): string {
    const main = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'assets', 'main.js'),
    );
    const css = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'assets', 'main.css'),
    );
    const cspSource = this.panel.webview.cspSource;
    const nonce = makeNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
   content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}" />
  <title>Monitor: ${escapeHtml(this.cfg.name)}</title>
</head>
<body>
<div id="root" data-view="monitor" data-config-id="${escapeHtml(this.cfg.id)}" data-config-name="${escapeHtml(this.cfg.name)}" data-own-package="${escapeHtml(ownPackagePrefix(this.cfg))}"></div>
<script type="module" nonce="${nonce}" src="${main}"></script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Derives the "own classes" package prefix from the config's main class.
// Heuristic: first three dotted segments. `de.telekom.it.foo.bar.App` →
// `de.telekom.it`. Returns '' when no usable mainClass is set; the
// webview hides the "show only mine" toggle in that case.
function ownPackagePrefix(cfg: RunConfig): string {
  const mainClass = mainClassOf(cfg);
  if (!mainClass) return '';
  const segs = mainClass.split('.');
  if (segs.length < 3) return '';
  return segs.slice(0, 3).join('.');
}

function mainClassOf(cfg: RunConfig): string | undefined {
  if (cfg.type === 'spring-boot' || cfg.type === 'java') {
    return cfg.typeOptions.mainClass || undefined;
  }
  return undefined;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
