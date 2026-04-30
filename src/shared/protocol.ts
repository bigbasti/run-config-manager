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
  | { cmd: 'refreshContainers' }
  // Re-run port detection for the current config. The webview fires this
  // after the user edits a field that changes which file we read
  // (Spring Boot / Quarkus: profiles). The extension reads the relevant
  // application-*.properties/yml and replies with a configPatch that
  // sets the top-level `port` when found.
  | { cmd: 'detectPort'; config: RunConfig }
  // Read the user's active Maven settings.xml or Gradle gradle.properties and
  // return proxy host/port plus the path of the file we'd open on click.
  // Fired whenever the form's buildTool (or projectPath, for Gradle's
  // project-root fallback) changes so the panel stays in sync.
  | {
      cmd: 'loadBuildToolSettings';
      buildTool: 'maven' | 'gradle' | 'npm';
      projectPath: string;
      // Absolute path of the currently-selected Maven / Gradle installation
      // (whichever matches `buildTool`). The service uses it to locate
      // install-level settings files — switching the install dropdown in the
      // form changes which proxy config is active.
      mavenPath?: string;
      gradlePath?: string;
    }
  // Open the active settings file in a new editor tab. The path comes from
  // the preceding `buildToolSettings` reply so the webview doesn't need to
  // know about the filesystem at all.
  | { cmd: 'openSettingsFile'; filePath: string };

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
  | {
      cmd: 'configPatch';
      patch: Partial<RunConfig>;
      // When true, values in `patch` overwrite existing values instead of
      // only filling blanks. Used by the port re-detect flow on profile
      // changes, where the new value IS authoritative for the current
      // profile. Defaults to false (blanks-only) for streaming detection
      // that shouldn't clobber user edits.
      force?: boolean;
    }
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
  // Result of a `loadBuildToolSettings` request — the info panel rendered
  // under the save/cancel buttons uses this directly.
  | {
      cmd: 'buildToolSettings';
      buildTool: 'maven' | 'gradle' | 'npm';
      activeFilePath?: string;
      // Human-readable label for where the values were read from. Used for
      // env-var sources that don't have a file path to show — e.g.
      // "HTTPS_PROXY env var". Absent when `activeFilePath` already answers
      // the "where" question.
      sourceLabel?: string;
      proxyHost: string | null;
      proxyPort: number | null;
      // Raw nonProxyHosts string from the active file / NO_PROXY env var.
      // Null when not set.
      nonProxyHosts: string | null;
      // Lower-precedence files that exist on disk but are shadowed by the
      // active file. Lets the UI show "your user-home file is winning —
      // these other files exist but aren't being read". Empty when the
      // active file has no overrides underneath (or when there is no
      // active file at all).
      overriddenFiles: Array<{
        filePath: string;
        proxyHost: string | null;
        proxyPort: number | null;
        nonProxyHosts: string | null;
        tier: string;
      }>;
      note?: string;
      searchedPaths: string[];
    }
  | { cmd: 'error'; message: string };
