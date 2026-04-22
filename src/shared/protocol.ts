import type { RunConfig } from './types';
import type { FormSchema } from './formSchema';

export type Outbound =
  | { cmd: 'ready' }
  | { cmd: 'save'; config: RunConfig }
  | { cmd: 'cancel' }
  | { cmd: 'pickFolder'; current?: string }
  | { cmd: 'recomputeClasspath'; config: RunConfig }
  | { cmd: 'testVariables'; config: RunConfig };

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
  | { cmd: 'error'; message: string };
