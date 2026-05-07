// Helpers for the slash-separated folder path strings that live on
// `RunConfig.group` and inside `RunFile.groups`. Everything here is
// pure; the IO sits in GroupService / RunConfigService.

// Split a path into trimmed segments. Empty / undefined → [].
export function splitFolderPath(p: string | undefined): string[] {
  if (!p) return [];
  return p.split('/').map(s => s.trim()).filter(Boolean);
}

// Reassemble segments into a slash path. Segments are inserted as-is
// (no further trimming) so callers stay in control of name handling.
export function joinFolderPath(parts: string[]): string {
  return parts.join('/');
}

// Every prefix path of the given path (inclusive). "Backend/API/Internal"
// → ["Backend", "Backend/API", "Backend/API/Internal"]. Used by:
//   - the loader's migration step (every prefix is a known folder when
//     no `groups` array is present on disk)
//   - the GroupService's folder-create flow (creating "A/B/C"
//     ensures "A" and "A/B" also exist).
export function ancestorPaths(path: string): string[] {
  const parts = splitFolderPath(path);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

// Is `child` a strict descendant of `parent`? Used by drag-and-drop
// (block dropping a parent into one of its descendants — would orphan
// the subtree) and by the folder-delete cascade.
export function isStrictDescendant(child: string, parent: string): boolean {
  if (!parent || child === parent) return false;
  return child.startsWith(parent + '/');
}

// Folder name (last segment) of a path. "Backend/API" → "API".
export function folderName(path: string): string {
  const parts = splitFolderPath(path);
  return parts[parts.length - 1] ?? '';
}

// Parent path. "Backend/API" → "Backend". Returns "" for top-level.
export function parentPath(path: string): string {
  const parts = splitFolderPath(path);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

// Migration helper: derive the set of known folder paths from a list
// of configs. Used when run.json doesn't have a `groups` array (older
// files, or never set). Every prefix of every config.group is a known
// folder so the tree renders the full nested structure.
export function deriveKnownFolders(
  groupStrings: Iterable<string | undefined>,
): string[] {
  const seen = new Set<string>();
  for (const g of groupStrings) {
    if (!g) continue;
    for (const p of ancestorPaths(g)) seen.add(p);
  }
  // Stable order so the persisted list is human-readable.
  return Array.from(seen).sort();
}

// True when the given input is a valid folder path. Mirrors the zod
// FolderPathSchema check but exposed as a sync predicate for UI form
// validation (input-box on subfolder creation).
export function isValidFolderPath(p: string): boolean {
  if (!p || !p.trim()) return false;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  if (p.includes('//')) return false;
  return p.split('/').every(s => s.trim().length > 0);
}
