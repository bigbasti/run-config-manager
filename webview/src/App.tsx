import { useEffect, useRef, useState } from 'react';
import type { RunConfig } from '../../src/shared/types';
import type { FormField, FormSchema } from '../../src/shared/formSchema';
import { getPath } from './state';
import type { Inbound, Outbound } from '../../src/shared/protocol';
import { ConfigForm } from './ConfigForm';
import { HelpPanel } from './HelpPanel';
import { BuildToolSettingsPanel, buildToolForConfig } from './BuildToolSettingsPanel';

declare function acquireVsCodeApi(): { postMessage(msg: Outbound): void; getState<T>(): T; setState<T>(s: T): void };

const vscode = acquireVsCodeApi();
function post(msg: Outbound) { vscode.postMessage(msg); }

// Returns the buildTool a folderPath field opted into validation for, or
// null if it didn't. Hoisted out of the component so the auto-validation
// effect stays readable.
function fieldValidateBuildPath(f: FormField): 'maven' | 'gradle' | 'either' | null {
  if (f.kind !== 'folderPath') return null;
  return f.validateBuildPath ?? null;
}

// Flatten every field key the schema actually renders — used when posting
// server-side fieldErrors so we can tell the user when an error targets a
// key nothing in the form listens for (the bug where Zod complained about
// an internal field like `id` and the banner named nothing).
function renderedFieldKeys(schema: FormSchema | null): Set<string> {
  if (!schema) return new Set();
  const all = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
  return new Set(all.map(f => f.key));
}

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
  // Absolute workspace folder path, delivered on init. The command preview
  // uses it to compute the real cwd (buildRoot for JVM configs) and the
  // Gradle `:module:task` prefix for submodule configs.
  const [workspaceFolderPath, setWorkspaceFolderPath] = useState<string | undefined>(undefined);
  // Validation results for folderPath fields with `validateBuildPath`.
  // null = valid, {reason, suggestion?} = warn under the input. The map
  // is keyed on field.key; entries persist until the next blur of the
  // same field rewrites them.
  const [pathWarnings, setPathWarnings] = useState<Map<string, { reason: string; suggestion?: string } | null>>(new Map());
  // Server-side validation errors keyed by dotted field key. Populated by
  // `fieldErrors` inbound messages (post-save rejection, Fix-invalid flow)
  // and cleared on the next successful save or when the user edits the
  // offending field — see onChange wrapper below.
  const [fieldErrors, setFieldErrors] = useState<Map<string, string>>(new Map());
  // Build-tool settings panel state. `settings` holds the most recent reply
  // from the extension; `settingsLoading` indicates a fetch is in flight so
  // we can show a brief "Reading…" placeholder on first render.
  const [settings, setSettings] = useState<Extract<Inbound, { cmd: 'buildToolSettings' }> | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  // When non-null, a save is queued waiting for an async precondition (e.g.,
  // classpath recompute). We fire it after the precondition resolves.
  const pendingSaveRef = useRef<boolean>(false);
  // Tracks the last projectPath we asked the extension to validate, keyed
  // on field key. Lets us dedupe the auto-revalidation effect below so we
  // don't flood the extension when an unrelated field re-renders.
  const lastValidatedRef = useRef<Map<string, string>>(new Map());
  // Latest schema, readable from the one-time message listener (which
  // captured stale state on mount). Used so fieldErrors can name fields that
  // don't render as inputs — otherwise the banner would show a count with
  // no red border anywhere on the form.
  const schemaRef = useRef<FormSchema | null>(null);
  useEffect(() => { schemaRef.current = schema; }, [schema]);

  useEffect(() => {
    const onMessage = (e: MessageEvent<Inbound>) => {
      const msg = e.data;
      if (msg.cmd === 'init') {
        setMode(msg.mode);
        setSchema(msg.schema);
        setValues(msg.config);
        setPending(new Set(msg.pending ?? []));
        setWorkspaceFolderPath(msg.workspaceFolderPath);
        setError(null);
        setTestResult(null);
        // The Fix-flow may push fieldErrors right after init; clear first
        // so any stale errors from a previous edit don't linger when the
        // singleton panel is reused.
        setFieldErrors(new Map());
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
        // Action buttons other than recomputeClasspath (which has its own
        // 'classpathComputed' reply path) reply via schemaUpdate carrying
        // newly-populated options. Clear the busy flag using a functional
        // updater so we always see fresh state even if the message listener
        // captured stale props.
        setBusyActionId(prev => (prev === 'recomputeClasspath' ? prev : null));
      } else if (msg.cmd === 'configPatch') {
        // Streaming detection uses blanks-only merge so user edits never
        // get clobbered. Profile-triggered re-detects set `force: true` to
        // actually update (because the new value IS authoritative for the
        // newly-picked profile).
        setValues(v => msg.force
          ? ({ ...v, ...msg.patch } as Partial<RunConfig>)
          : mergeBlanks(v, msg.patch));
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
      } else if (msg.cmd === 'fieldErrors') {
        const next = new Map<string, string>();
        for (const e of msg.errors) next.set(e.fieldKey, e.message);
        setFieldErrors(next);
        // Also surface a short banner so the user notices the errors
        // without having to scan for red borders. If an error targets a
        // field that isn't rendered in the current form (e.g. a validator
        // keyed something on a hidden field), spell it out in the banner so
        // the user isn't left hunting for an invisible red border.
        if (msg.errors.length > 0) {
          const rendered = renderedFieldKeys(schemaRef.current);
          const orphaned = msg.errors.filter(e => !rendered.has(e.fieldKey));
          if (orphaned.length > 0) {
            const detail = orphaned
              .map(e => `${e.fieldKey}: ${e.message}`)
              .join('; ');
            setError(`Can't save — ${detail}`);
          } else if (msg.errors.length === 1) {
            setError(`Can't save: 1 field needs attention.`);
          } else {
            setError(`Can't save: ${msg.errors.length} fields need attention.`);
          }
        } else {
          setError(null);
        }
      } else if (msg.cmd === 'projectPathValidated') {
        setPathWarnings(prev => {
          const next = new Map(prev);
          if (msg.ok) {
            next.set(msg.fieldKey, null);
          } else {
            next.set(msg.fieldKey, { reason: msg.reason ?? '', suggestion: msg.suggestion });
          }
          return next;
        });
      } else if (msg.cmd === 'buildToolSettings') {
        setSettings(msg);
        setSettingsLoading(false);
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

  // Auto-validate every folderPath field that declared `validateBuildPath`
  // whenever the schema loads, a streaming update arrives, or the user's
  // value for such a field changes (e.g. clicking "Use (workspace root)"
  // re-runs validation on the new value, clearing the warning). Blur-only
  // validation would miss both the initial render and the post-apply
  // case — users never focus a field whose prefilled value they intend to
  // keep, and they never re-focus after clicking the suggestion button.
  useEffect(() => {
    if (!schema) return;
    const fields = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
    for (const f of fields) {
      const target = fieldValidateBuildPath(f);
      if (!target) continue;
      const current = (getPath(values, f.key) as string | undefined) ?? '';
      if (lastValidatedRef.current.get(f.key) === current) continue;
      lastValidatedRef.current.set(f.key, current);
      post({ cmd: 'validateProjectPath', fieldKey: f.key, projectPath: current, buildTool: target });
    }
  }, [schema, values]);

  // Docker: whenever the selected containerId changes, ask the extension for
  // fresh inspect data. The extension re-emits the schema with the info
  // panel populated. Deduped per-id so we don't flood the daemon when an
  // unrelated field re-renders.
  const lastInspectedRef = useRef<string>('');
  useEffect(() => {
    if (values.type !== 'docker') return;
    const id = (values.typeOptions as { containerId?: string } | undefined)?.containerId ?? '';
    if (!id) return;
    if (lastInspectedRef.current === id) return;
    lastInspectedRef.current = id;
    post({ cmd: 'inspectContainer', containerId: id });
  }, [values]);

  // Re-fetch the Maven/Gradle settings panel data whenever the effective
  // build tool changes (the project path for Gradle, since a project-root
  // gradle.properties may exist even without a user-home one), or the
  // selected install path (Maven: $mavenPath/conf/settings.xml is the
  // global fallback; Gradle: $gradlePath/gradle.properties is a lowest-
  // precedence fallback). Clear any stale data the moment the panel is no
  // longer applicable so we don't flash last-edit's Maven info when the
  // user switches to a Gradle project.
  const lastSettingsKeyRef = useRef<string>('');
  useEffect(() => {
    const buildTool = buildToolForConfig(values);
    if (!buildTool) {
      if (settings !== null) setSettings(null);
      lastSettingsKeyRef.current = '';
      return;
    }
    const projectPath = (values.projectPath as string | undefined) ?? '';
    const to = (values.typeOptions as { mavenPath?: string; gradlePath?: string } | undefined) ?? {};
    const mavenPath = buildTool === 'maven' ? (to.mavenPath ?? '') : '';
    const gradlePath = buildTool === 'gradle' ? (to.gradlePath ?? '') : '';
    const key = `${buildTool}::${projectPath}::${mavenPath}::${gradlePath}`;
    if (lastSettingsKeyRef.current === key) return;
    lastSettingsKeyRef.current = key;
    setSettingsLoading(true);
    post({
      cmd: 'loadBuildToolSettings',
      buildTool,
      projectPath,
      ...(mavenPath ? { mavenPath } : {}),
      ...(gradlePath ? { gradlePath } : {}),
    });
  }, [values, settings]);

  // Spring Boot / Quarkus: re-run port detection whenever the profile(s) the
  // user selected change. The extension reads the matching
  // application-<profile>.{properties,yml} and replies with a configPatch
  // setting `port`. Deduped so we only round-trip on a real change.
  const lastProfileDetectRef = useRef<string>('');
  useEffect(() => {
    if (values.type !== 'spring-boot' && values.type !== 'quarkus') return;
    const to = values.typeOptions as { profiles?: string; profile?: string } | undefined;
    const profileKey = to?.profiles ?? to?.profile ?? '';
    if (lastProfileDetectRef.current === profileKey) return;
    lastProfileDetectRef.current = profileKey;
    post({ cmd: 'detectPort', config: values as RunConfig });
  }, [values]);

  const onValidatePath = (fieldKey: string, buildTool: 'maven' | 'gradle' | 'either', p: string) => {
    // Manual trigger (blur). Bypass the dedupe ref so an explicit blur
    // always gets a fresh answer, even if we validated that same value
    // on init.
    lastValidatedRef.current.set(fieldKey, p);
    post({ cmd: 'validateProjectPath', fieldKey, projectPath: p, buildTool });
  };

  const onFieldAction = (actionId: string) => {
    if (actionId === 'recomputeClasspath') {
      setBusyActionId(actionId);
      setError(null);
      post({ cmd: 'recomputeClasspath', config: values as RunConfig });
      return;
    }
    // loadTasks (Gradle Task) and loadGoals (Maven Goal) both post the same
    // outbound message — the extension dispatches based on cfg.type. Busy
    // state is cleared when the extension replies with schemaUpdate.
    if (actionId === 'loadTasks' || actionId === 'loadGoals') {
      setBusyActionId(actionId);
      setError(null);
      post({ cmd: 'loadTasks', config: values as RunConfig });
      return;
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
          workspaceFolderPath={workspaceFolderPath}
          onChange={next => {
            setValues(next);
            // Clear server-side field errors whenever the form is edited.
            // The next save triggers fresh validation; stale red borders
            // from a previously-rejected save shouldn't linger.
            if (fieldErrors.size > 0) {
              setFieldErrors(new Map());
              setError(null);
            }
          }}
          onPickFolder={() => post({ cmd: 'pickFolder', current: values.projectPath })}
          onFocusField={setFocusedKey}
          onFieldAction={onFieldAction}
          busyActionId={busyActionId}
          pending={pending}
          pathWarnings={pathWarnings}
          onValidatePath={onValidatePath}
          fieldErrors={fieldErrors}
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
          {(() => {
            const bt = buildToolForConfig(values);
            if (!bt) return null;
            return (
              <BuildToolSettingsPanel
                buildTool={bt}
                data={settings && settings.buildTool === bt ? settings : null}
                loading={settingsLoading}
                onOpenFile={filePath => post({ cmd: 'openSettingsFile', filePath })}
              />
            );
          })()}
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
