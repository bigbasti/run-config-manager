import { useEffect, useRef, useState } from 'react';
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

interface TestResult {
  unresolved: string[];
  builtins: { workspaceFolder: string; userHome: string; cwd: string };
}

export function App() {
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [values, setValues] = useState<Partial<RunConfig>>({});
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [error, setError] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  // When non-null, a save is queued waiting for an async precondition (e.g.,
  // classpath recompute). We fire it after the precondition resolves.
  const pendingSaveRef = useRef<boolean>(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent<Inbound>) => {
      const msg = e.data;
      if (msg.cmd === 'init') {
        setMode(msg.mode);
        setSchema(msg.schema);
        setValues(msg.config);
        setPending(new Set(msg.pending ?? []));
        setError(null);
        setTestResult(null);
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
        // If the user clicked Save and we were waiting on recompute, fire the
        // save now with the fresh classpath.
        if (pendingSaveRef.current) {
          pendingSaveRef.current = false;
          setValues(v => {
            const next = v as any;
            if (!guardedSaveCheck(next, setError)) return v;
            post({ cmd: 'save', config: next as RunConfig });
            return v;
          });
        }
      } else if (msg.cmd === 'variablesTested') {
        setTesting(false);
        setTestResult({ unresolved: msg.unresolved, builtins: msg.builtins });
      } else if (msg.cmd === 'error') {
        setError(msg.message);
        setBusyActionId(null);
        setTesting(false);
        pendingSaveRef.current = false; // abandon any queued save
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

  const runTestVariables = () => {
    setError(null);
    setTestResult(null);
    setTesting(true);
    post({ cmd: 'testVariables', config: values as RunConfig });
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
          // Auto-recompute and save when it completes. Errors from recompute
          // arrive as cmd:'error' which clears pendingSaveRef.
          setError(null);
          setBusyActionId('recomputeClasspath');
          pendingSaveRef.current = true;
          post({ cmd: 'recomputeClasspath', config: values as RunConfig });
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
          {testResult && <TestResultPanel result={testResult} />}
          <div className="side-actions">
            <button
              className="secondary icon-button"
              title="Test variables — resolve every field and report any unresolved ${VAR} references"
              disabled={testing}
              onClick={runTestVariables}
              aria-label="Test variables"
            >
              {testing ? '⟳' : 'ⓘ ✓'}
            </button>
            <button className="secondary" onClick={() => post({ cmd: 'cancel' })}>Cancel</button>
            <button
              onClick={save}
              disabled={busyActionId === 'recomputeClasspath' && pendingSaveRef.current}
            >
              {busyActionId === 'recomputeClasspath' && pendingSaveRef.current ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Mirror of the server-side guards used by `save` so the queued-save path can
// re-check without duplicating logic — returns true if the config is ready
// to save right now.
function guardedSaveCheck(values: any, setError: (s: string | null) => void): boolean {
  if (!values.name || !values.name.trim()) { setError('Name is required'); return false; }
  if (values.type === 'spring-boot' && values.typeOptions?.launchMode === 'java-main') {
    const cp = values.typeOptions.classpath ?? '';
    if (classpathLooksLikeHint(cp)) {
      setError('Classpath recompute did not return a usable classpath.');
      return false;
    }
  }
  return true;
}

function TestResultPanel({ result }: { result: TestResult }) {
  return (
    <aside className="help-panel" aria-live="polite">
      <h4>Variable resolution</h4>
      {result.unresolved.length === 0 ? (
        <p style={{ color: 'var(--vscode-terminal-ansiGreen, currentColor)' }}>
          ✓ All variables resolved.
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--vscode-errorForeground)', marginBottom: 6 }}>
            ⚠ {result.unresolved.length} unresolved — these will expand to empty strings at launch:
          </p>
          <ul className="examples" style={{ marginBottom: 10 }}>
            {result.unresolved.map(v => <li key={v}>{`\${${v}}`}</li>)}
          </ul>
        </>
      )}
      <p className="empty" style={{ marginBottom: 4 }}>Builtins used in this test:</p>
      <ul className="examples">
        <li>{`\${workspaceFolder} = ${result.builtins.workspaceFolder || '(empty)'}`}</li>
        <li>{`\${cwd} = ${result.builtins.cwd || '(empty)'}`}</li>
        <li>{`\${userHome} = ${result.builtins.userHome || '(empty)'}`}</li>
      </ul>
    </aside>
  );
}
