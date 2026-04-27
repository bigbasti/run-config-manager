import * as vscode from 'vscode';

// Scans the project for Spring profile-specific resource files. Recognised
// patterns (in the same resources/ directory):
//   1. application-<profile>.{properties,yml,yaml}     — the canonical Spring convention.
//   2. <prefix>-<profile>.{properties,yml,yaml}        — custom @PropertySource layouts
//      (e.g. queue_watcher-<profile>.properties in zebra/queue-watcher).
//      Accepted when either:
//         a. a sibling <prefix>.{properties,yml,yaml} base file exists, OR
//         b. there are 2+ variants sharing the same <prefix>.
//      Otherwise a one-off file like `schema-users.properties` would be
//      mis-read as profile="users".
//
// Walks every module's resources/ dir under the project root, so multi-module
// projects surface profiles from any module.
export async function findSpringProfiles(projectRoot: vscode.Uri): Promise<string[]> {
  const found = new Set<string>();
  await walk(projectRoot, found, 0);
  return Array.from(found).sort();
}

const EXCLUDE_DIRS = new Set([
  'node_modules', 'target', 'build', 'out', '.gradle',
  '.idea', '.vscode', '.git', 'dist', 'bin',
]);
const MAX_DEPTH = 10;

async function walk(dir: vscode.Uri, out: Set<string>, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    if (kind === vscode.FileType.Directory) {
      if (EXCLUDE_DIRS.has(name)) continue;
      const child = vscode.Uri.joinPath(dir, name);
      // When we hit `resources`, scan its direct children for profile files.
      if (name === 'resources') {
        await scanResources(child, out);
        continue;
      }
      await walk(child, out, depth + 1);
    }
  }
}

const PROFILE_FILE_RE = /^([^.]+)-([^.]+)\.(properties|yml|yaml)$/;

async function scanResources(dir: vscode.Uri, out: Set<string>): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  // Build two views so we can validate <prefix>-<profile> candidates without
  // false-positive'ing on one-off files.
  const baseFiles = new Set<string>();       // `<prefix>.<ext>` (no dash)
  const byPrefix = new Map<string, Set<string>>();  // prefix → set of profiles

  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.File) continue;
    const base = name.match(/^([^.]+)\.(properties|yml|yaml)$/);
    if (base) baseFiles.add(base[1]);
    const prof = name.match(PROFILE_FILE_RE);
    if (prof) {
      const [, prefix, profile] = prof;
      let set = byPrefix.get(prefix);
      if (!set) { set = new Set(); byPrefix.set(prefix, set); }
      set.add(profile);
    }
  }

  for (const [prefix, profiles] of byPrefix) {
    // "application" is always trusted — canonical Spring layout, even when a
    // project ships only a single application-dev.properties variant.
    const trusted = prefix === 'application' || baseFiles.has(prefix) || profiles.size >= 2;
    if (!trusted) continue;
    for (const p of profiles) out.add(p);
  }
}
