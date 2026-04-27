import type { FormField } from '../shared/formSchema';

// Produces a "Depends on" dependencyList field from a flat options list that
// the EditorPanel assembles before building the schema. Options are already
// grouped (run-configs / launch / task) and filtered to exclude the config
// currently being edited. Kept as a shared helper so every adapter's
// advanced section has the same wording.
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
