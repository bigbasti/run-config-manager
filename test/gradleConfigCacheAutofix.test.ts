// test/gradleConfigCacheAutofix.test.ts
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'ExecutionService.ts'),
  'utf8',
);

describe('Gradle config cache auto-fix — source-level guards', () => {
  test('defines the config cache error regex', () => {
    expect(src).toMatch(/Invocation of 'Task\\.project'.*unsupported with the configuration cache/);
  });

  test('uses a per-run deduplication set (configCacheToastShown)', () => {
    expect(src).toMatch(/configCacheToastShown/);
  });

  test('calls maybeOfferGradleConfigCacheFix from onOutput', () => {
    expect(src).toMatch(/maybeOfferGradleConfigCacheFix/);
  });

  test('appends --no-configuration-cache to typeOptions.task', () => {
    expect(src).toMatch(/--no-configuration-cache/);
  });

  test('guards against double-appending the flag', () => {
    // The fix method must check whether the flag is already present
    // before appending, to avoid "task --no-configuration-cache --no-configuration-cache".
    expect(src).toMatch(/includes\('--no-configuration-cache'\)/);
  });

  test('accepts configSvc as optional third constructor parameter', () => {
    // Existing two-arg callers (tests, extension.ts before the wiring commit)
    // must not break. The param must be optional (? or default undefined).
    // Match "constructor(... configSvc?" or "configSvc?: "
    expect(src).toMatch(/configSvc\?/);
  });

  test('clears configCacheToastShown in handleEnd', () => {
    // The deduplication set must be cleared when the task ends so a
    // re-run of the same config can trigger the toast again if the
    // error still fires.
    const handleEndIdx = src.indexOf('private handleEnd(');
    expect(handleEndIdx).toBeGreaterThan(-1);
    const handleEndBody = src.slice(handleEndIdx, handleEndIdx + 1200);
    expect(handleEndBody).toMatch(/configCacheToastShown\.delete/);
  });

  test('clears configCacheToastShown in stop', () => {
    // stop() must also clear the dedup set so a manual stop+rerun
    // can trigger the toast again if the error fires again.
    const stopIdx = src.indexOf('async stop(');
    expect(stopIdx).toBeGreaterThan(-1);
    const stopBody = src.slice(stopIdx, stopIdx + 3000);
    expect(stopBody).toMatch(/configCacheToastShown\.delete/);
  });
});
