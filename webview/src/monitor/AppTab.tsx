import { useEffect, useState } from 'react';
import type {
  ActuatorSnapshot,
  ActuatorEnvSource,
  ActuatorInfo,
} from '../../../src/services/monitoring/AgentMessage';

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'];

const LEVEL_COLORS: Record<string, string> = {
  TRACE: 'var(--vscode-terminal-ansiBlue, #6796e6)',
  DEBUG: 'var(--vscode-terminal-ansiBrightBlue, #4fc1ff)',
  INFO:  'var(--vscode-terminal-ansiGreen, #4caf50)',
  WARN:  'var(--vscode-terminal-ansiYellow, #e5c07b)',
  ERROR: 'var(--vscode-terminal-ansiRed, #f44747)',
  OFF:   'var(--vscode-disabledForeground, #777)',
};

// Neutral style for inactive level buttons — all the same gray so only the
// active one stands out with color.
const INACTIVE_BTN: React.CSSProperties = {
  fontSize: 9,
  padding: '1px 5px',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground, #888)',
  border: '1px solid var(--vscode-editorWidget-border, #555)',
  borderRadius: 2,
  cursor: 'pointer',
  minWidth: 38,
  textAlign: 'center' as const,
  fontWeight: 400,
};

type AppSubTab = 'overview' | 'loggers' | 'env' | 'info';

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewSection({ actuator }: { actuator: ActuatorSnapshot }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 12 }}>
      <div style={{ opacity: 0.7 }}>Source: {actuator.baseUrl}</div>

      {actuator.metrics && (
        <section>
          <h3
            title="HTTP request statistics from Spring Boot Actuator's http.server.requests metric."
            style={{ marginTop: 0, marginBottom: 6, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
          >
            HTTP traffic
          </h3>
          <div title="Total number of HTTP requests handled since the application started.">
            Requests: {actuator.metrics.http_requests_total.toLocaleString()}
          </div>
          <div title="Response latency percentiles. Only populated when management.metrics.distribution.percentiles.http.server.requests is configured in the app.">
            p50: {actuator.metrics.http_request_duration_p50_ms.toFixed(1)} ms
            {' · '}p95: {actuator.metrics.http_request_duration_p95_ms.toFixed(1)} ms
            {' · '}p99: {actuator.metrics.http_request_duration_p99_ms.toFixed(1)} ms
          </div>
        </section>
      )}

      {actuator.tomcat && (
        <section>
          <h3
            title="Tomcat connector statistics read from JMX MBeans (Catalina:type=ThreadPool and GlobalRequestProcessor)."
            style={{ marginTop: 0, marginBottom: 6, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
          >
            Tomcat connector
          </h3>
          <div title="Threads currently processing a request vs the connector's maximum thread pool size.">
            Busy threads: {actuator.tomcat.currentThreadsBusy} of {actuator.tomcat.maxThreads}
          </div>
          <div title="Total requests processed and total error responses (4xx + 5xx) since Tomcat started.">
            Requests: {actuator.tomcat.requestCount.toLocaleString()} · Errors: {actuator.tomcat.errorCount.toLocaleString()}
          </div>
        </section>
      )}

      {actuator.health && (
        <section>
          <h3
            title="Spring Boot Actuator /actuator/health endpoint. Reports the overall application health status and each health indicator."
            style={{ marginTop: 0, marginBottom: 6, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
          >
            Health
          </h3>
          <div>Overall: <strong style={{ color: actuator.health.status === 'UP' ? '#4caf50' : '#f44747' }}>{actuator.health.status}</strong></div>
          {Object.entries(actuator.health.components ?? {}).map(([name, comp]) => (
            <div key={name}>
              <span style={{ color: comp.status === 'UP' ? '#4caf50' : '#f44747' }}>
                {comp.status === 'UP' ? '✓' : '✗'}
              </span> {name} — {comp.status}
            </div>
          ))}
        </section>
      )}

      {!actuator.metrics && !actuator.tomcat && !actuator.health && (
        <div style={{ opacity: 0.6, fontSize: 12 }}>
          Actuator connected but no health / metrics data yet.
        </div>
      )}
    </div>
  );
}

// ─── Loggers ─────────────────────────────────────────────────────────────────

// Per-button state: undefined = idle, 'pending' = waiting, 'ok' = success flash, 'err' = error flash
type BtnState = 'pending' | 'ok' | 'err';

// Maps common HTTP error codes from the actuator loggers endpoint to human-readable
// guidance so the user knows exactly why the change failed and what to do.
function describeLogLevelError(errorMessage: string | undefined): { short: string; fix: string } {
  if (!errorMessage) return { short: 'Unknown error', fix: 'Check the extension output channel for details.' };
  if (errorMessage.includes('HTTP 401') || errorMessage.includes('HTTP 403')) {
    return {
      short: `Request rejected (${errorMessage})`,
      fix: 'Spring Security is blocking the actuator POST request. ' +
        'Add a security rule to permit POST to /actuator/loggers/**, ' +
        'or set management.security.enabled=false (not recommended for production).',
    };
  }
  if (errorMessage.includes('HTTP 404')) {
    return {
      short: 'Logger endpoint not found (HTTP 404)',
      fix: 'Ensure "loggers" is included in management.endpoints.web.exposure.include ' +
        'and management.endpoint.loggers.enabled=true.',
    };
  }
  if (errorMessage.includes('HTTP 405')) {
    return {
      short: 'Method not allowed (HTTP 405)',
      fix: 'The loggers endpoint is exposed for GET but POST may be blocked. ' +
        'Check your security configuration.',
    };
  }
  if (errorMessage === 'actuator not available') {
    return {
      short: 'Actuator not connected',
      fix: 'The monitoring agent has not yet found an actuator endpoint on this JVM. ' +
        'Wait a few seconds for the agent to connect, or check the port/exposure configuration.',
    };
  }
  return { short: errorMessage, fix: 'Check the extension output channel for details.' };
}

function LoggersSection({
  actuator,
  setLogLevel,
  logLevelResult,
}: {
  actuator: ActuatorSnapshot;
  setLogLevel: (name: string, level: string) => void;
  logLevelResult: { name: string; level: string; ok: boolean; errorMessage?: string } | null;
}) {
  const [filter, setFilter] = useState('');
  // Map key: "loggerName:LEVEL"
  const [btnStates, setBtnStates] = useState<Map<string, BtnState>>(new Map());
  // Sticky error banner — shown until the next successful change or manual dismiss.
  const [lastError, setLastError] = useState<{ short: string; fix: string } | null>(null);

  // When a result arrives from the extension, update the button state and
  // schedule a flash-then-clear after 1.5s. On error, also set the sticky banner.
  useEffect(() => {
    if (!logLevelResult) return;
    const key = `${logLevelResult.name}:${logLevelResult.level}`;
    const result: BtnState = logLevelResult.ok ? 'ok' : 'err';
    setBtnStates(m => new Map(m).set(key, result));
    if (logLevelResult.ok) {
      setLastError(null); // clear any previous error on success
    } else {
      setLastError(describeLogLevelError(logLevelResult.errorMessage));
    }
    const t = setTimeout(() => {
      setBtnStates(m => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [logLevelResult]);

  if (!actuator.loggers || actuator.loggers.length === 0) {
    return (
      <div style={{ opacity: 0.6, fontSize: 12 }}>
        No loggers data. Ensure <code>loggers</code> is included in{' '}
        <code>management.endpoints.web.exposure.include</code>.
      </div>
    );
  }

  const filteredLoggers = actuator.loggers.filter(l =>
    !filter || l.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const handleSetLevel = (name: string, level: string) => {
    const key = `${name}:${level}`;
    // Mark as pending immediately; clear after 4s safety timeout if no reply.
    setBtnStates(m => new Map(m).set(key, 'pending'));
    const t = setTimeout(() => {
      setBtnStates(m => {
        if (m.get(key) !== 'pending') return m; // already resolved
        const next = new Map(m);
        next.delete(key);
        return next;
      });
    }, 4000);
    setLogLevel(name, level);
    // Store timeout id so it can be cleared by the useEffect above if the
    // reply arrives before the 4s window. (React doesn't expose a clean way
    // to pass it across, so we let both race — the effect sets 'ok'/'err'
    // which is checked by the timeout before deleting.)
    return () => clearTimeout(t);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lastError && (
        <div style={{
          background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
          border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
          borderRadius: 4,
          padding: '8px 10px',
          fontSize: 11,
          lineHeight: 1.5,
          position: 'relative',
        }}>
          <button
            onClick={() => setLastError(null)}
            title="Dismiss"
            style={{
              position: 'absolute', top: 4, right: 6,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'inherit', fontSize: 14, lineHeight: 1, opacity: 0.7,
            }}
          >×</button>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Failed to change log level: {lastError.short}
          </div>
          <div style={{ opacity: 0.9 }}>
            {lastError.fix}
          </div>
        </div>
      )}
      <input
        placeholder="Filter logger name…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <div style={{ fontSize: 11, opacity: 0.6 }}>{filteredLoggers.length} of {actuator.loggers.length} loggers</div>
      <div style={{
        maxHeight: 480,
        overflowY: 'auto',
        border: '1px solid var(--vscode-editorWidget-border, #444)',
        borderRadius: 4,
      }}>
        {filteredLoggers.map(l => {
          const effectiveColor = LEVEL_COLORS[l.effective] ?? 'inherit';
          return (
            <div
              key={l.name}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 8,
                padding: '4px 8px',
                alignItems: 'center',
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                fontSize: 11,
                borderBottom: '1px solid var(--vscode-editorWidget-border, #333)',
              }}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>
                {l.name}
                <span style={{ marginLeft: 6, color: effectiveColor, fontWeight: 600 }}>
                  {l.effective}
                </span>
                {l.configured && l.configured !== l.effective && (
                  <span style={{ marginLeft: 4, opacity: 0.5 }}>(configured: {l.configured})</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                {LEVELS.map(level => {
                  const isActive = l.effective === level;
                  const btnState = btnStates.get(`${l.name}:${level}`);
                  const isPending = btnState === 'pending';
                  const isOk = btnState === 'ok';
                  const isErr = btnState === 'err';

                  // Active button: filled with the level's color, dark text.
                  // Flash states: brief green (ok) or red (err) background.
                  // All other buttons: neutral gray — only the active one has color.
                  let bg = 'transparent';
                  let color = 'var(--vscode-descriptionForeground, #888)';
                  let border = '1px solid var(--vscode-editorWidget-border, #555)';
                  let label: string = level;

                  if (isPending) {
                    bg = 'transparent';
                    color = 'var(--vscode-descriptionForeground, #888)';
                    label = '…';
                  } else if (isOk) {
                    bg = 'var(--vscode-terminal-ansiGreen, #4caf50)';
                    color = 'var(--vscode-editor-background, #1e1e1e)';
                    border = '1px solid var(--vscode-terminal-ansiGreen, #4caf50)';
                    label = '✓';
                  } else if (isErr) {
                    bg = 'var(--vscode-terminal-ansiRed, #f44747)';
                    color = 'var(--vscode-editor-background, #1e1e1e)';
                    border = '1px solid var(--vscode-terminal-ansiRed, #f44747)';
                    label = '✗';
                  } else if (isActive) {
                    bg = LEVEL_COLORS[level] ?? 'var(--vscode-button-background)';
                    color = 'var(--vscode-editor-background, #1e1e1e)';
                    border = `1px solid ${LEVEL_COLORS[level] ?? 'var(--vscode-button-background)'}`;
                  }

                  return (
                    <button
                      key={level}
                      title={isActive ? `${level} (active)` : `Set ${l.name} to ${level}`}
                      onClick={() => handleSetLevel(l.name, level)}
                      disabled={isPending}
                      style={{
                        ...INACTIVE_BTN,
                        background: bg,
                        color,
                        border,
                        fontWeight: isActive ? 700 : 400,
                        cursor: isPending ? 'wait' : 'pointer',
                        transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Environment ──────────────────────────────────────────────────────────────

function EnvSection({ env }: { env: ActuatorEnvSource[] | undefined }) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!env || env.length === 0) {
    return (
      <div style={{ opacity: 0.6, fontSize: 12 }}>
        No environment data. Ensure <code>env</code> is included in{' '}
        <code>management.endpoints.web.exposure.include</code>.
      </div>
    );
  }

  const toggle = (name: string) =>
    setExpanded(s => {
      const next = new Set(s);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const f = filter.toLowerCase();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
      <input
        placeholder="Filter property key or value…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      {env.map(src => {
        const entries = Object.entries(src.properties).filter(
          ([k, v]) => !f || k.toLowerCase().includes(f) || String(v.value).toLowerCase().includes(f),
        );
        if (entries.length === 0 && f) return null;
        const open = expanded.has(src.name);
        return (
          <div key={src.name} style={{ border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4 }}>
            <div
              onClick={() => toggle(src.name)}
              style={{
                padding: '5px 10px',
                cursor: 'pointer',
                fontWeight: 600,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--vscode-editorGroupHeader-tabsBackground, transparent)',
              }}
              title={src.name}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {open ? '▾' : '▸'} {src.name}
              </span>
              <span style={{ opacity: 0.5, marginLeft: 8, flexShrink: 0 }}>{entries.length}</span>
            </div>
            {open && (
              <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 11 }}>
                {entries.map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '40% 1fr',
                      gap: 8,
                      padding: '3px 10px',
                      borderTop: '1px solid var(--vscode-editorWidget-border, #333)',
                    }}
                    title={v.origin ?? k}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)' }}>{k}</div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>{String(v.value)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Info ─────────────────────────────────────────────────────────────────────

function renderInfoValue(value: unknown, depth = 0): React.ReactNode {
  if (value === null || value === undefined) return <span style={{ opacity: 0.5 }}>—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {value.map((item, i) => <li key={i}>{renderInfoValue(item, depth + 1)}</li>)}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span style={{ opacity: 0.5 }}>{ '{}' }</span>;
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td style={{
              padding: '2px 8px 2px 0',
              verticalAlign: 'top',
              whiteSpace: 'nowrap',
              color: 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)',
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: 11,
            }}>{k}</td>
            <td style={{ padding: '2px 0', verticalAlign: 'top', fontSize: 11 }}>
              {renderInfoValue(v, depth + 1)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InfoSection({ info }: { info: ActuatorInfo | undefined }) {
  if (!info || Object.keys(info).length === 0) {
    return (
      <div style={{ opacity: 0.6, fontSize: 12 }}>
        No application info. Ensure <code>info</code> is included in{' '}
        <code>management.endpoints.web.exposure.include</code> and add info contributors
        (e.g. <code>management.info.env.enabled=true</code>).
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
      {Object.entries(info).map(([section, value]) => (
        <section key={section}>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13, textTransform: 'capitalize' }}>{section}</h3>
          {renderInfoValue(value)}
        </section>
      ))}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function AppTab({
  actuator,
  setLogLevel,
  logLevelResult,
}: {
  actuator: ActuatorSnapshot | null;
  setLogLevel: (name: string, level: string) => void;
  logLevelResult: { name: string; level: string; ok: boolean; errorMessage?: string } | null;
}) {
  const [subTab, setSubTab] = useState<AppSubTab>('overview');

  if (!actuator || !actuator.available) {
    return (
      <div style={{
        border: '1px dashed var(--vscode-editorWidget-border, #444)',
        borderRadius: 4,
        padding: 16,
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        <strong>No app-level source detected</strong>
        <div style={{ marginTop: 8 }}>
          The agent didn't find Spring Boot Actuator or Tomcat MBeans on this JVM.
        </div>
        <ul style={{ marginTop: 8, paddingLeft: 18 }}>
          <li>
            <strong>Spring Boot:</strong> add <code>spring-boot-starter-actuator</code> and
            expose endpoints with <code>management.endpoints.web.exposure.include=health,metrics,loggers,env,info</code>.
          </li>
          <li><strong>Tomcat:</strong> standalone Tomcat configs auto-detect via JMX.</li>
        </ul>
        <div style={{ marginTop: 8, opacity: 0.7 }}>
          The other tabs work without an app-level source.
          {actuator?.reason && <> Last probe: {actuator.reason}.</>}
        </div>
      </div>
    );
  }

  const subTabs: Array<[AppSubTab, string, string]> = [
    ['overview', 'Overview', 'Health, HTTP traffic and Tomcat connector stats'],
    ['loggers', 'Loggers', `${actuator.loggers?.length ?? 0} loggers — click a level to change it live`],
    ['env', 'Environment', 'Active property sources from /actuator/env'],
    ['info', 'Info', 'Application info from /actuator/info (version, git, build, etc.)'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--vscode-editorWidget-border, #444)', marginBottom: 12 }}>
        {subTabs.map(([key, label, tip]) => (
          <button
            key={key}
            title={tip}
            onClick={() => setSubTab(key)}
            style={{
              border: 'none',
              borderBottom: subTab === key
                ? '2px solid var(--vscode-focusBorder, #007acc)'
                : '2px solid transparent',
              background: 'transparent',
              padding: '4px 10px',
              cursor: 'pointer',
              color: subTab === key
                ? 'var(--vscode-foreground)'
                : 'var(--vscode-descriptionForeground)',
              fontWeight: subTab === key ? 600 : 400,
              fontSize: 12,
            }}
          >{label}</button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div>
        {subTab === 'overview' && <OverviewSection actuator={actuator} />}
        {subTab === 'loggers' && (
          <LoggersSection actuator={actuator} setLogLevel={setLogLevel} logLevelResult={logLevelResult} />
        )}
        {subTab === 'env' && <EnvSection env={actuator.env} />}
        {subTab === 'info' && <InfoSection info={actuator.info} />}
      </div>
    </div>
  );
}
