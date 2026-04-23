# Maven Goal + Gradle Task Adapters — Design

## Summary

Two new runtime types, `'maven-goal'` and `'gradle-task'`, for one-click execution of specific build-tool invocations that aren't "run the application." Used for Liquibase tasks, clean installs, test filters, formatters, code-gen goals — anything the user runs often enough to want a saved launcher. Includes **task discovery** via an in-editor action that reads the project's task list and presents it grouped by Gradle group / populated with Maven lifecycle phases.

As a side quest: the "Add configuration" flow now pre-fills the config name from the chosen folder for every runtime type.

## Motivation

Developers routinely run `./gradlew dropAll`, `mvn clean install`, `./gradlew :systemtest:test --tests "..."` — repetitive commands that don't fit any existing config type. The Java adapter's `gradle-custom` / `maven-custom` launch modes cover this functionally, but users shopping the "Add" dialog don't think of "run a Liquibase task" as a "Java Application" — they think of it as a "Gradle task." Discoverability matters.

## Constraints & decisions (from brainstorming Q1–Q3)

- **Q1 task discovery:** on-demand, cached. Editor shows a text input plus a "Load tasks" action button. Clicking runs the discovery command (slow — Gradle daemon); result is cached in the workspace `Memento` so subsequent edits are instant. No discovery at editor open — keeps the create flow fast for users who know the task name.
- **Q2 Maven field shape:** single field for both phases and goals. User types `clean install` or `liquibase:dropAll -Durl=…`; no artificial phase-vs-goal split in the UI. Mirrors Gradle's single task-name box.
- **Q3 adapter structure:** new dedicated types, not launch modes on the Java adapter. Discoverability in the Add dialog wins over code savings.
- **Name prefill (follow-up):** applied to every runtime type, not just the new two. Derived from the selected project folder's basename. The existing `mergeBlanks` semantics in the webview keep user edits over the default.

## Architecture

### 1. Shared types (`src/shared/types.ts`)

Add two entries to `RunConfigType`:

```ts
export type RunConfigType = 'npm' | 'spring-boot' | 'tomcat' | 'quarkus' | 'java' | 'maven-goal' | 'gradle-task';
```

Two new type-options interfaces:

```ts
export interface MavenGoalTypeOptions {
  // Free-form command tail passed to mvn — "clean install", "verify -Pprod",
  // "liquibase:dropAll -Durl=jdbc:…". Shell-split, so quoted values survive.
  goal: string;
  jdkPath: string;
  mavenPath: string;
  buildRoot: string;
  colorOutput?: boolean;
}

export interface GradleTaskTypeOptions {
  // Free-form command tail for ./gradlew — ":api:test --tests \"pkg.*\"",
  // "dropAll", "clean build -x test".
  task: string;
  gradleCommand: GradleCommand;
  jdkPath: string;
  gradlePath: string;
  buildRoot: string;
  colorOutput?: boolean;
}
```

Extend `RunConfig`:

```ts
export type RunConfig =
  | …
  | (RunConfigBase & { type: 'maven-goal'; typeOptions: MavenGoalTypeOptions })
  | (RunConfigBase & { type: 'gradle-task'; typeOptions: GradleTaskTypeOptions });
```

### 2. Schema (`src/shared/schema.ts`)

Two discriminated-union cases with `superRefine`:

- `maven-goal`: `goal` must be non-empty (trimmed).
- `gradle-task`: `task` must be non-empty.

### 3. Adapters

**`src/adapters/maven-goal/MavenGoalAdapter.ts`**

- `type='maven-goal'`, `label='Maven Goal'`, `supportsDebug=false`.
- `detect(folder)`: returns non-null when `pom.xml` exists. Unlike the Java adapter, does NOT bail on Spring Boot / Quarkus markers — running `mvn clean install` on a Spring Boot project is a valid use case. Auto-create skips these anyway (see §7).
- `detectStreaming(folder, emit)`: fast pom check, then parallel JDK + Maven install + build-root probes.
- `getFormSchema(context)`:
  - Common: name, projectPath.
  - Type-specific: `goal` (selectOrCustom, inspectable) — options come from `loadedGoals` in context, populated via the `loadGoals` action; `mavenPath` (selectOrCustom), `buildRoot` (text), `jdkPath` (selectOrCustom).
  - Advanced: env, colorOutput.
  - Action on `goal` field: `{ id: 'loadGoals', label: 'Load lifecycle phases & plugin goals', busyLabel: 'Loading…' }`.
- `buildCommand(cfg)`: `{ command: mvn-binary, args: splitArgs(cfg.typeOptions.goal) }`.
- `prepareLaunch`: sets `JAVA_HOME` if `jdkPath`, `FORCE_COLOR=1` / `CLICOLOR_FORCE=1` if `colorOutput`.

**`src/adapters/gradle-task/GradleTaskAdapter.ts`**

- `type='gradle-task'`, `label='Gradle Task'`, `supportsDebug=false`.
- `detect(folder)`: returns non-null when `build.gradle` / `build.gradle.kts` / `gradlew` exists at the folder or a parent (via `findGradleRoot`).
- `detectStreaming`: parallel JDK + Gradle install + build-root + `gradleCommand` probes.
- `getFormSchema(context)`:
  - Common: name, projectPath.
  - Type-specific: `task` (selectOrCustom, inspectable) — options from `loadedTasks`; `gradleCommand` (select), `gradlePath` (selectOrCustom), `buildRoot` (text), `jdkPath` (selectOrCustom).
  - Advanced: env, colorOutput.
  - Action on `task` field: `{ id: 'loadTasks', label: 'Load tasks from Gradle', busyLabel: 'Loading…' }`.
- `buildCommand(cfg, folder?)`: `{ command: gradle-binary, args: ['--console=plain', ...splitArgs(cfg.typeOptions.task)] }`. Multi-module scoping via `gradleModulePrefix` is NOT applied — the user types the fully-qualified task name if they want module scoping (`:api:test`).
- `prepareLaunch`: `JAVA_HOME`, color forcing (Gradle's `--console=plain` strips color, so `FORCE_COLOR=1` only affects the forked JVM inside the task).

### 4. Task/goal discovery

**`src/adapters/gradle-task/discoverGradleTasks.ts`** — runs `<gradle-bin> --console=plain -q tasks --all` in the given cwd with a 60s timeout. Parses the canonical output:

```
Build tasks
-----------
assemble - Assembles the outputs of this project.
classes - Assembles main classes.

Liquibase tasks
---------------
dropAll - Drop all database objects …
update - Apply all pending changesets …
```

Group headers are lines immediately followed by `---`-style underline. Tasks are indented `name - description` lines. Returns `Array<{ group: string; name: string; description: string }>`. Failures (timeout, non-zero exit) resolve to `[]` with the error logged and surfaced to the webview as an error message.

**`src/adapters/maven-goal/discoverMavenGoals.ts`** — Maven lacks a cheap universal "list all goals" command. Strategy:

1. Seed with standard lifecycle phases: `clean`, `validate`, `compile`, `test`, `package`, `verify`, `install`, `site`, `deploy`.
2. Parse the project's `pom.xml` for `<plugin>` declarations; emit each as `<artifactId>:` (a prefix the user completes).
3. If the user needs a specific goal, the text input accepts any string.

Much cheaper than `mvn help:effective-pom` (which touches the network for snapshot resolution) and gives the user 90% of what they'd want from a list.

**Caching:** discovered results are stored per-project in the `ConfigStore`'s workspace `Memento` under a key like `rcm.gradleTasks:<buildRoot>`. Invalidated when the user clicks Load again (explicit refresh) or when the corresponding build file's mtime changes.

### 5. Editor integration

New webview message:

```ts
// extension → webview: already have 'schemaUpdate' for adding options
// webview → extension: new message
{ cmd: 'loadTasks', adapter: 'gradle-task' | 'maven-goal', config: RunConfig }
```

`EditorPanel.handleMessage` grows a `case 'loadTasks'`: it calls the adapter's discovery helper, stores results in the detection context (`loadedTasks` / `loadedGoals`), and fires a `schemaUpdate` so the form re-renders with the new selectOrCustom options. The busy state on the action button is already supported via `busyActionId` in the form schema.

The `FormField.action` shape already exists (Spring Boot's `recomputeClasspath` uses it). Reusing it means no new widget code in the webview — just wire a new action id to a new extension-side handler.

### 6. Name prefill

In `extension.ts` `addConfig`, after the user picks type + projectPath, compute a default name:

```ts
const basename = projectUri.fsPath.split(/[/\\]/).filter(Boolean).pop() ?? folder.name;
const pretty = basename.charAt(0).toUpperCase() + basename.slice(1);
const typeLabel = registry.get(typePick.value)!.label;
const defaultName = `${pretty} ${typeLabel}`;
// Examples:
//   folder "api", type spring-boot  → "Api Spring Boot"
//   folder "web", type npm          → "Web npm / Node.js"
//   folder "",   type maven-goal    → "<workspace-folder> Maven Goal"
```

The value becomes part of `seedDefaults.name`. The webview's `mergeBlanks` already treats blank/undefined as "fill from defaults" — so name prefill works without any webview changes. Typing over it is seamless.

Old `deriveConfigName` in `autoCreateConfigs` stays separate (it uses a different suffix mapping — "API", "Web", etc. — because auto-create is bulk-style).

### 7. Auto-create + tree + registration

- **Auto-create priority:** unchanged `['spring-boot', 'quarkus', 'tomcat', 'java', 'npm']`. Neither of the new types participate — these are user-authored by definition. Adding "bulk-create a Maven Goal config" would spam useless `clean install` entries.
- **Tree icons:** `maven-goal` → `'tools'`; `gradle-task` → `'symbol-event'` (distinct from Java's `symbol-class`, Spring Boot's `rocket`, Quarkus's `zap`, Tomcat's `server-environment`, npm's `package`).
- **Labels:** `'Maven Goal'` / `'Gradle Task'`.
- **Registration:** `extension.ts` registers both adapters. Auto-create's priority constant excludes them.

### 8. `sanitizeConfig` + `buildCommandPreview`

- `sanitizeConfig` gets two new branches preserving the respective typeOptions shape. Exhaustiveness guard catches regressions.
- `buildCommandPreview`:
  - `maven-goal`: `mvn <goal || '<goal>'>`.
  - `gradle-task`: `<gradleCommand> --console=plain <task || '<task>'>`.

### 9. readyPatterns / failurePatterns

Both types return **empty** ready patterns — goals/tasks are short-lived; "started" is not meaningful, and the tree naturally returns to idle when the process ends. Failure patterns: only `SHARED_BUILD_TOOL_FAILURES` (`BUILD FAILED` / `BUILD FAILURE`). Anything type-specific would be wrong here because the user's task could produce arbitrary output.

## Test plan

- `test/MavenGoalAdapter.build.test.ts`: command matrix for `mvn <goal>` including multi-token goals (`clean install`), goals with quoted args, profiles (`-P` flags).
- `test/GradleTaskAdapter.build.test.ts`: `./gradlew --console=plain <task>` with multi-token tasks, `:module:` prefixes, `--tests "..."` quoted values, gradlePath binary override.
- `test/discoverGradleTasks.test.ts`: parses realistic sample output (group headers, tasks, blank lines, "No tasks for project" edge case). Mocked process for the discovery call.
- `test/discoverMavenGoals.test.ts`: parses a sample pom.xml with `<plugin>` entries, emits prefixes + phases.
- `test/sanitizeConfig.test.ts`: round-trip both new types through Zod.
- `test/schema.test.ts`: accept valid configs, reject ones with empty goal/task.
- `test/readyPatterns.test.ts`: empty ready patterns for both; BUILD FAILED matches.
- `test/extension.test.ts` (if one exists) — or inline check that name prefill produces the expected string. If no extension test harness exists, a `test/deriveDefaultName.test.ts` extracting the helper as a pure function.

## Documentation

- `docs/LLM_ONBOARDING.md`: add both types to the `RunConfigType` list; new bullets under "Distinctive behaviors per adapter" for both; update the adapters directory tree; note the discovery pattern as a reusable pattern for future adapters.

## Out of scope

- Maven goal enumeration via `help:effective-pom` — too slow, requires network.
- Sequential task chaining (`clean && test` on multiple mvn invocations) — user types space-separated goals; Maven handles it natively.
- Debug mode — `supportsDebug=false`; goals/tasks aren't long-running servers.
- Gradle composite build support for cross-project task names. User-typed fully-qualified names still work; discovery reads only the current project.

## Risks & tradeoffs

- **First `Load tasks` click is slow.** Users on cold Gradle daemons will wait 10–30 seconds. Mitigated by: (a) explicit user action (not auto), (b) per-project cache, (c) loading spinner on the action button. A message like "This can take up to a minute on a cold Gradle daemon" in the help text.
- **Gradle output format varies across versions.** `tasks --all` has been stable since Gradle 3.x but minor format drift is possible. Parser is tolerant (blank-line-separated sections, underline-based headers); falls back to empty list on parse errors with the raw output logged.
- **Maven goal list is a prefix, not a precise list.** User still has to know `liquibase:dropAll` once they've seen `liquibase:` in the dropdown. Alternative (enumerate via `help:describe` per plugin) is too slow. Documenting this in the help text is enough.
- **Name prefill affects all existing types.** Users editing existing configs unaffected (only `create` mode applies). Users creating new configs may now see a default name where none appeared before — strictly better.

## Estimated size

- ~350 lines of new adapter code across `MavenGoalAdapter.ts` and `GradleTaskAdapter.ts`.
- ~150 lines of discovery helpers.
- ~50 lines of schema/type additions.
- ~40 lines of EditorPanel `loadTasks` handler + caching.
- ~200 lines of new tests.
- ~20 lines of doc updates.

Total ~810 LOC net new.
