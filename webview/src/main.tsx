import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root')!;

// MonitorPanel renders `<div id="root" data-view="monitor" data-config-id="..."
// data-config-name="...">` so we can read the view selection + monitor
// arguments from the dataset under a strict CSP (no inline script needed).
// EditorPanel and friends leave `data-view` unset and fall through to the
// standard editor App.
//
// We dynamic-import the entry components so only the chosen one's bundle
// executes — `acquireVsCodeApi()` may only be called once per webview, and
// both App and MonitorView call it at module load.
const view = root.dataset.view;
if (view === 'monitor') {
  const configId = root.dataset.configId ?? '';
  const configName = root.dataset.configName ?? '';
  const ownPackage = root.dataset.ownPackage ?? '';
  void import('./MonitorView').then(({ MonitorView }) => {
    createRoot(root).render(
      <MonitorView configId={configId} configName={configName} ownPackage={ownPackage} />
    );
  });
} else {
  void import('./App').then(({ App }) => {
    createRoot(root).render(<App />);
  });
}
