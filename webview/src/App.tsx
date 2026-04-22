import { useEffect, useState } from 'react';
import type { RunConfig } from '../../src/shared/types';
import type { FormSchema } from '../../src/shared/formSchema';
import type { Inbound, Outbound } from '../../src/shared/protocol';
import { ConfigForm } from './ConfigForm';
import { HelpPanel } from './HelpPanel';

declare function acquireVsCodeApi(): { postMessage(msg: Outbound): void; getState<T>(): T; setState<T>(s: T): void };

const vscode = acquireVsCodeApi();
function post(msg: Outbound) { vscode.postMessage(msg); }

// The hint emitted by suggestClasspath contains a `/*` glob that isn't valid
// as a literal classpath entry — treat it (and empty) as "not yet computed".
function classpathLooksLikeHint(cp: string): boolean {
  return cp.trim() === '' || /\/\*(\s*[:;]|\s*$)/.test(cp)
    || cp.includes('target/dependency/*') || cp.includes('build/libs/*');
}

// Merge detected defaults into a Partial<RunConfig>, but only where the target
// slot is currently blank. Preserves anything the user has already typed.
function mergeBlanks<T extends Record<string, any>>(cur: T, patch: any): T {
  if (!patch || typeof patch !== 'object') return cur;
  const out: any = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    const existing = cur[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeBlanks(existing ?? {}, v);
    } else if (existing === undefined || existing === null || existing === '') {
      out[k] = v;
    }
  }
  return out;
}

export function App() {
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [values, setValues] = useState<Partial<RunConfig>>({});
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [error, setError] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onMessage = (e: MessageEvent<Inbound>) => {
      const msg = e.data;
      if (msg.cmd === 'init') {
        setMode(msg.mode);
        setSchema(msg.schema);
        setValues(msg.config);
        setPending(new Set(msg.pending ?? []));
        setError(null);
        // Auto-recompute classpath in java-main mode when the current value looks
        // like the hint. Avoids launching against the placeholder.
        if (msg.config.type === 'spring-boot') {
          const to = msg.config.typeOptions as { launchMode?: string; classpath?: string } | undefined;
          if (to?.launchMode === 'java-main' && classpathLooksLikeHint(to.classpath ?? '')) {
            setBusyActionId('recomputeClasspath');
            post({ cmd: 'recomputeClasspath', config: msg.config as RunConfig });
          }
        }
      } else if (msg.cmd === 'schemaUpdate') {
        setSchema(msg.schema);
        setPending(new Set(msg.pending ?? []));
      } else if (msg.cmd === 'configPatch') {
        // Merge in detected defaults, but only for fields the user hasn't
        // already touched (= currently empty / undefined).
        setValues(v => mergeBlanks(v, msg.patch));
      } else if (msg.cmd === 'folderPicked') {
        setValues(v => ({ ...v, projectPath: msg.path }));
      } else if (msg.cmd === 'classpathComputed') {
        setValues(v => {
          if (v.type !== 'spring-boot') return v;
          return {
            ...v,
            typeOptions: { ...(v.typeOptions as any), classpath: msg.classpath },
          } as any;
        });
        setBusyActionId(null);
      } else if (msg.cmd === 'error') {
        setError(msg.message);
        setBusyActionId(null);
      }
    };
    window.addEventListener('message', onMessage);
    post({ cmd: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const onFieldAction = (actionId: string) => {
    if (actionId === 'recomputeClasspath') {
      setBusyActionId(actionId);
      setError(null);
      post({ cmd: 'recomputeClasspath', config: values as RunConfig });
    }
  };

  if (!schema) return <div>Loading…</div>;

  const save = () => {
    if (!values.name || !values.name.trim()) {
      setError('Name is required');
      return;
    }
    if (values.type === 'npm') {
      const to = values.typeOptions as { scriptName?: string } | undefined;
      const script = to?.scriptName?.trim();
      if (!script) {
        setError('Script is required. If your package.json has no scripts, type the command name (e.g. "start").');
        return;
      }
    }
    if (values.type === 'spring-boot') {
      const to = values.typeOptions as { launchMode?: string; classpath?: string; mainClass?: string } | undefined;
      if (to?.launchMode === 'java-main') {
        if (!to.mainClass?.trim()) {
          setError('Main class is required for java-main launch mode.');
          return;
        }
        const cp = to.classpath ?? '';
        if (classpathLooksLikeHint(cp)) {
          setError('Classpath is empty or still the placeholder hint. Click "Recompute classpath" next to the field to populate it from your build tool before saving.');
          return;
        }
      }
    }
    post({ cmd: 'save', config: values as RunConfig });
  };

  return (
    <>
      <h2>{mode === 'create' ? 'New run configuration' : 'Edit run configuration'}</h2>
      {error && <div style={{ color: 'var(--vscode-errorForeground)', marginBottom: 8 }}>{error}</div>}
      <div className="container">
        <ConfigForm
          schema={schema}
          values={values}
          onChange={setValues}
          onPickFolder={() => post({ cmd: 'pickFolder', current: values.projectPath })}
          onFocusField={setFocusedKey}
          onFieldAction={onFieldAction}
          busyActionId={busyActionId}
          pending={pending}
        />
        <div className="side-column">
          <HelpPanel schema={schema} focusedKey={focusedKey} />
          <div className="side-actions">
            <button className="secondary" onClick={() => post({ cmd: 'cancel' })}>Cancel</button>
            <button onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </>
  );
}
