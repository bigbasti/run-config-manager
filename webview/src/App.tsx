import { useEffect, useState } from 'react';
import type { RunConfig } from '../../src/shared/types';
import type { FormSchema } from '../../src/shared/formSchema';
import type { Inbound, Outbound } from '../../src/shared/protocol';
import { ConfigForm } from './ConfigForm';

// VS Code webview API handle (injected by the webview host).
declare function acquireVsCodeApi(): { postMessage(msg: Outbound): void; getState<T>(): T; setState<T>(s: T): void };

const vscode = acquireVsCodeApi();

function post(msg: Outbound) { vscode.postMessage(msg); }

export function App() {
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [values, setValues] = useState<Partial<RunConfig>>({});
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent<Inbound>) => {
      const msg = e.data;
      if (msg.cmd === 'init') {
        setMode(msg.mode);
        setSchema(msg.schema);
        setValues(msg.config);
        setError(null);
      } else if (msg.cmd === 'folderPicked') {
        setValues(v => ({ ...v, projectPath: msg.path }));
      } else if (msg.cmd === 'error') {
        setError(msg.message);
      }
    };
    window.addEventListener('message', onMessage);
    post({ cmd: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!schema) return <div>Loading…</div>;

  const save = () => {
    // Minimal validation: name required.
    if (!values.name || !values.name.trim()) {
      setError('Name is required');
      return;
    }
    post({ cmd: 'save', config: values as RunConfig });
  };

  return (
    <>
      <h2>{mode === 'create' ? 'New run configuration' : 'Edit run configuration'}</h2>
      {error && <div style={{ color: 'var(--vscode-errorForeground)', marginBottom: 8 }}>{error}</div>}
      <ConfigForm
        schema={schema}
        values={values}
        onChange={setValues}
        onPickFolder={() => post({ cmd: 'pickFolder', current: values.projectPath })}
      />
      <div className="footer">
        <button className="secondary" onClick={() => post({ cmd: 'cancel' })}>Cancel</button>
        <button onClick={save}>Save</button>
      </div>
    </>
  );
}
