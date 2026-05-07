import { useEffect, useRef, useState } from 'react';
import type { RunConfig } from '../../src/shared/types';
import type { FormField, FormSchema } from '../../src/shared/formSchema';
import { getPath } from './state';
import type { Inbound, Outbound } from '../../src/shared/protocol';
import { ConfigForm } from './ConfigForm';
import { HelpPanel } from './HelpPanel';
import { BuildToolSettingsPanel, buildToolForConfig } from './BuildToolSettingsPanel';
import { JdkDownloadDialog } from './JdkDownloadDialog';
import { TomcatDownloadDialog } from './TomcatDownloadDialog';
import { MavenDownloadDialog } from './MavenDownloadDialog';
import { GradleDownloadDialog } from './GradleDownloadDialog';
import { LoadingDialog } from './LoadingDialog';
import type { EnvFileStatus } from './form/EnvFileList';
import type { TomcatVersionDto, MavenVersionDto, GradleVersionDto } from '../../src/shared/protocol';
import type { JdkPackageDto } from '../../src/shared/protocol';

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
  // JDK download dialog state. `payload` is non-null while the dialog is
  // open; it carries the initial distro list + first distro's packages so
  // the dialog can render without an empty intermediate state.
  const [jdkDialog, setJdkDialog] = useState<{
    distros: Array<{ apiName: string; label: string }>;
    initialPackages: Record<string, JdkPackageDto[]>;
    installRoot: string;
  } | null>(null);
  // Tomcat download dialog state — same pattern as JDK.
  const [tomcatDialog, setTomcatDialog] = useState<{
    majors: Array<{ major: number; label: string }>;
    initialVersions: Record<number, TomcatVersionDto[]>;
    installRoot: string;
  } | null>(null);
  const [mavenDialog, setMavenDialog] = useState<{
    majors: Array<{ major: number; label: string }>;
    initialVersions: Record<number, MavenVersionDto[]>;
    installRoot: string;
  } | null>(null);
  const [gradleDialog, setGradleDialog] = useState<{
    versions: GradleVersionDto[];
    installRoot: string;
  } | null>(null);
  // "Pending" flag set the instant the user clicks a cloud button.
  // Renders an immediate loading dialog so the UI doesn't appear frozen
  // while the extension fetches the version list (foojay / Apache /
  // services.gradle.org can take several seconds, especially on cold
  // DNS). Cleared when the actual list reply arrives, OR by an error
  // reply, OR by the user clicking Cancel on the loading shell.
  const [loadingDialog, setLoadingDialog] = useState<
    null | 'jdk' | 'tomcat' | 'maven' | 'gradle'
  >(null);
  // Mirror of loadingDialog readable from the empty-deps message handler
  // below (which captures stale state otherwise). Updated in lockstep.
  const loadingDialogRef = useRef<typeof loadingDialog>(null);
  useEffect(() => { loadingDialogRef.current = loadingDialog; }, [loadingDialog]);
  // Subscriber list for the dialog's stream view of inbound messages.
  // App.tsx forwards anything it doesn't handle locally so the dialog can
  // listen without us re-dispatching every message kind.
  const dialogSubscribersRef = useRef<Set<(m: Inbound) => void>>(new Set());

  // Env file load status, keyed by path. Refreshed every time the
  // envFiles array on the config changes (init, configPatch, add/remove)
  // so the list pills always reflect the current files-on-disk state —
  // including the "missing" red flag the user gets when they edit a
  // saved config whose .env file moved or was deleted.
  const [envFileStatus, setEnvFileStatus] = useState<Map<string, EnvFileStatus>>(new Map());
  // Track the last envFiles list we asked the extension to load. Lets us
  // dedupe so a re-render that doesn't change the list doesn't trigger
  // another round-trip.
  const lastEnvFilesKeyRef = useRef<string>('');

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
      } else if (msg.cmd === 'envFilePicked') {
        // User picked a file in the OS dialog. Append to the current
        // envFiles array on the config; the auto-load effect picks it up.
        setValues(prev => {
          const existing = ((prev as any).envFiles as string[] | undefined) ?? [];
          // De-dupe: clicking Add twice with the same file shouldn't add
          // it twice.
          if (existing.includes(msg.path)) return prev;
          return { ...(prev as any), envFiles: [...existing, msg.path] };
        });
      } else if (msg.cmd === 'envFilesLoaded') {
        const next = new Map<string, EnvFileStatus>();
        for (const f of msg.files) {
          next.set(f.path, {
            path: f.path,
            loaded: f.loaded,
            count: f.count,
            variables: f.variables,
            ...(f.error ? { error: f.error } : {}),
            ...(f.errorDetail ? { errorDetail: f.errorDetail } : {}),
          });
        }
        setEnvFileStatus(next);
      } else if (msg.cmd === 'jdkDownloadList') {
        // Server replied to our `listJdkDownloads` — open the dialog. The
        // dialog will later post messages directly via `post()` and listen
        // through the dialog subscribers ref below.
        setLoadingDialog(prev => (prev === 'jdk' ? null : prev));
        setJdkDialog({
          distros: msg.distros,
          initialPackages: msg.packagesByDistro,
          installRoot: msg.installRoot,
        });
      } else if (msg.cmd === 'tomcatDownloadList') {
        setLoadingDialog(prev => (prev === 'tomcat' ? null : prev));
        setTomcatDialog({
          majors: msg.majors,
          initialVersions: msg.versionsByMajor,
          installRoot: msg.installRoot,
        });
      } else if (msg.cmd === 'mavenDownloadList') {
        setLoadingDialog(prev => (prev === 'maven' ? null : prev));
        setMavenDialog({
          majors: msg.majors,
          initialVersions: msg.versionsByMajor,
          installRoot: msg.installRoot,
        });
      } else if (msg.cmd === 'gradleDownloadList') {
        setLoadingDialog(prev => (prev === 'gradle' ? null : prev));
        setGradleDialog({
          versions: msg.versions,
          installRoot: msg.installRoot,
        });
      } else if (
        msg.cmd === 'jdkPackageList'
        || msg.cmd === 'jdkDownloadProgress'
        || msg.cmd === 'jdkDownloadComplete'
        || msg.cmd === 'jdkDownloadError'
        || msg.cmd === 'jdkDownloadNeedsConfirmation'
        || msg.cmd === 'tomcatVersionList'
        || msg.cmd === 'tomcatDownloadProgress'
        || msg.cmd === 'tomcatDownloadComplete'
        || msg.cmd === 'tomcatDownloadError'
        || msg.cmd === 'mavenVersionList'
        || msg.cmd === 'mavenDownloadProgress'
        || msg.cmd === 'mavenDownloadComplete'
        || msg.cmd === 'mavenDownloadError'
        || msg.cmd === 'gradleDownloadProgress'
        || msg.cmd === 'gradleDownloadComplete'
        || msg.cmd === 'gradleDownloadError'
      ) {
        // If the loading shell is still up (i.e. the listing fetch failed
        // before the real dialog mounted), the *DownloadError reply has
        // to dismiss it here — there's no subscriber yet to forward to.
        // We also surface the message via the form's error banner so the
        // user knows what happened.
        const cur = loadingDialogRef.current;
        if (msg.cmd === 'jdkDownloadError' && cur === 'jdk') {
          setLoadingDialog(null);
          setError(msg.message);
        } else if (msg.cmd === 'tomcatDownloadError' && cur === 'tomcat') {
          setLoadingDialog(null);
          setError(msg.message);
        } else if (msg.cmd === 'mavenDownloadError' && cur === 'maven') {
          setLoadingDialog(null);
          setError(msg.message);
        } else if (msg.cmd === 'gradleDownloadError' && cur === 'gradle') {
          setLoadingDialog(null);
          setError(msg.message);
        }
        // Forward to dialog subscribers (the open dialog). Nothing in App
        // itself needs these messages; the configPatch/schemaUpdate that
        // arrive alongside `*DownloadComplete` already update the form.
        for (const sub of dialogSubscribersRef.current) sub(msg);
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

  // Reload .env file status whenever the envFiles array changes. Fires on
  // init (so editing a saved config shows accurate counts and a red row
  // for any file that's gone missing on disk), on configPatch streaming,
  // and on every add/remove. Cheap — a few KB of disk per file.
  useEffect(() => {
    const list = ((values as any).envFiles as string[] | undefined) ?? [];
    const key = list.join('');
    if (lastEnvFilesKeyRef.current === key) return;
    lastEnvFilesKeyRef.current = key;
    if (list.length === 0) {
      setEnvFileStatus(new Map());
      return;
    }
    post({ cmd: 'loadEnvFiles', paths: list });
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
    if (actionId === 'openJdkDownload') {
      // Show the loading shell immediately so users get feedback while
      // the extension hits foojay; the real dialog mounts when
      // `jdkDownloadList` arrives.
      setLoadingDialog('jdk');
      post({ cmd: 'listJdkDownloads' });
      return;
    }
    if (actionId === 'openTomcatDownload') {
      setLoadingDialog('tomcat');
      post({ cmd: 'listTomcatDownloads' });
      return;
    }
    if (actionId === 'openMavenDownload') {
      setLoadingDialog('maven');
      post({ cmd: 'listMavenDownloads' });
      return;
    }
    if (actionId === 'openGradleDownload') {
      setLoadingDialog('gradle');
      post({ cmd: 'listGradleDownloads' });
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
          envFileStatus={envFileStatus}
          onAddEnvFile={() => post({ cmd: 'pickEnvFile' })}
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
          {/* HTTP Request configs get an extra "Execute" button so users
              can fire the request without saving first. The button posts
              the current form values to the extension, which runs them
              through HttpRequestRunner exactly like a saved-and-clicked
              run would. Hidden for every other config type — they have
              long-running side effects that don't suit a try-without-
              saving flow. */}
          {values.type === 'http-request' && (
            <div className="side-actions" style={{ marginTop: 6 }}>
              <button
                title="Run this HTTP request now using the current (possibly unsaved) form values."
                onClick={() => {
                  setError(null);
                  post({ cmd: 'executeUnsaved', config: values as RunConfig });
                }}
              >
                ▶ Execute
              </button>
            </div>
          )}
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
      {/* Loading shell — rendered the instant the user clicks a cloud
          button, before the real dialog has any data. We only show it
          while no real dialog of the same kind is mounted yet. */}
      {loadingDialog === 'jdk' && !jdkDialog && (
        <LoadingDialog
          title="Download a JDK"
          detail="Fetching available distributions from foojay.io…"
          onClose={() => setLoadingDialog(null)}
        />
      )}
      {loadingDialog === 'tomcat' && !tomcatDialog && (
        <LoadingDialog
          title="Download Apache Tomcat"
          detail="Reading the Apache directory listing…"
          onClose={() => setLoadingDialog(null)}
        />
      )}
      {loadingDialog === 'maven' && !mavenDialog && (
        <LoadingDialog
          title="Download Apache Maven"
          detail="Reading the Apache archive listing…"
          onClose={() => setLoadingDialog(null)}
        />
      )}
      {loadingDialog === 'gradle' && !gradleDialog && (
        <LoadingDialog
          title="Download Gradle"
          detail="Fetching versions from services.gradle.org…"
          onClose={() => setLoadingDialog(null)}
        />
      )}
      {jdkDialog && (
        <JdkDownloadDialog
          distros={jdkDialog.distros}
          initialPackages={jdkDialog.initialPackages}
          installRoot={jdkDialog.installRoot}
          post={post}
          onMessage={handler => {
            dialogSubscribersRef.current.add(handler);
            return () => { dialogSubscribersRef.current.delete(handler); };
          }}
          onClose={() => setJdkDialog(null)}
        />
      )}
      {tomcatDialog && (
        <TomcatDownloadDialog
          majors={tomcatDialog.majors}
          initialVersions={tomcatDialog.initialVersions}
          installRoot={tomcatDialog.installRoot}
          post={post}
          onMessage={handler => {
            dialogSubscribersRef.current.add(handler);
            return () => { dialogSubscribersRef.current.delete(handler); };
          }}
          onClose={() => setTomcatDialog(null)}
        />
      )}
      {mavenDialog && (
        <MavenDownloadDialog
          majors={mavenDialog.majors}
          initialVersions={mavenDialog.initialVersions}
          installRoot={mavenDialog.installRoot}
          post={post}
          onMessage={handler => {
            dialogSubscribersRef.current.add(handler);
            return () => { dialogSubscribersRef.current.delete(handler); };
          }}
          onClose={() => setMavenDialog(null)}
        />
      )}
      {gradleDialog && (
        <GradleDownloadDialog
          versions={gradleDialog.versions}
          installRoot={gradleDialog.installRoot}
          post={post}
          onMessage={handler => {
            dialogSubscribersRef.current.add(handler);
            return () => { dialogSubscribersRef.current.delete(handler); };
          }}
          onClose={() => setGradleDialog(null)}
        />
      )}
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
