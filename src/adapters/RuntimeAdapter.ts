import * as vscode from 'vscode';
import type { DebugConfiguration } from 'vscode';
import type { RunConfig, RunConfigType } from '../shared/types';
import type { FormSchema } from '../shared/formSchema';

export interface DetectionResult {
  defaults: Partial<RunConfig>;
  // Arbitrary adapter-specific data used to shape the form (e.g., list of scripts).
  context: Record<string, unknown>;
}

export interface RuntimeAdapter {
  readonly type: RunConfigType;
  readonly label: string;

  // Whether this adapter can produce a working debug configuration for v1.
  // Adapters that return false have their Debug button hidden in the tree.
  readonly supportsDebug: boolean;

  // Whether creating this config type should prompt the user to select a
  // project root folder before the editor opens. Defaults to true (undefined
  // is treated as true). Adapters that don't require a folder (e.g.
  // http-request, docker, custom-command, maven-goal, gradle-task) set this
  // to false; the workspace root is used as projectPath and the user can
  // adjust it in the form.
  readonly needsFolderPick?: boolean;

  detect(folder: vscode.Uri): Promise<DetectionResult | null>;

  // Optional streaming detection: adapters that can stream partial results
  // (e.g., fast "is this a Spring Boot project?" check, then slow main-class
  // scan / JDK probe in parallel) implement this. Each call to `emit` posts
  // a patch to the already-open editor webview.
  detectStreaming?(
    folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void>;

  getFormSchema(context: Record<string, unknown>): FormSchema;

  buildCommand(
    cfg: RunConfig,
    // Optional: the resolved workspace folder, used by adapters that need to
    // turn relative projectPath into an absolute filesystem path (e.g.,
    // Gradle's :<module>:task scoping).
    folder?: vscode.WorkspaceFolder,
  ): { command: string; args: string[] };

  // Optional pre-launch hook. Runs after variable resolution but before
  // buildCommand. Adapters can set up filesystem state (CATALINA_BASE for
  // Tomcat, classpath reshuffle, etc.) and contribute additional env vars
  // that flow into ShellExecution.
  prepareLaunch?(
    cfg: RunConfig,
    folder: vscode.WorkspaceFolder,
    ctx: PrepareContext,
  ): Promise<PrepareResult>;

  // Only required when supportsDebug === true. Adapters that don't support
  // debug can omit this method.
  getDebugConfig?(cfg: RunConfig, folder: vscode.WorkspaceFolder): DebugConfiguration;
}

export interface PrepareContext {
  // True when the launch is for debug, false for a normal run. Adapters use
  // this to wire in JDWP agent flags, enable JMX differently, etc.
  debug: boolean;
  // Resolved debug port that the caller will attach to. Tomcat uses this to
  // set JPDA_ADDRESS.
  debugPort?: number;
  // NEW — when true, the adapter should inject JMX flags via its
  // canonical env channel (JAVA_TOOL_OPTIONS / vmArgs / CATALINA_OPTS).
  // ExecutionService reads `monitorPort` and ensures the bundled
  // agent connects to the same port after launch.
  monitor?: boolean;
  monitorPort?: number;
  // NEW — for Node monitoring: absolute path to the bundled in-process agent.
  // When present (npm + monitor), the npm adapter injects NODE_OPTIONS=--require.
  nodeAgentPath?: string;
}

export interface PrepareResult {
  // Additional env vars merged on top of cfg.env + process.env.
  env?: Record<string, string>;
  // Working directory override. When set, takes precedence over ExecutionService's
  // default buildCwd logic.
  cwd?: string;
  // Extra command-line arguments prepended to the buildCommand result.
  // Used by Spring Boot debug to ship `--init-script <path>` to gradle —
  // the init script attaches the JDWP agent to bootRun's forked JVM only,
  // not to the gradle daemon (which would otherwise win the port-bind
  // race when JDWP is set via JAVA_TOOL_OPTIONS).
  extraArgs?: string[];
  // Replacement config for buildCommand — used when prepareLaunch needed
  // to compute or update something the adapter would otherwise have to
  // read from a stale cfg (e.g. Spring Boot's "Recompute classpath on
  // each run" recomputes and rewrites typeOptions.classpath right
  // before launch). When omitted, ExecutionService uses the original
  // resolvedCfg.
  cfg?: import('../shared/types').RunConfig;
}

// A streaming patch: adapters emit one of these whenever a piece of detection
// completes. `contextPatch` is merged into the detection context (used to
// rebuild the form schema); `defaultsPatch` seeds fields that are blank in the
// current config (useful for create mode — pre-filling the first main class or
// JDK once found).
export interface StreamingPatch {
  contextPatch: Record<string, unknown>;
  defaultsPatch?: Partial<RunConfig>;
  // Field keys whose detection just completed (used by the webview to hide
  // the spinner for those fields).
  resolved?: string[];
}
