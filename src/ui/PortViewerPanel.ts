import * as vscode from 'vscode';
import { scanPorts, killProcess, inferConfigPortsDetailed, type PortEntry } from '../services/PortScanner';
import type { RunConfigService } from '../services/RunConfigService';
import type { ExecutionService } from '../services/ExecutionService';
import type { DockerService } from '../services/DockerService';
import type { DebugService } from '../services/DebugService';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';

interface PortRow extends PortEntry {
  configName?: string;
  configRunning?: boolean;
  group: 'config' | 'other';
}

export class PortViewerPanel {
  private static instance: PortViewerPanel | undefined;
  private panel: vscode.WebviewPanel;

  private constructor(
    private readonly svc: RunConfigService,
    private readonly exec: ExecutionService,
    private readonly dbg: DebugService,
    private readonly docker: DockerService,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'rcmPortViewer',
      'Find Blocking Ports',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panel.onDidDispose(() => { if (PortViewerPanel.instance === this) PortViewerPanel.instance = undefined; });
    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    this.refresh();
  }

  static open(
    svc: RunConfigService,
    exec: ExecutionService,
    dbg: DebugService,
    docker: DockerService,
  ): void {
    if (PortViewerPanel.instance) {
      log.debug('Port viewer: revealing existing panel + refreshing');
      PortViewerPanel.instance.panel.reveal(vscode.ViewColumn.Active);
      PortViewerPanel.instance.refresh();
      return;
    }
    log.info('Port viewer: opening new panel');
    PortViewerPanel.instance = new PortViewerPanel(svc, exec, dbg, docker);
  }

  private async refresh(): Promise<void> {
    log.debug('Port viewer: refresh starting');
    const ports = await scanPorts();
    const { rows, anyExplicit } = this.enrichRows(ports);
    const configRows = rows.filter(r => r.group === 'config');
    log.info(
      `Port viewer: ${rows.length} total port(s), ${configRows.length} matched to configs, ` +
      `anyExplicit=${anyExplicit}`,
    );
    this.panel.webview.html = buildHtml(rows, anyExplicit);
  }

  private enrichRows(ports: PortEntry[]): { rows: PortRow[]; anyExplicit: boolean } {
    const configPorts = new Map<number, { name: string; running: boolean }>();
    let anyExplicit = false;
    let configsScanned = 0;
    for (const ref of this.svc.list()) {
      if (!ref.valid) continue;
      configsScanned++;
      const cfg = ref.config;
      const { explicit, defaultPorts } = inferConfigPortsDetailed(cfg);
      if (explicit.length > 0) anyExplicit = true;
      const running = this.isRunning(cfg);
      for (const p of [...explicit, ...defaultPorts]) {
        configPorts.set(p, { name: cfg.name, running });
      }
      if (explicit.length > 0 || defaultPorts.length > 0) {
        log.debug(
          `Port viewer: config "${cfg.name}" (${cfg.type}) contributes ports ` +
          `[${[...explicit, ...defaultPorts].join(', ')}] running=${running}`,
        );
      }
    }
    log.debug(
      `Port viewer: scanned ${configsScanned} valid config(s); ` +
      `${configPorts.size} unique port(s) mapped to configs`,
    );
    const rows = ports.map(pe => {
      const match = configPorts.get(pe.port);
      return {
        ...pe,
        configName: match?.name,
        configRunning: match?.running,
        group: match ? 'config' as const : 'other' as const,
      };
    });
    return { rows, anyExplicit };
  }

  private isRunning(cfg: RunConfig): boolean {
    if (cfg.type === 'docker') return this.docker.isRunning(cfg.typeOptions.containerId);
    return this.exec.isRunning(cfg.id) || this.exec.isStarted(cfg.id) || this.dbg.isRunning(cfg.id);
  }

  private async handleMessage(msg: { cmd: string; pid?: number; processName?: string }): Promise<void> {
    log.debug(`Port viewer: received message cmd=${msg.cmd} pid=${msg.pid ?? ''}`);
    if (msg.cmd === 'refresh') {
      log.debug('Port viewer: user-triggered refresh');
      await this.refresh();
      return;
    }
    if (msg.cmd === 'kill' && typeof msg.pid === 'number') {
      // Confirmation happens HERE rather than in the webview because
      // window.confirm() is unavailable in VS Code webviews — it returns
      // false silently and the click does nothing. Using the native modal
      // gives us a real prompt + proper styling + works on every platform.
      const pid = msg.pid;
      const name = msg.processName?.trim();
      const label = name ? `${name} (PID ${pid})` : `PID ${pid}`;
      log.info(`Port viewer: kill requested for ${label} — showing confirmation`);
      const choice = await vscode.window.showWarningMessage(
        `Kill process ${label}?`,
        { modal: true, detail: 'This sends SIGTERM (or taskkill /F on Windows). Unsaved work in that process may be lost.' },
        'Kill',
      );
      if (choice !== 'Kill') {
        log.debug(`Port viewer: user cancelled kill of ${label}`);
        return;
      }
      log.info(`Port viewer: user confirmed kill of ${label}`);
      try {
        await killProcess(pid);
        log.info(`Port viewer: ${label} terminated, re-scanning`);
        vscode.window.showInformationMessage(`Process ${label} terminated.`);
        // Brief delay so the OS releases the port before we re-scan.
        await new Promise(r => setTimeout(r, 500));
        await this.refresh();
      } catch (e) {
        log.error(`Port viewer: kill ${label} failed`, e);
        vscode.window.showErrorMessage(`Failed to kill ${label}: ${(e as Error).message}`);
      }
    }
  }
}

function buildHtml(rows: PortRow[], anyExplicitPort: boolean): string {
  const configRows = rows.filter(r => r.group === 'config');
  const hasConfig = configRows.length > 0;
  const data = JSON.stringify(rows);
  // When the Config Ports group is empty AND no config declared a port
  // explicitly, we show a hint nudging the user to fill the optional
  // `port` field so the UI can filter blocking processes more precisely.
  const showPortHint = configRows.length === 0 && !anyExplicitPort;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #ccc);
    --border: var(--vscode-panel-border, rgba(128,128,128,0.35));
    --header-bg: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
    --hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --input-border: var(--vscode-input-border, rgba(128,128,128,0.4));
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #fff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --danger-bg: #c72e2e;
    --danger-hover: #a82222;
    --green-bg: rgba(40, 167, 69, 0.22);
    --green-fg: var(--vscode-terminal-ansiGreen, #89d185);
    --red-bg: rgba(220, 53, 69, 0.22);
    --red-fg: var(--vscode-errorForeground, #f48771);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); padding: 16px; }
  h2 { font-size: 15px; margin-bottom: 12px; font-weight: 600; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  .filter-wrap { flex: 1; position: relative; }
  .filter-wrap input {
    width: 100%; padding: 6px 28px 6px 8px; border-radius: 3px;
    background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border);
    outline: none; font-size: 13px;
  }
  .filter-wrap input:focus { border-color: var(--btn-bg); }
  .clear-btn {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--fg); cursor: pointer;
    font-size: 14px; opacity: 0.6; display: none;
  }
  .clear-btn.show { display: block; }
  .clear-btn:hover { opacity: 1; }
  button.primary {
    padding: 5px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--btn-bg); color: var(--btn-fg); font-size: 12px;
  }
  button.primary:hover { background: var(--btn-hover); }
  button.danger {
    padding: 3px 8px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--danger-bg); color: #fff; font-size: 11px;
  }
  button.danger:hover { background: var(--danger-hover); }

  .group-header {
    padding: 6px 10px; background: var(--header-bg); font-weight: 600;
    cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); border-bottom: none; border-radius: 3px 3px 0 0;
    margin-top: 12px;
  }
  .group-header:first-of-type { margin-top: 0; }
  .group-header .arrow { transition: transform 0.15s; display: inline-block; }
  .group-header.collapsed .arrow { transform: rotate(-90deg); }
  .group-header .count { opacity: 0.6; font-weight: 400; font-size: 12px; }

  .table { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-top: none; }
  .table.hidden { display: none; }
  .table .th, .table .td { padding: 5px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  .table .th {
    background: var(--header-bg); font-weight: 600; cursor: pointer; user-select: none;
    position: sticky; top: 0; white-space: nowrap;
  }
  .table .th:hover { background: rgba(128,128,128,0.2); }
  .table .th .sort-arrow { margin-left: 4px; opacity: 0.5; font-size: 10px; }
  .table .row { display: contents; }
  .table .row:hover .td { background: var(--hover); }
  .table .row.config-running .td { background: var(--green-bg); color: var(--green-fg); }
  .table .row.config-idle .td { background: var(--red-bg); color: var(--red-fg); }
  .table .row.config-running:hover .td { background: rgba(40, 167, 69, 0.35); }
  .table .row.config-idle:hover .td { background: rgba(220, 53, 69, 0.35); }
  .table { display: grid; grid-template-columns: 70px 1fr 70px 1fr 80px 1fr 80px; }
  .empty { padding: 12px; text-align: center; opacity: 0.6; font-style: italic; border: 1px solid var(--border); border-top: none; }
  .empty.hint {
    text-align: left; padding: 14px 16px; opacity: 1; font-style: normal;
    background: var(--vscode-textBlockQuote-background, rgba(100,140,200,0.08));
    border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
    color: var(--fg); line-height: 1.5;
  }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; }
  .tag-green { background: rgba(40,167,69,0.3); color: var(--green-fg); }
  .tag-red { background: rgba(220,53,69,0.3); color: var(--red-fg); }
</style>
</head>
<body>
<h2>Listening Ports</h2>
<div class="toolbar">
  <div class="filter-wrap">
    <input id="filter" placeholder="Filter by port, process, PID, address…" autocomplete="off"/>
    <button class="clear-btn" id="clearFilter" title="Clear filter">✕</button>
  </div>
  <button class="primary" id="refreshBtn">Refresh</button>
</div>
<div id="root"></div>
<script>
const vscode = acquireVsCodeApi();
const ALL_ROWS = ${data};
const HAS_CONFIG = ${hasConfig};
const SHOW_PORT_HINT = ${showPortHint};
let sortCol = 'port';
let sortDir = 1; // 1 = asc, -1 = desc
let filter = '';

function render() {
  const root = document.getElementById('root');
  const filtered = ALL_ROWS.filter(r => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return String(r.port).includes(f)
      || r.address.toLowerCase().includes(f)
      || String(r.pid).includes(f)
      || r.processName.toLowerCase().includes(f)
      || (r.configName || '').toLowerCase().includes(f)
      || r.protocol.includes(f);
  });
  filtered.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return -1 * sortDir;
    if (va > vb) return  1 * sortDir;
    return 0;
  });
  const config = filtered.filter(r => r.group === 'config');
  const other  = filtered.filter(r => r.group === 'other');
  let html = '';
  // Empty-state message for the Configuration Ports group varies by reason:
  //   - filter is active → a simple "no matches" line
  //   - no config declared an explicit port → instructional hint
  //   - otherwise (user did set ports, but none are currently listening) → plain
  const configEmptyMsg = filter
    ? 'No ports in this group matching the filter.'
    : SHOW_PORT_HINT
      ? 'No configuration ports detected. Tip: open a run configuration and set the optional "Port" field so the port viewer can identify processes belonging to your configs — framework defaults alone (8080 for Spring Boot, 3000 for npm, …) aren\\'t reliable.'
      : 'None of your configured ports are currently listening.';
  html += renderGroup('Configuration Ports', config, HAS_CONFIG, configEmptyMsg, SHOW_PORT_HINT && !filter);
  html += renderGroup('Other Ports', other, !HAS_CONFIG, null, false);
  root.innerHTML = html;
  // wire listeners
  root.querySelectorAll('.group-header').forEach(h => {
    h.addEventListener('click', () => {
      h.classList.toggle('collapsed');
      const tbl = h.nextElementSibling;
      if (tbl) tbl.classList.toggle('hidden');
    });
  });
  root.querySelectorAll('.th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortDir *= -1;
      else { sortCol = col; sortDir = 1; }
      render();
    });
  });
  root.querySelectorAll('.kill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Confirmation is done by the extension host (native modal) because
      // window.confirm() is disabled inside VS Code webviews and returns
      // false silently. We just forward the intent.
      const pid = Number(btn.dataset.pid);
      const processName = btn.dataset.name || '';
      vscode.postMessage({ cmd: 'kill', pid, processName });
    });
  });
}

function renderGroup(title, rows, expanded, emptyMsg, hintStyle) {
  const cls = expanded ? '' : ' collapsed';
  const tblCls = expanded ? '' : ' hidden';
  let h = '<div class="group-header' + cls + '"><span class="arrow">▼</span> ' + title + ' <span class="count">(' + rows.length + ')</span></div>';
  h += '<div class="table' + tblCls + '">';
  h += headerRow();
  if (rows.length === 0) {
    const msg = emptyMsg || ('No ports in this group' + (filter ? ' matching the filter' : '') + '.');
    const cls = hintStyle ? 'empty hint' : 'empty';
    h += '</div><div class="' + cls + '">' + esc(msg) + '</div>';
    return h;
  }
  for (const r of rows) {
    const rowCls = r.group === 'config'
      ? (r.configRunning ? ' config-running' : ' config-idle')
      : '';
    h += '<div class="row' + rowCls + '">';
    h += '<div class="td">' + r.port + '</div>';
    h += '<div class="td">' + esc(r.address) + '</div>';
    h += '<div class="td">' + r.pid + '</div>';
    h += '<div class="td">' + esc(r.processName) + '</div>';
    h += '<div class="td">' + r.protocol + '</div>';
    h += '<div class="td">';
    if (r.configName) {
      const tag = r.configRunning ? 'tag-green' : 'tag-red';
      h += '<span class="tag ' + tag + '">' + esc(r.configName) + '</span>';
    }
    h += '</div>';
    h += '<div class="td">';
    if (r.pid > 0) {
      h += '<button class="danger kill-btn" data-pid="' + r.pid + '" data-name="' + esc(r.processName) + '">Kill</button>';
    }
    h += '</div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function headerRow() {
  const cols = [
    { key: 'port', label: 'Port' },
    { key: 'address', label: 'Address' },
    { key: 'pid', label: 'PID' },
    { key: 'processName', label: 'Process' },
    { key: 'protocol', label: 'Proto' },
    { key: 'configName', label: 'Config' },
    { key: '', label: 'Actions' },
  ];
  let h = '';
  for (const c of cols) {
    const arrow = c.key === sortCol ? (sortDir === 1 ? '▲' : '▼') : '';
    const attr = c.key ? ' data-col="' + c.key + '"' : '';
    h += '<div class="th"' + attr + '>' + c.label + (arrow ? '<span class="sort-arrow">' + arrow + '</span>' : '') + '</div>';
  }
  return h;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

document.getElementById('filter').addEventListener('input', e => {
  filter = e.target.value;
  document.getElementById('clearFilter').classList.toggle('show', filter.length > 0);
  render();
});
document.getElementById('clearFilter').addEventListener('click', () => {
  filter = '';
  document.getElementById('filter').value = '';
  document.getElementById('clearFilter').classList.remove('show');
  render();
});
document.getElementById('refreshBtn').addEventListener('click', () => {
  vscode.postMessage({ cmd: 'refresh' });
});
render();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
