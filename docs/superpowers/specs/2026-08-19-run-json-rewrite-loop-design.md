# run.json rewrite loop — fix + migration backups

Date: 2026-08-19
Status: designed, approved

## Problem

After `f92737d "bump to 1.0.0"` (a one-line `package.json` change), users report
`.vscode/run.json` blinking in the explorer and this repeating in the output
channel roughly every 400 ms:

```
09:13:33.971 [info]  run.json migration: 0.0.0 → 0.6.3
09:13:33.971 [debug] Loaded …/run.json: 1 configuration(s), 0 folder(s), version 1.0.0
09:13:34.384 [info]  run.json migration: 0.0.0 → 0.6.3
…
```

At least one user also lost the contents of their `run.json`.

## Root cause

`migrateRaw()` in `ConfigStore.ts` coerces legacy pre-semver versions down to
`"0.0.0"` so registered migrations still run. The guard is:

```ts
|| (typeof parsed.version === 'string' && /^1(\.0)?(\.0)?$/.test(parsed.version))
```

That regex matches `"1"`, `"1.0"` **and `"1.0.0"`**. The comment on the branch
states the assumption it was written under — "newer than any *pre-1.0.0*
extension" — which held until the extension itself became exactly `1.0.0`.

The loop:

1. `write()` stamps `"version": "1.0.0"` (`runMigrations` returns
   `finalVersion = EXTENSION_VERSION`).
2. The `FileSystemWatcher` fires → 200 ms debounce → `reload()`.
3. `migrateRaw()` rewrites the on-disk `"1.0.0"` to `"0.0.0"`.
4. `versionStale = "0.0.0" !== "1.0.0"` → true.
5. `reload()` writes the file back → step 1. Forever.

`contentChanged` is false throughout (the only registered migration, the
`closeTerminalOnExit` backfill, is idempotent), so `versionStale` alone drives
the loop — exactly the condition the surrounding comment was written to avoid.

### Why the log reads `0.0.0 → 0.6.3` while the file says `1.0.0`

Two different values, both correct:

- `migrations.ts` logs `m.from → m.to`, the registry entry's declared literals.
  `m.from` is never compared against anything — applicability is decided purely
  by `m.to`. So the line is constant regardless of what is on disk.
- The `Loaded …` line prints `finalVersion`, which is always
  `EXTENSION_VERSION`.

### Why a run.json could be emptied

Every writer does read-modify-write off `store.getForFolder()`. The atomic
`writeFile(tmp)` + `rename` leaves a window where `run.json` does not exist. A
`reload()` read landing in that window hits the catch-all in `reload()`, which
sets `entry.file = EMPTY`. Any subsequent write — a user edit, or the docker
heal subscribed to `store.onChange` — then persists that emptiness.

## Design

### A1. Narrow the legacy-version coercion (primary fix)

Coerce to `"0.0.0"` only for genuine pre-semver forms: the number `1`,
`undefined`, `null`, and the bare strings `"1"` / `"1.0"`. A complete 3-part
semver is treated as a real version.

Accepted trade-off: a hand-edited file literally containing `"1.0.0"` from the
pre-semver era skips the `0.6.3` `closeTerminalOnExit` backfill. That backfill
is cosmetic; an infinite rewrite loop is not.

### A2. Skip byte-identical writes (defence in depth)

`ConfigStore.write()` reads the current target and skips the physical
`writeFile` + `rename` when the encoded bytes are unchanged. `entry.file` is
still updated and `onChange` still fires, so callers see no behavioural
difference. This makes any future load-triggered write structurally incapable
of looping, whatever its cause.

### A3. Do not clobber state on transient read errors

`reload()` distinguishes "file does not exist" (→ `EMPTY`, as today) from any
other read failure (→ keep the previous `entry.file`, log a warning).

### B. Archive on migration

New module `src/services/configBackup.ts`.

- `backupFileName(folderName, when)` — pure. Returns
  `dds2_run.json_2026-08-19_09-13-33`. The folder name is sanitised to
  `[A-Za-z0-9._-]`; every other character becomes `_`.
- `archiveRunJson(...)` — creates `~/.run-configs/` when absent and writes the
  file. Best-effort: catches everything, logs a warning, returns `false`.
  Never blocks a migration.

Triggered from `reload()` only when `result.contentChanged` is true, and it
archives the **original raw bytes as read from disk**, before the write-back.
Version-stamp-only rewrites produce no backup. No pruning — backups accumulate.

Injection: `new ConfigStore(opts?: { backupHomeDir?: string; now?: () => Date })`,
defaulting to `os.homedir()` and `Date`, so tests can point at the mock FS.

## Testing

`test/configBackup.test.ts` — filename format, sanitisation, directory
creation, failures swallowed and warned.

`test/ConfigStore.test.ts`:

- regression: loading a `version: "1.0.0"` file performs zero writes
- legacy `version: 1` still coerces and migrates
- identical-content `write()` performs no rename; changed content does
- a non-FileNotFound read error leaves `entry.file` intact
- a content-changing migration writes an archive to the fake home dir
- the assertion at line 66, inverted by the version bump, is corrected

Mock additions: `workspace.fs.createDirectory`, and a hook to make `readFile`
throw a non-FileNotFound error.
