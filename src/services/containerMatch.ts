// Shared by DockerService.find and the config self-healer. Deliberately has no
// imports — the healer must stay free of `vscode`, and DockerService.ts pulls
// `vscode` in at the top of the file.
//
// Docker reports full 64-char ids, but users routinely save the 12-char short
// form because that is what plain `docker ps` prints and what they copy. So
// compare prefixes. `DockerService.poll` hardcodes `--no-trunc`, so
// `summaryId` is always the full id or '' and only the
// `summaryId.startsWith(storedId)` direction is reachable through `find`;
// comparing both ways is a defensive symmetry contract, not a case Docker
// actually produces on that path.
//
// Both sides must be non-empty. `poll` defaults a row's id to '' when the
// parsed `docker ps` JSON has no ID key, and `anything.startsWith('')` is
// true — so a blank reported id would otherwise match every stored id, and
// every docker config would render as "found but stopped" instead of
// "not found".

// `summaryId` — as reported by `docker ps`; `storedId` — as saved in run.json.
// The predicate is symmetric, so the order is documentation only. If you ever
// make it asymmetric, audit every call site: nothing here would catch a swap.
export function containerIdMatches(summaryId: string, storedId: string): boolean {
  if (!summaryId || !storedId) return false;
  return summaryId.startsWith(storedId) || storedId.startsWith(summaryId);
}
