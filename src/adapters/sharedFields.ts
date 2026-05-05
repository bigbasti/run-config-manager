import type { FormField } from '../shared/formSchema';

// Produces a "Depends on" dependencyList field from a flat options list that
// the EditorPanel assembles before building the schema. Options are already
// grouped (run-configs / launch / task) and filtered to exclude the config
// currently being edited. Kept as a shared helper so every adapter's
// advanced section has the same wording.
// Shared `.env` files field used by every adapter that has an env table.
// Lives directly above the kv env editor so users see it as a related
// "vars come from these sources" affordance. Stores a string[] of paths
// on the saved config; the loaded variables are NOT persisted (UI counts
// + run-time merge come from a fresh load each time).
export function envFilesField(): FormField {
  return {
    kind: 'envFileList',
    key: 'envFiles',
    label: '.env files',
    help:
      'Load environment variables from one or more .env files. Files are loaded fresh ' +
      'on every run, so editing a file takes effect without re-saving the config. ' +
      'Files are loaded top-to-bottom — when two files declare the same key, the later ' +
      'file wins. The "Environment variables" table below has the highest priority and ' +
      'overrides any values from .env files. ' +
      'Variables are merged in this order at launch: process env → .env files (top to bottom) → table below → adapter overrides. ' +
      'A missing file is highlighted in orange and skipped at run time (the launch continues). ' +
      'Supported syntax: KEY=value, # comments, single/double quotes, and a leading `export `. ' +
      'Inline ${OTHER} expansion is intentionally NOT supported — keep values literal.',
  };
}

export function dependsOnField(
  options: Array<{ value: string; label: string; group?: string; description?: string }>,
): FormField {
  return {
    kind: 'dependencyList',
    key: 'dependsOn',
    label: 'Depends on',
    options,
    help:
      'Configurations that must be started before this one. The runner walks the list in order — ' +
      'each dependency is started and waited on until it reaches a running state, then the delay ' +
      '(in seconds) elapses, then the next step runs. ' +
      'Recursive: a dependency with its own dependencies triggers them first. Cycles are detected at run time.',
  };
}
