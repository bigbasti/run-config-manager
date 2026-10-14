import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { MonitorView } from './MonitorView';
import { NodeMonitorView } from './NodeMonitorView';

const root = document.getElementById('root')!;

// Surface startup failures instead of leaving the webview blank.
function showFatal(err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error('[run-config-manager] webview error:', err);
  const pre = document.createElement('pre');
  pre.style.color = 'var(--vscode-errorForeground)';
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = `Failed to load view:\n${msg}`;
  root.appendChild(pre);
}
window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

// MonitorPanel renders `<div id="root" data-view="monitor" data-config-id="..."
// data-config-name="...">` so we can read the view selection + monitor
// arguments from the dataset under a strict CSP (no inline script needed).
// EditorPanel and friends leave `data-view` unset and fall through to the
// standard editor App. Everything is bundled into a single script (no lazy
// chunks) because newer VS Code webviews may fail to load dynamic imports.
try {
  const view = root.dataset.view;
  if (view === 'monitor') {
    const configId = root.dataset.configId ?? '';
    const configName = root.dataset.configName ?? '';
    const ownPackage = root.dataset.ownPackage ?? '';
    const runtime = root.dataset.runtime ?? 'jvm';
    createRoot(root).render(
      runtime === 'node'
        ? <NodeMonitorView configId={configId} configName={configName} />
        : <MonitorView configId={configId} configName={configName} ownPackage={ownPackage} />
    );
  } else {
    createRoot(root).render(<App />);
  }
} catch (err) {
  showFatal(err);
}
