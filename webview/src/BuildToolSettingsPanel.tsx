import { useState } from 'react';
import type { Inbound } from '../../src/shared/protocol';

// Content of the "Maven Settings" / "Gradle Settings" panel rendered
// beneath Save/Cancel. Stateless — App.tsx fetches the data with
// `loadBuildToolSettings` and feeds the result in via props.
//
// Empty/missing data is handled here (not by the caller) so the panel can
// render a helpful placeholder instead of disappearing whenever the user
// edits the form and triggers a re-fetch.

type Settings = Extract<Inbound, { cmd: 'buildToolSettings' }>;

interface Props {
  buildTool: 'maven' | 'gradle' | 'npm';
  // The most recent settings reply for this buildTool, or null while we wait
  // for the first response after the panel was requested.
  data: Settings | null;
  loading: boolean;
  onOpenFile: (filePath: string) => void;
}

export function BuildToolSettingsPanel({ buildTool, data, loading, onOpenFile }: Props) {
  // npm is env-var-only. If the extension came back empty (no HTTP_PROXY /
  // HTTPS_PROXY / NO_PROXY set) there's literally nothing useful to show —
  // don't render an empty panel. Maven/Gradle always render because the
  // panel at least tells the user which file would open.
  if (buildTool === 'npm' && data && !hasAnyData(data)) return null;
  if (buildTool === 'npm' && !loading && !data) return null;

  const title = buildTool === 'maven'
    ? 'Maven Settings'
    : buildTool === 'gradle'
      ? 'Gradle Settings'
      : 'npm Proxy Settings';

  return (
    <section
      style={{
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: 3,
        background: 'var(--vscode-editorWidget-background, transparent)',
        border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
      }}
      aria-label={title}
    >
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>{title}</h3>
      {loading && !data && (
        <div style={{ opacity: 0.7, fontSize: '0.9em' }}>Reading settings…</div>
      )}
      {data && <Body data={data} onOpenFile={onOpenFile} />}
    </section>
  );
}

function hasAnyData(data: Settings): boolean {
  return data.proxyHost !== null
    || data.proxyPort !== null
    || data.nonProxyHosts !== null
    || Boolean(data.activeFilePath)
    || Boolean(data.sourceLabel);
}

function Body({ data, onOpenFile }: { data: Settings; onOpenFile: (p: string) => void }) {
  const hasAnyProxy = data.proxyHost !== null || data.proxyPort !== null || data.nonProxyHosts !== null;
  const isEnvSourced = data.buildTool === 'npm';
  // Env-sourced configs (npm) don't have a file path to show; surface the
  // `sourceLabel` row instead so the user can see which env var we picked.
  const sourceRowLabel = isEnvSourced ? 'Source' : 'Active file';
  const sourceRowValue = isEnvSourced
    ? (data.sourceLabel ?? <span style={{ opacity: 0.6 }}>—</span>)
    : (data.activeFilePath ?? <span style={{ opacity: 0.6 }}>(none found)</span>);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 4, fontSize: '0.92em' }}>
        <div style={{ opacity: 0.7 }}>{sourceRowLabel}</div>
        <div style={{ wordBreak: 'break-all' }}>{sourceRowValue}</div>
        <div style={{ opacity: 0.7 }}>Proxy host</div>
        <div>
          {data.proxyHost ?? <span style={{ opacity: 0.6 }}>—</span>}
        </div>
        <div style={{ opacity: 0.7 }}>Proxy port</div>
        <div>
          {data.proxyPort !== null ? data.proxyPort : <span style={{ opacity: 0.6 }}>—</span>}
        </div>
        <div style={{ opacity: 0.7 }}>Non-proxy hosts</div>
        <div style={{ wordBreak: 'break-all' }}>
          {data.nonProxyHosts ?? <span style={{ opacity: 0.6 }}>—</span>}
        </div>
      </div>

      {!hasAnyProxy && !data.note && !isEnvSourced && (
        <div style={{ marginTop: 6, opacity: 0.75, fontSize: '0.9em' }}>
          No proxy configured in the active settings file.
        </div>
      )}
      {data.note && (
        <div style={{ marginTop: 6, opacity: 0.85, fontSize: '0.9em' }}>{data.note}</div>
      )}

      {/* Action buttons — only for file-backed settings. Open button
          opens the active file; the toggle next to it reveals the list
          of overridden files so users can see what's being shadowed. The
          npm panel omits both because proxy comes from env vars. */}
      {!isEnvSourced && <FileActions data={data} onOpenFile={onOpenFile} />}

      {!data.activeFilePath && !isEnvSourced && data.searchedPaths.length > 0 && (
        <div style={{ marginTop: 8, opacity: 0.7, fontSize: '0.85em' }}>
          <div style={{ marginBottom: 2 }}>Looked at:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.searchedPaths.map((p, i) => (
              <li key={i} style={{ wordBreak: 'break-all' }}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function FileActions({ data, onOpenFile }: { data: Settings; onOpenFile: (p: string) => void }) {
  const [showOverridden, setShowOverridden] = useState(false);
  const overriddenCount = data.overriddenFiles.length;
  return (
    <>
      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="secondary"
          disabled={!data.activeFilePath}
          onClick={() => data.activeFilePath && onOpenFile(data.activeFilePath)}
          title={data.activeFilePath
            ? 'Open the active settings file in a new editor tab'
            : 'No settings file found to open'}
        >
          📄 Open settings file
        </button>
        {overriddenCount > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => setShowOverridden(v => !v)}
            title="Show or hide lower-precedence settings files that exist but are shadowed by the active one"
            aria-expanded={showOverridden}
          >
            {showOverridden ? '▾' : '▸'} {showOverridden ? 'Hide' : 'Show'} overridden ({overriddenCount})
          </button>
        )}
      </div>
      {showOverridden && overriddenCount > 0 && (
        <OverriddenList files={data.overriddenFiles} onOpenFile={onOpenFile} />
      )}
    </>
  );
}

function OverriddenList({
  files,
  onOpenFile,
}: {
  files: Settings['overriddenFiles'];
  onOpenFile: (p: string) => void;
}) {
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {files.map((f, i) => (
        <div
          key={i}
          style={{
            padding: '8px 10px',
            borderRadius: 3,
            border: '1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4))',
            background: 'var(--vscode-editorWidget-background, transparent)',
            fontSize: '0.9em',
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <span style={{ opacity: 0.7 }}>{f.tier}</span>
            <span style={{ marginLeft: 6, opacity: 0.5 }}>(overridden)</span>
          </div>
          <div style={{ wordBreak: 'break-all', marginBottom: 6 }}>{f.filePath}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2 }}>
            <div style={{ opacity: 0.7 }}>Proxy host</div>
            <div>{f.proxyHost ?? <span style={{ opacity: 0.6 }}>—</span>}</div>
            <div style={{ opacity: 0.7 }}>Proxy port</div>
            <div>{f.proxyPort !== null ? f.proxyPort : <span style={{ opacity: 0.6 }}>—</span>}</div>
            <div style={{ opacity: 0.7 }}>Non-proxy hosts</div>
            <div style={{ wordBreak: 'break-all' }}>
              {f.nonProxyHosts ?? <span style={{ opacity: 0.6 }}>—</span>}
            </div>
          </div>
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="secondary"
              onClick={() => onOpenFile(f.filePath)}
              title="Open this overridden file in a new editor tab"
            >
              📄 Open
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Derive the build tool the panel should show for a given config. Returns
// null when the type has no Maven/Gradle association (npm, docker, custom,
// tomcat with buildTool='none'). Exported so App.tsx can decide whether to
// mount the panel at all.
// Accepts `unknown` for values so callers don't have to widen their union
// types — the function only reads `type` and `typeOptions.buildTool`.
export function buildToolForConfig(values: unknown): 'maven' | 'gradle' | 'npm' | null {
  const v = (values ?? {}) as { type?: unknown; typeOptions?: { buildTool?: unknown } };
  const type = typeof v.type === 'string' ? v.type : undefined;
  if (type === 'maven-goal') return 'maven';
  if (type === 'gradle-task') return 'gradle';
  if (type === 'npm') return 'npm';
  const bt = typeof v.typeOptions?.buildTool === 'string' ? v.typeOptions.buildTool : undefined;
  if (type === 'spring-boot' || type === 'quarkus' || type === 'java' || type === 'tomcat') {
    return bt === 'gradle' ? 'gradle' : bt === 'maven' ? 'maven' : null;
  }
  return null;
}
