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
  | { cmd: 'openSettingsFile'; filePath: string }
  // Open the JDK download dialog: webview asks for the list of distros +
  // packages so it can render the vendor/version selects. The reply comes
  // back as `jdkDownloadList`.
  | { cmd: 'listJdkDownloads' }
  // Refresh packages for one distro (when the user switches the vendor
  // dropdown) — keeps the initial list call cheap.
  | { cmd: 'listJdkPackages'; distro: string }
  // Kick off download + extract. Replies arrive as a stream of
  // `jdkDownloadProgress` messages followed by `jdkDownloadComplete`,
  // `jdkDownloadError`, or `jdkDownloadNeedsConfirmation` (when the
  // package didn't carry a checksum and the dialog should prompt the
  // user before continuing).
  // `allowUnverified` is set on the second attempt after the user has
  // explicitly clicked "Install anyway".
  | { cmd: 'downloadJdk'; packageId: string; distro: string; allowUnverified?: boolean }
  // Cancels the in-flight install. Server emits `jdkDownloadError` with a
  // cancelled message when complete.
  | { cmd: 'cancelJdkDownload' }
  // File picker scoped for .env files. Reply comes back as `envFilePicked`
  // with the workspace-relative path so the form's envFiles list can be
  // appended to.
  // Open the Tomcat download dialog. Reply: tomcatDownloadList carrying
  // the discovered major lines (and the first major's versions for
  // immediate render).
  | { cmd: 'listTomcatDownloads' }
  | { cmd: 'listTomcatVersions'; major: number }
  | { cmd: 'downloadTomcat'; major: number; version: string }
  | { cmd: 'cancelTomcatDownload' }
  | { cmd: 'pickEnvFile' }
  // Loads (or reloads) the listed .env files and reports per-file status
  // + parsed variables. Fired on init/edit/add/remove so the form pills
  // always reflect the current files-on-disk.
  | { cmd: 'loadEnvFiles'; paths: string[] };

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
  // Distros + initial packages for the JDK download dialog. Sent in
  // response to `listJdkDownloads`. `packagesByDistro` carries the
  // first-loaded distro's package list so the dialog can render right away.
  | {
      cmd: 'jdkDownloadList';
      distros: Array<{ apiName: string; label: string }>;
      packagesByDistro: Record<string, JdkPackageDto[]>;
      // Absolute path of the directory the installer will extract into.
      // Shown in the dialog so the user knows where the new JDK will land
      // before they click Download.
      installRoot: string;
    }
  // Reply to `listJdkPackages` for one distro at a time.
  | { cmd: 'jdkPackageList'; distro: string; packages: JdkPackageDto[] }
  | {
      cmd: 'jdkDownloadProgress';
      state: 'downloading' | 'verifying' | 'extracting';
      // 0..1; null when state has no measurable progress.
      fraction: number | null;
      detail?: string;
    }
  | {
      cmd: 'jdkDownloadComplete';
      jdkHome: string;
      versionLabel: string;
      distro: string;
    }
  | { cmd: 'jdkDownloadError'; message: string; cancelled?: boolean }
  // The package didn't carry a SHA-256. The dialog renders a confirmation
  // panel and, if the user clicks "Install anyway", re-issues `downloadJdk`
  // with `allowUnverified: true`. The archive has already been downloaded
  // at this point — extraction is what's gated on the user's answer.
  | { cmd: 'jdkDownloadNeedsConfirmation'; message: string }
  // Reply to `pickEnvFile`. Path is workspace-relative when the picked
  // file lives under the workspace folder, absolute otherwise.
  | {
      cmd: 'tomcatDownloadList';
      majors: Array<{ major: number; label: string }>;
      versionsByMajor: Record<number, TomcatVersionDto[]>;
      installRoot: string;
    }
  | { cmd: 'tomcatVersionList'; major: number; versions: TomcatVersionDto[] }
  | {
      cmd: 'tomcatDownloadProgress';
      state: 'downloading' | 'verifying' | 'extracting';
      fraction: number | null;
      detail?: string;
    }
  | {
      cmd: 'tomcatDownloadComplete';
      tomcatHome: string;
      version: string;
      major: number;
    }
  | { cmd: 'tomcatDownloadError'; message: string; cancelled?: boolean }
  | { cmd: 'envFilePicked'; path: string }
  // Reply to `loadEnvFiles`. Per-file status with variables so the UI can
  // render orange "missing" rows and feed the eye-icon dialog.
  | {
      cmd: 'envFilesLoaded';
      files: Array<{
        path: string;
        loaded: boolean;
        // Number of vars parsed; convenience for the file pill so the
        // webview doesn't have to count.
        count: number;
        // Map of vars when loaded. Sent so the eye-icon dialog can render
        // without an extra round-trip per click.
        variables: Record<string, string>;
        error?: 'missing' | 'parse-error' | 'read-error';
        errorDetail?: string;
      }>;
    }
  | { cmd: 'error'; message: string };

// DTO mirrors TomcatPackage; install dir name is computed server-side
// for parity with the JDK dialog's preview.
export interface TomcatVersionDto {
  major: number;
  version: string;
  versionLabel: string;
  installDirName: string;
}

// DTO mirrors JdkPackage but only the fields the UI uses, so we don't ship
// internal foojay metadata (sha256, directUrl) over the postMessage channel.
export interface JdkPackageDto {
  id: string;
  distro: string;
  versionLabel: string;
  majorVersion: number;
  // Display filename (informational; user sees "amazon-corretto-21.tar.gz").
  filename: string;
  size: number;
  lts: boolean;
  // Pre-computed friendly directory name (e.g. "azul-zulu-25"). Kept in
  // the DTO so the dialog can render the full target path next to the
  // current selection without duplicating the slug logic on the webview
  // side. Composed with `installRoot` to form the full preview path.
  installDirName: string;
}
