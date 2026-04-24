import type { RunConfig } from './types';
import type { FormSchema } from './formSchema';

export type Outbound =
  | { cmd: 'ready' }
  | { cmd: 'save'; config: RunConfig }
  | { cmd: 'cancel' }
  | { cmd: 'pickFolder'; current?: string }
  | { cmd: 'recomputeClasspath'; config: RunConfig }
  | { cmd: 'testVariables'; config: RunConfig }
  // Triggered by the "Load tasks"/"Load goals" action button on the
  // gradle-task / maven-goal forms. Response comes back as a schemaUpdate
  // with the goal/task options populated.
  | { cmd: 'loadTasks'; config: RunConfig }
  // Fired on blur of the projectPath field for adapters whose form
  // declared `validateBuildPath` on that field. Response comes back as
  // a `projectPathValidated` with a warning + optional parent-suggestion.
  | { cmd: 'validateProjectPath'; fieldKey: string; projectPath: string; buildTool: 'maven' | 'gradle' | 'either' };

// Field keys whose detection is still in flight (spinner rendered in-place).
export type PendingFields = string[];

export type Inbound =
  | {
      cmd: 'init';
      mode: 'create' | 'edit';
      config: Partial<RunConfig>;
      schema: FormSchema;
      pending?: PendingFields;
    }
  | { cmd: 'schemaUpdate'; schema: FormSchema; pending?: PendingFields }
  | { cmd: 'configPatch'; patch: Partial<RunConfig> }
  | { cmd: 'folderPicked'; path: string }
  | { cmd: 'classpathComputed'; classpath: string }
  | {
      cmd: 'variablesTested';
      unresolved: string[];
      // Small snapshot of what was available during resolution so users can see
      // what the builtins point to (helps diagnose wrong-workspace bugs).
      builtins: { workspaceFolder: string; userHome: string; cwd: string };
    }
  | {
      cmd: 'projectPathValidated';
      fieldKey: string;
      ok: boolean;
      // When !ok, a short reason the widget renders below the input.
      reason?: string;
      // When !ok and a parent folder would work, a relative-to-workspace
      // path the widget offers as a "Use <path>" button.
      suggestion?: string;
    }
  | { cmd: 'error'; message: string };
