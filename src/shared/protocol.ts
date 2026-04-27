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
  | { cmd: 'validateProjectPath'; fieldKey: string; projectPath: string; buildTool: 'maven' | 'gradle' | 'either' }
  // Fired by the Docker form when the user picks a container. The extension
  // runs `docker inspect` and replies with a schemaUpdate whose info-panel
  // content shows image/ports/volumes/etc. Kept generic so future types
  // reusing the info panel can piggyback without a new message.
  | { cmd: 'inspectContainer'; containerId: string }
  // "Refresh containers" action on the Docker form — runs `docker ps -a`
  // and replies with a schemaUpdate whose dropdown reflects the latest.
  | { cmd: 'refreshContainers' };

// Field keys whose detection is still in flight (spinner rendered in-place).
export type PendingFields = string[];

export type Inbound =
  | {
      cmd: 'init';
      mode: 'create' | 'edit';
      config: Partial<RunConfig>;
      schema: FormSchema;
      pending?: PendingFields;
      // Absolute fs path of the workspace folder this config lives in.
      // Consumed by the preview so it can compute the real cwd (which uses
      // buildRoot when set) and the Gradle `:module:task` prefix for Spring
      // Boot / Java / Quarkus configs anchored at a submodule.
      workspaceFolderPath?: string;
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
  // Field-scoped validation errors, posted on Save or Fix-open. Each entry
  // targets a specific form field by its dotted key (e.g.
  // "typeOptions.mainClass"). The webview renders a red border + the
  // message under the field. An empty array clears all field errors.
  | { cmd: 'fieldErrors'; errors: Array<{ fieldKey: string; message: string }> }
  | { cmd: 'error'; message: string };
