import type { RunFile } from '../shared/types';
import { log } from '../utils/logger';

// Registry of run.json schema migrations.
//
// Each entry runs once when an on-disk file's `version` is older than
// `to` AND the running extension is at least `to`. Migrations should:
//   - Be idempotent (defensive: a partly-migrated file shouldn't break
//     a re-run).
//   - Read field shapes that existed at `from` and write field shapes
//     valid at `to`. The schema validator that runs *after* migrations
//     decides whether the result actually parses.
//   - NOT touch fields they don't own. Shared keys (id, name) are
//     stable; type-specific keys belong to their migration.
//
// To add a new migration:
//   1. Bump the extension version in package.json.
//   2. Append a `{ from, to, migrate }` entry below. `from` is the
//      previous extension version users might still have on disk;
//      `to` is the new one.
//   3. Write tests for the transform (test/migrations.test.ts).
//
// We don't *require* every release to add a migration — most version
// bumps are backwards-compatible. The runner notices when no entries
// apply and short-circuits.

export interface MigrationEntry {
  // Inclusive lower bound: applies to files whose stored version
  // equals or exceeds `from` AND is strictly less than `to`.
  from: string;
  to: string;
  migrate: (file: RunFile) => RunFile;
}

// Empty by default — no shape changes have shipped yet that require a
// migration. Future releases append here.
export const MIGRATIONS: MigrationEntry[] = [];

export interface MigrationResult {
  file: RunFile;
  // True when the file's content actually changed beyond the version
  // stamp. The caller uses this to decide whether to write back to
  // disk (avoids touching every workspace's run.json on a pure
  // version-bump release).
  contentChanged: boolean;
  // The version we stamped onto the result. Equals `extensionVersion`
  // for the up-to-date / older paths; equals the on-disk version when
  // the file was newer than the running extension (we don't downgrade).
  finalVersion: string;
}

// Apply every registered migration whose target the running extension
// is at-or-newer than. Stamps `finalVersion` onto the file.
export function runMigrations(
  file: RunFile,
  extensionVersion: string,
): MigrationResult {
  const onDisk = file.version || '0.0.0';
  const cmp = compareSemver(onDisk, extensionVersion);

  // Newer than the extension — leave alone, just log. We don't
  // downgrade the file because doing so would silently lose newer
  // fields when the user reverts to an older extension.
  if (cmp > 0) {
    log.warn(
      `run.json version ${onDisk} is newer than the extension (${extensionVersion}). ` +
      `Loading as-is; consider upgrading the extension.`,
    );
    return { file, contentChanged: false, finalVersion: onDisk };
  }

  // Up-to-date — no work.
  if (cmp === 0) {
    return { file, contentChanged: false, finalVersion: onDisk };
  }

  // Older — walk every applicable migration in order.
  let cur = file;
  let contentChanged = false;
  // Sort by `to` so chained migrations apply oldest-first.
  const ordered = [...MIGRATIONS].sort((a, b) => compareSemver(a.to, b.to));
  for (const m of ordered) {
    if (compareSemver(onDisk, m.to) >= 0) continue;        // already past this hop
    if (compareSemver(extensionVersion, m.to) < 0) continue; // extension hasn't caught up
    log.info(`run.json migration: ${m.from} → ${m.to}`);
    const before = JSON.stringify(cur);
    cur = m.migrate(cur);
    if (JSON.stringify(cur) !== before) contentChanged = true;
  }

  // Stamp the final version even when no migrations changed the
  // content. The caller only persists when contentChanged or when the
  // version field needed an update (caller decides on the latter).
  const finalVersion = extensionVersion;
  return { file: { ...cur, version: finalVersion }, contentChanged, finalVersion };
}

// Compare two semver-ish strings. Pads missing fields with 0; ignores
// any prerelease suffix (we don't ship prereleases in run.json).
// Returns negative / 0 / positive in the usual sense.
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseVersion(v: string): [number, number, number] {
  // Strip a `-prerelease` tail if present.
  const core = v.split('-')[0];
  const parts = core.split('.').map(p => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
