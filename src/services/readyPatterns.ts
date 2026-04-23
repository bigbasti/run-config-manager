import type { RunConfig } from '../shared/types';

// Returns regex patterns whose first match in the terminal output signals that
// the app has finished starting up. The ExecutionService scans each stdout/
// stderr chunk and flips the config to 'started' on the first hit.
//
// Each entry's pattern should match text that only appears ONCE per startup
// (usually at the very end), so we don't flag 'started' prematurely on partial
// matches early in the log stream. The patterns are intentionally broad — a
// false negative (staying in the spinner) is better than a false positive.

// BUILD FAILED / BUILD FAILURE appears as the last line of a Gradle or Maven
// build that bailed before the app ever started. Every JVM-type config that
// shells out to a build tool shares these, so we keep them in one place.
const SHARED_BUILD_TOOL_FAILURES: RegExp[] = [
  /^BUILD FAILED\b/m,
  /^BUILD FAILURE\b/m,
];

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
  if (cfg.type === 'quarkus') {
    return [
      // 'Listening on: http://0.0.0.0:8080' — Quarkus prints this exactly once
      // when dev mode is fully up, immediately after the build.
      /Listening on:\s*https?:\/\//,
      // 'Profile dev activated. Live Coding activated.' — also once, at the
      // tail of the startup banner.
      /Profile \w+ activated\. Live Coding activated/,
    ];
  }
  if (cfg.type === 'java') {
    // Plain Java apps have no universal startup marker. We intentionally
    // leave this empty — the tree stays in the spinner for the life of the
    // process, which is the most honest signal we can give. If a user's app
    // DOES print a recognisable phrase, they can switch to tagging via
    // programArgs or (v2) add a per-config regex.
    return [];
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

// Returns regex patterns whose first match in the terminal output signals that
// startup has failed. ExecutionService flips the config to a 'failed' state and
// the tree renders a red circle instead of green. As with ready patterns, err
// on the side of false negatives — a single noisy log line shouldn't shout
// "failed" when it's actually fine.
export function failurePatternsFor(cfg: RunConfig): RegExp[] {
  if (cfg.type === 'spring-boot') {
    return [
      // Canonical Spring Boot startup failure banner — appears once when
      // ApplicationContext fails to refresh.
      /APPLICATION FAILED TO START/,
      /Application run failed/,
      /Error starting ApplicationContext/,
      // Port already bound.
      /Web server failed to start/,
      ...SHARED_BUILD_TOOL_FAILURES,
    ];
  }
  if (cfg.type === 'tomcat') {
    return [
      // Tomcat writes this on catastrophic startup.
      /A child container failed during start/,
      /Context \[[^\]]*\] startup failed due to previous errors/,
      /Error deploying web application/,
      // Port bind failure — "Failed to initialize connector" + BindException.
      /Failed to initialize (?:connector|end ?point)/,
      /java\.net\.BindException/,
      ...SHARED_BUILD_TOOL_FAILURES,
    ];
  }
  if (cfg.type === 'quarkus') {
    return [
      // Quarkus's own startup-failure banner. Covers dev-mode + prod failures.
      /Failed to start (?:application|quarkus)/i,
      // Port bind failure — Quarkus prints this verbatim.
      /Port \d+ is already in use/,
      ...SHARED_BUILD_TOOL_FAILURES,
    ];
  }
  if (cfg.type === 'java') {
    return [
      // Classic uncaught-main-thread exception. The thread name varies (main,
      // async-whatever, pool-N-thread-M) so we match any quoted name.
      /Exception in thread "[^"]+" /,
      // The JDK's own "no main" errors — not user stack traces, always fatal.
      /Error: Could not find or load main class/,
      /Error: Main method not found/,
      /java\.lang\.NoClassDefFoundError/,
      ...SHARED_BUILD_TOOL_FAILURES,
    ];
  }
  if (cfg.type === 'npm') {
    return [
      // Angular CLI 15+ prints this for build-time errors.
      /Application bundle generation failed/,
      /Failed to compile\./,
      // webpack.
      /webpack [\w.]+ compiled with \d+ errors?/i,
      // npm itself bailed (script not found, lifecycle error, etc).
      /npm ERR!/,
      // Port already in use — Node throws this before the server binds.
      /Error: listen EADDRINUSE/,
    ];
  }
  return [];
}

export function chunkSignalsFailure(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

// Returns the first pattern whose test matches `text`, or null. Used by
// ExecutionService to log which specific pattern fired when flipping a
// config to started/failed — the source ("/Started .../") is much more
// useful than a generic "matched readiness pattern".
export function firstMatch(text: string, patterns: RegExp[]): RegExp | null {
  for (const p of patterns) {
    if (p.test(text)) return p;
  }
  return null;
}

// Patterns signalling that a running dev server is recompiling / restarting
// after a file change. When one fires on a config that's currently in
// `started` or `failed` state, the tree flips to a yellow spinner
// ("Rebuilding…"). A subsequent ready match flips it back to green; a
// failure match flips it red. The cycle repeats for the life of the process.
//
// Only npm / Node runtimes have watch mode that's this chatty; JVM runtimes
// that have it (Spring Boot DevTools, Quarkus Live Coding) already manage
// their own "Restarted …" log lines which match the existing ready pattern,
// so they don't need a rebuilding state.
export function rebuildPatternsFor(cfg: RunConfig): RegExp[] {
  if (cfg.type === 'npm') {
    return [
      // Angular CLI 15+.
      /Changes detected\.?\s*Rebuilding/i,
      /^\s*Rebuilding\.\.\./m,
      // Webpack + webpack-dev-server.
      /^\s*Compiling\.\.\./m,
      /webpack is watching the files/i,
      // Vite HMR / full reload.
      /\[vite\] (page reload|hmr update)/i,
      /\[vite\] restarting server/i,
      // Next.js dev server — spacing varies; loose whitespace between tokens.
      /^\s*(wait|event)\s+-\s+(compiling|compiled)/im,
      /^\s*- event compiled/im,
      // Create React App / react-scripts.
      /^\s*Compiling\.\.\. ?$/m,
      // SvelteKit / Vite-based Svelte setups.
      /hmr update/i,
      /rebuilding\b/i,
      // Nodemon / ts-node-dev restart banners.
      /\[nodemon\] restarting due to changes/i,
      /\[nodemon\] starting/i,
      /ts-node-dev\b.*(restarting|compilation)/i,
    ];
  }
  return [];
}
