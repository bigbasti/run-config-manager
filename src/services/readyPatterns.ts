import type { RunConfig } from '../shared/types';

// Returns regex patterns whose first match in the terminal output signals that
// the app has finished starting up. The ExecutionService scans each stdout/
// stderr chunk and flips the config to 'started' on the first hit.
//
// Each entry's pattern should match text that only appears ONCE per startup
// (usually at the very end), so we don't flag 'started' prematurely on partial
// matches early in the log stream. The patterns are intentionally broad — a
// false negative (staying in the spinner) is better than a false positive.

export function readyPatternsFor(cfg: RunConfig): RegExp[] {
  if (cfg.type === 'spring-boot') {
    return [
      // 'Started MyApp in 4.321 seconds (JVM running for ...)'
      /Started [\w$.]+ in [\d.]+ seconds/,
      // 'Tomcat started on port 8080 (http) with context path'
      // 'Tomcat started on port(s): 8080 (http)' (older Spring Boot)
      // 'Tomcat started on port: 8181 (http)'
      /Tomcat started on port\s*(?:\(s?\))?:?\s*\d+/,
      // Fallback for Jetty / Netty / Undertow embedded servers.
      /Netty started on port \d+/,
      /Jetty started on port \d+/,
      /Undertow started .* on port\s*\d+/,
    ];
  }
  if (cfg.type === 'tomcat') {
    return [
      // Tomcat logs 'Server startup in [42] milliseconds' at the very end.
      /Server startup in \[?\d+\]? (ms|milliseconds)/,
      // Spring Boot apps deployed as WARs still emit their Started marker.
      /Started [\w$.]+ in [\d.]+ seconds/,
    ];
  }
  if (cfg.type === 'npm') {
    return [
      // Angular CLI 14+: 'Application bundle generation complete.' / 'Compiled successfully'
      /Compiled successfully/,
      /Application bundle generation complete/,
      /Angular Live Development Server is listening/,
      // Vite: 'ready in 324 ms' / 'Local: http://localhost:5173'
      /ready in \d+\s*(ms|milliseconds)/i,
      /Local:\s+https?:\/\/[^\s]+/,
      // webpack dev server
      /webpack [\d.]+ compiled successfully/i,
      /compiled successfully in \d+\s*ms/i,
      // Next.js
      /ready - started server on/i,
      /Ready in \d+(\.\d+)?\s*(ms|s)/,
      // Express / general node server conventions.
      /server (is )?(running|listening) on/i,
      /listening (on )?(port |:)\d+/i,
      // Generic "…running on http(s)://…" form (common in README snippets).
      /running on https?:\/\//i,
    ];
  }
  return [];
}

// Given a chunk of stdout/stderr text and the patterns for this config,
// return true if any pattern matches. Tests each pattern once — cheap even
// for several hundred lines.
export function chunkSignalsReady(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}
