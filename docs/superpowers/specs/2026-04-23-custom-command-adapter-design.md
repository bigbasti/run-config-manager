# Custom Command Adapter — Design

## Summary

Eighth runtime type `'custom-command'` for running arbitrary shell commands — scripts, one-off tools, anything the user pastes from their terminal history. Shell-interpreted so operators (`&&`, `|`, `>`, globs, `$VAR`) Just Work. No framework detection, no success tracking, no debug — press play, command runs.

## Motivation

Users routinely want to save ad-hoc commands to a one-click launcher: a database seed script, a code-generator, a Docker compose invocation, a batch renamer. None of the existing types fit — they all assume either a build tool, a framework, or a language-specific invocation shape. The Java adapter's `maven-custom` / `gradle-custom` modes cover the Java subset; `custom-command` covers everything else.

## Constraints & decisions

- **Q1 shell interpretation:** run the whole string through a shell (`/bin/bash -c`, `cmd /c`). Matches user intent — paste a command from the terminal, save it, click play.
- **Q2 parameters:** `command`, optional `cwd`, `env` (base), `colorOutput`, `shell` override (default / bash / sh / zsh / pwsh / cmd), `interactive` (use ShellExecution for stdin-reading scripts).
- **Q3 icon:** `siGnubash` via the existing generator. Shell-prompt glyph is recognizable across platforms.

## Architecture

### 1. Shared types (`src/shared/types.ts`)

Add `'custom-command'` to `RunConfigType`. New options:

```ts
export type CustomShell = 'default' | 'bash' | 'sh' | 'zsh' | 'pwsh' | 'cmd';

export interface CustomCommandTypeOptions {
  // Required. Whole command string; shell-interpreted so pipes / globs /
  // operators all work. Supports the standard ${VAR} / ${env:VAR} / etc.
  // variable tokens.
  command: string;
  // Optional working-directory override. Empty = resolved projectPath.
  cwd: string;
  // Shell to invoke the command through. 'default' picks $SHELL on Unix,
  // %COMSPEC% on Windows. Explicit values let users pin to a specific
  // shell even when their default differs.
  shell: CustomShell;
  // When true, run via vscode.ShellExecution (VS Code owns the PTY —
  // enables stdin, Ctrl+C handling). When false (default), run through
  // our pseudoterminal + prettifier. Same tradeoff as Quarkus: output
  // scanning and prettified output vs interactive behaviour.
  interactive: boolean;
  colorOutput?: boolean;
}
```

Extend `RunConfig` union with the new case.

### 2. Schema (`src/shared/schema.ts`)

Discriminated-union case for `'custom-command'` with a `superRefine` requiring `command` to be non-empty (trimmed). Shell enum validated. No other cross-field constraints.

### 3. Adapter (`src/adapters/custom-command/CustomCommandAdapter.ts`)

- `type='custom-command'`, `label='Custom Command'`, `supportsDebug=false`.
- `detect(folder)`: always returns a null-defaults result — any folder is a valid place to run a custom command. Returns empty context. **Auto-create skips this type** (same rule as maven-goal / gradle-task — user-authored by definition).
- No `detectStreaming` — no async probes needed; the editor opens instantly with just the blank fields.
- `getFormSchema(context)` returns a schema with:
  - Common: name, projectPath.
  - Type-specific: `command` (textarea, inspectable, required), `cwd` (text/folderPath, optional), `shell` (select), `interactive` (boolean).
  - Advanced: env (kv), colorOutput (boolean).
- `buildCommand(cfg)` returns `{ command: resolveShell(shell), args: ['-c', cfg.typeOptions.command] }` on Unix. On Windows: `{ command: 'cmd.exe', args: ['/c', cfg.typeOptions.command] }` or `{ command: 'pwsh' / 'powershell', args: ['-Command', ...] }` when the user picked pwsh. The args are the raw command string — shell interprets.
- `prepareLaunch(cfg, folder, _ctx)`:
  - Resolve `cwd`: user override, else `projectPath` resolved against `folder`.
  - Set `FORCE_COLOR` / `CLICOLOR_FORCE` if `colorOutput`.
  - Return `{ env, cwd }`.

### 4. ExecutionService wiring

`ExecutionService.run` already picks ShellExecution vs RunTerminal based on `cfg.type === 'quarkus'`. Widen that predicate:

```ts
const useShellExecution =
  resolvedCfg.type === 'quarkus' ||
  (resolvedCfg.type === 'custom-command' && resolvedCfg.typeOptions.interactive);
```

Interactive custom commands use the full PTY (stdin works, Ctrl+C forwards, `read` prompts work). Non-interactive custom commands go through our pseudoterminal so the user still gets the prettifier, OSC 8 hyperlinks, and output logging.

**No 15-second grace timer for custom commands** — unlike Quarkus they're not servers. Tree stays in `starting` spinner until the process exits, then returns to idle. For the user's use case (one-shot scripts), this is accurate: the spinner spins while running, and the tree returns to idle on exit.

### 5. Tree / UI plumbing

- Tree icon: `'bash'` basename → `media/icons/bash.svg` (generated from `siGnubash`). Read well on both themes; no light variant needed (the bash hex is `#4EAA25` green).
- Label: `'Custom Command'`.
- `iconForGroupType` and `iconForConfig` get a `custom-command` case.

### 6. Registration + auto-create (`src/extension.ts`)

- `registry.register(new CustomCommandAdapter())`.
- Auto-create priority unchanged. Custom commands don't participate (like maven-goal / gradle-task).
- `deriveConfigName` suffix: `'Script'` (more evocative than "Custom Command" for a default name).
- `mergeAutoCreateDefaults`: add a case that never gets hit (defensive — the type is excluded from the priority list, but the exhaustiveness guard would fire if auto-create's priority ever expanded).

### 7. `sanitizeConfig` + `buildCommandPreview`

- `sanitizeConfig`: new branch preserving `command`, `cwd`, `shell`, `interactive`, `colorOutput`. Exhaustiveness guard catches regressions.
- `buildCommandPreview`: new branch — `cd <cwd> && <command>` if cwd set, else just `<command>`. Variable tokens left unresolved in the preview.

### 8. readyPatterns / failurePatterns

Both **empty** for `custom-command`. Arbitrary commands have no universal "started" or "failed" marker; non-zero exit naturally ends the task and the tree returns to idle.

### 9. Icon generator update

Add `['bash', 'siGnubash']` to `scripts/generate-icons.mjs`'s ICONS list. Regenerate. Bash hex is `#4EAA25` — bright green, reads on both themes, no light variant needed.

### 10. Tests

- `test/CustomCommandAdapter.test.ts`:
  - `detect` returns a non-null result for any folder.
  - `buildCommand`: bash / sh / zsh / pwsh / cmd all produce the expected `[shell, '-c' or '/c' or '-Command', command]` tuple.
  - `prepareLaunch`: env includes FORCE_COLOR when colorOutput; cwd override honored.
- `test/sanitizeConfig.test.ts`: new round-trip case.
- `test/schema.test.ts`: accept valid, reject empty command, reject unknown shell.
- `test/buildCommandPreview.test.ts`: no file exists today — inline the assertions in schema.test.ts or skip.

## Documentation

Add to `docs/LLM_ONBOARDING.md`:
- `'custom-command'` in `RunConfigType` list.
- New bullet in Core Types section.
- New bullet in Distinctive behaviors.

## Out of scope

- Multi-step commands with nested configs (chain-style) — use `&&` in a single command.
- Argument escaping UI — whole command is a string; user handles quoting. Same as every other shell prompt.
- Per-line output filters or redirection — VS Code's terminal handles this.

## Risks

- **User pastes a destructive command + hits play.** Not a new risk — VS Code's Run Task does the same. Name field requires a name so the user at least labels what they're running.
- **Shell variable collisions with our `${VAR}` resolver.** The resolver runs first and replaces `${foo}` tokens; after that the shell gets a plain string and can use `$VAR` (without braces) for its own expansion. `$VAR` (no braces) is passed through untouched by our resolver.
- **Windows PowerShell quoting.** Passing arbitrary strings through `-Command` can be fraught. We document this in the shell-field help text and default to `cmd.exe` on Windows.

## Estimated size

- ~150 lines adapter + small schema + ~100 lines tests + icon regeneration. Smallest adapter yet.
