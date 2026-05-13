import { useState } from 'react';
import type { ActuatorSnapshot } from '../../../src/services/monitoring/AgentMessage';

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'];

export function AppTab({
  actuator,
  setLogLevel,
}: {
  actuator: ActuatorSnapshot | null;
  setLogLevel: (name: string, level: string) => void;
}) {
  const [filter, setFilter] = useState('');

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
            expose endpoints with <code>management.endpoints.web.exposure.include=health,metrics,loggers</code>.
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

  const filteredLoggers = (actuator.loggers ?? []).filter(l =>
    !filter || l.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 12 }}>
      <div style={{ opacity: 0.7 }}>
        Source: {actuator.baseUrl}
      </div>

      {actuator.metrics && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>HTTP traffic</h3>
          <div>Requests: {actuator.metrics.http_requests_total.toLocaleString()}</div>
          <div>p50: {actuator.metrics.http_request_duration_p50_ms} ms · p95: {actuator.metrics.http_request_duration_p95_ms} ms · p99: {actuator.metrics.http_request_duration_p99_ms} ms</div>
        </section>
      )}

      {actuator.tomcat && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>Tomcat</h3>
          <div>Busy threads: {actuator.tomcat.currentThreadsBusy} of {actuator.tomcat.maxThreads}</div>
          <div>Requests: {actuator.tomcat.requestCount.toLocaleString()} · Errors: {actuator.tomcat.errorCount.toLocaleString()}</div>
        </section>
      )}

      {actuator.health && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>Health</h3>
          <div>Overall: <strong style={{ color: actuator.health.status === 'UP' ? '#4caf50' : '#f44747' }}>{actuator.health.status}</strong></div>
          {Object.entries(actuator.health.components ?? {}).map(([name, status]) => (
            <div key={name}>
              <span style={{ color: status === 'UP' ? '#4caf50' : '#f44747' }}>
                {status === 'UP' ? '✓' : '✗'}
              </span> {name} — {status}
            </div>
          ))}
        </section>
      )}

      {actuator.loggers && (
        <section>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>Loggers ({actuator.loggers.length})</h3>
          <input
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
          />
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: 4 }}>
            {filteredLoggers.map(l => (
              <div key={l.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, padding: '4px 8px', alignItems: 'center', fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>
                  {l.name} <span style={{ opacity: 0.6 }}>· {l.effective}</span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {LEVELS.map(level => (
                    <button
                      key={level}
                      onClick={() => setLogLevel(l.name, level)}
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: l.effective === level ? 'var(--vscode-button-background)' : 'transparent',
                        color: l.effective === level ? 'var(--vscode-button-foreground)' : 'inherit',
                        border: '1px solid var(--vscode-button-border, #555)',
                        borderRadius: 2,
                        cursor: 'pointer',
                      }}
                    >{level}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
