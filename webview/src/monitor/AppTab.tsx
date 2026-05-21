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
          <h3
            title="HTTP request statistics from Spring Boot Actuator's http.server.requests metric."
            style={{ marginTop: 0, marginBottom: 6, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
          >
            HTTP traffic
          </h3>
          <div title="Total number of HTTP requests handled since the application started.">
            Requests: {actuator.metrics.http_requests_total.toLocaleString()}
          </div>
          <div title="Response latency percentiles: p50 = median (half of requests faster than this), p95 = 95th percentile (only 5% of requests are slower), p99 = 99th percentile (only 1% are slower). High p99 with normal p50 indicates occasional slow outliers.">
            p50: {actuator.metrics.http_request_duration_p50_ms} ms
            {' · '}p95: {actuator.metrics.http_request_duration_p95_ms} ms
            {' · '}p99: {actuator.metrics.http_request_duration_p99_ms} ms
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
          <div title="Threads currently processing a request vs the connector's maximum thread pool size. When busy threads approach the maximum, new connections queue up and response times increase.">
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
            title="Spring Boot Actuator /actuator/health endpoint. Reports the overall application health status and the status of each health indicator (database, disk space, message broker, etc.)."
            style={{ marginTop: 0, marginBottom: 6, fontSize: 13, cursor: 'help', textDecoration: 'underline dotted', display: 'inline-block' }}
          >
            Health
          </h3>
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
