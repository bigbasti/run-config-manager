# Feature-Dev Plugin: OpenCode-Native Adaptation Design

**Date**: 2026-05-22  
**Source**: https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev  
**Target**: OpenCode global config (`~/.config/opencode/`)

---

## Goal

Port the Claude Code `feature-dev` plugin into OpenCode's native format so the `/feature-dev` command is available globally in all OpenCode sessions. The port uses **Approach 2: OpenCode-native redesign** — the three custom Claude Code agents (`code-explorer`, `code-architect`, `code-reviewer`) are replaced with OpenCode's built-in subagents (`@explore`, `@general`), eliminating the need for any custom agent files.

---

## What the Original Plugin Provides

A 7-phase guided feature development workflow triggered by `/feature-dev [optional description]`:

1. **Discovery** — Understand what needs to be built
2. **Codebase Exploration** — Parallel subagent analysis of the codebase
3. **Clarifying Questions** — Resolve all ambiguities before designing
4. **Architecture Design** — Parallel subagent architecture proposals
5. **Implementation** — Build only after explicit user approval
6. **Quality Review** — Parallel subagent code review
7. **Summary** — Document what was accomplished

---

## Adaptation Decisions

### Agent Mapping

| Claude Code agent | Role | OpenCode built-in |
|---|---|---|
| `code-explorer` | Read-only codebase tracing | `@explore` |
| `code-architect` | Architecture design (can write) | `@general` |
| `code-reviewer` | Code review (read-only framing) | `@general` |

**Rationale**: OpenCode's `@explore` is purpose-built for read-only codebase exploration (no file edits). `@general` has full tool access and handles multi-step tasks. The specialized system prompts from the original agents are inlined into the command's phase instructions so the primary agent passes appropriate context when invoking subagents.

### Tool Naming

- `TodoWrite` → `todowrite` (OpenCode uses lowercase tool names)
- `BashOutput`, `KillShell` → not needed (OpenCode's `bash` tool handles this)
- Agent invocation: `Launch [agent-name] agent` → `Invoke @explore / @general`

### Frontmatter

Claude Code command frontmatter:
```yaml
---
description: Guided feature development...
argument-hint: Optional feature description
---
```

OpenCode command frontmatter:
```yaml
---
description: Guided feature development...
---
```

`argument-hint` has no OpenCode equivalent; `$ARGUMENTS` substitution works identically.

### No Custom Agent Files Required

The original plugin requires three agent markdown files. This design requires **zero** custom agent files — only the single command file. Built-in subagents already have appropriate permission sets:
- `@explore`: read-only, cannot edit files
- `@general`: full access, ideal for architecture and review tasks

---

## Files to Create

### `~/.config/opencode/commands/feature-dev.md`

One file. Global install. Available as `/feature-dev` in every OpenCode session immediately after creation.

**Frontmatter:**
```yaml
---
description: Guided 7-phase feature development with codebase exploration, architecture design, and quality review
---
```

**Body:** The 7-phase workflow adapted for OpenCode, referencing `@explore` and `@general` at the appropriate phases. The `$ARGUMENTS` placeholder carries the user's feature description through.

---

## Phase-by-Phase Adaptation Notes

### Phase 2: Codebase Exploration
- Original: "Launch 2-3 `code-explorer` agents in parallel"
- Adapted: "Invoke 2-3 `@explore` subagents in parallel"
- `@explore` is read-only and codebase-focused — direct match

### Phase 4: Architecture Design  
- Original: "Launch 2-3 `code-architect` agents in parallel"
- Adapted: "Invoke 2-3 `@general` subagents in parallel"
- Each invocation gets a focused prompt (minimal/clean/pragmatic approach)
- `@general` has full access to read files and return structured blueprints

### Phase 6: Quality Review
- Original: "Launch 3 `code-reviewer` agents in parallel"
- Adapted: "Invoke 3 `@general` subagents in parallel with read-only framing"
- The prompt for each instructs the subagent to review (not modify) code
- `@general` can be instructed to operate in read-only mode via prompt framing

---

## What Stays the Same

- All seven phases and their gate conditions
- User-confirmation gates (Phase 3 questions, Phase 4 approval, Phase 5 start, Phase 6 decision)
- `todowrite` usage for progress tracking
- `$ARGUMENTS` for feature description passthrough
- The analytical depth of each phase

---

## Out of Scope

- No `.opencode/` project-level installation (global only per user decision)
- No custom agent files
- No JavaScript/TypeScript plugin hooks (the original plugin uses none; it's purely markdown)
- No port of the `.claude-plugin/plugin.json` metadata (OpenCode has no equivalent for npm-distributed plugins in this format)

---

## Success Criteria

- `/feature-dev` is available in any OpenCode session globally
- All 7 phases execute correctly using built-in subagents
- User confirmation gates function at Phases 3, 4, 5, and 6
- `todowrite` tracks progress throughout the workflow
