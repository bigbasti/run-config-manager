# Feature-Dev OpenCode Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the `feature-dev` plugin adapted for OpenCode as a global command available in all OpenCode sessions via `/feature-dev`.

**Architecture:** A single markdown command file placed in `~/.config/opencode/commands/feature-dev.md`. The 7-phase workflow from the original Claude Code plugin is adapted to use OpenCode's built-in `@explore` subagent (read-only codebase exploration) and `@general` subagent (architecture design and code review), replacing the three custom agents from the original. No custom agent files are needed.

**Tech Stack:** OpenCode command markdown format (YAML frontmatter + markdown body); OpenCode built-in subagents `@explore` and `@general`; `$ARGUMENTS` placeholder for user-supplied feature description.

---

### Task 1: Create the global commands directory and the feature-dev command file

**Files:**
- Create: `~/.config/opencode/commands/feature-dev.md`

- [ ] **Step 1: Create the commands directory**

Run:
```bash
mkdir -p ~/.config/opencode/commands
```

Expected: Directory created silently (no output), or already exists.

- [ ] **Step 2: Create the command file**

Create `~/.config/opencode/commands/feature-dev.md` with the following exact content:

```markdown
---
description: Guided 7-phase feature development with codebase exploration, architecture design, and quality review
---

# Feature Development

You are helping a developer implement a new feature. Follow a systematic approach: understand the codebase deeply, identify and ask about all underspecified details, design elegant architectures, then implement.

## Core Principles

- **Ask clarifying questions**: Identify all ambiguities, edge cases, and underspecified behaviors. Ask specific, concrete questions rather than making assumptions. Wait for user answers before proceeding with implementation. Ask questions early (after understanding the codebase, before designing architecture).
- **Understand before acting**: Read and comprehend existing code patterns first
- **Read files identified by subagents**: When invoking subagents, ask them to return lists of the most important files to read. After subagents complete, read those files to build detailed context before proceeding.
- **Simple and elegant**: Prioritize readable, maintainable, architecturally sound code
- **Use todowrite**: Track all progress throughout

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built

Initial request: $ARGUMENTS

**Actions**:
1. Create a todo list with all 7 phases using the `todowrite` tool
2. If the feature description is unclear or missing, ask the user:
   - What problem are they solving?
   - What should the feature do?
   - Any constraints or requirements?
3. Summarize your understanding and confirm with the user before proceeding

---

## Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns at both high and low levels

**Actions**:
1. Invoke 2-3 `@explore` subagents in parallel. Each subagent should:
   - Trace through the code comprehensively, focusing on abstractions, architecture, and flow of control
   - Target a different aspect of the codebase (e.g., similar features, high-level architecture, UI patterns, testing approaches)
   - Return a list of 5-10 key files that are essential for understanding the topic

   **Example subagent prompts**:
   - "Find features similar to [feature] and trace through their implementation comprehensively. Return a list of 5-10 key files to read."
   - "Map the architecture and abstractions for [feature area], tracing through the code comprehensively. Return a list of 5-10 key files to read."
   - "Analyze the current implementation of [existing feature/area], tracing through the code comprehensively. Return a list of 5-10 key files to read."

2. After the subagents return, read all files they identified to build deep understanding
3. Present a comprehensive summary of findings and patterns discovered

---

## Phase 3: Clarifying Questions

**Goal**: Fill in gaps and resolve all ambiguities before designing

**CRITICAL**: This is one of the most important phases. DO NOT SKIP.

**Actions**:
1. Review the codebase findings from Phase 2 and the original feature request
2. Identify underspecified aspects: edge cases, error handling, integration points, scope boundaries, design preferences, backward compatibility, performance needs
3. **Present all questions to the user in a clear, organized numbered list**
4. **Wait for answers before proceeding to Phase 4**

If the user says "whatever you think is best", provide your recommendation explicitly and get their confirmation.

---

## Phase 4: Architecture Design

**Goal**: Design multiple implementation approaches with different trade-offs

**Actions**:
1. Invoke 2-3 `@general` subagents in parallel, each tasked with designing a different approach:
   - **Minimal changes**: Smallest possible change, maximum reuse of existing code
   - **Clean architecture**: Prioritize maintainability and elegant abstractions
   - **Pragmatic balance**: Balance speed and quality

   Each subagent prompt should include the codebase findings from Phase 2 and the clarified requirements from Phase 3.

2. Review all approaches and form your own opinion on which fits best for this specific task (consider: scope of change, urgency, complexity, team context)
3. Present to the user:
   - Brief summary of each approach with trade-offs
   - **Your recommendation with reasoning**
   - Concrete differences in implementation
4. **Ask the user which approach they prefer before proceeding**

---

## Phase 5: Implementation

**Goal**: Build the feature

**DO NOT START WITHOUT EXPLICIT USER APPROVAL**

**Actions**:
1. Wait for the user to explicitly approve starting implementation
2. Read all relevant files identified in Phases 2 and 4
3. Implement following the chosen architecture from Phase 4
4. Follow codebase conventions strictly — match existing patterns exactly
5. Write clean, well-documented code
6. Update the `todowrite` todo list as you make progress through implementation

---

## Phase 6: Quality Review

**Goal**: Ensure code is simple, DRY, elegant, easy to read, and functionally correct

**Actions**:
1. Invoke 3 `@general` subagents in parallel, each with a different review focus:
   - **Simplicity/DRY/Elegance**: Is the code readable? Are there unnecessary duplications? Can anything be simplified?
   - **Bugs/Functional correctness**: Logic errors, null/undefined handling, race conditions, edge cases not handled
   - **Project conventions/Abstractions**: Does the code follow project patterns? Are abstractions consistent with the codebase?

   Each subagent should be instructed to review (not modify) the code and return findings with file:line references.

2. Consolidate findings and identify the highest-severity issues you recommend fixing
3. **Present findings to the user and ask what they want to do**:
   - Fix now (specify which issues)
   - Fix later (note them for follow-up)
   - Proceed as-is
4. Address issues based on the user's decision

---

## Phase 7: Summary

**Goal**: Document what was accomplished

**Actions**:
1. Mark all todo items complete using `todowrite`
2. Present a summary covering:
   - What was built
   - Key decisions made during the process
   - Files created or modified (with paths)
   - Suggested next steps or follow-up items

---
```

- [ ] **Step 3: Verify the file was created correctly**

Run:
```bash
cat ~/.config/opencode/commands/feature-dev.md | head -5
```

Expected output:
```
---
description: Guided 7-phase feature development with codebase exploration, architecture design, and quality review
---

# Feature Development
```

- [ ] **Step 4: Verify the file is valid YAML frontmatter + markdown**

Run:
```bash
grep -c "^## Phase" ~/.config/opencode/commands/feature-dev.md
```

Expected output: `7` (one line per phase heading)

- [ ] **Step 5: Open a new OpenCode session and verify the command is available**

In a terminal, start opencode:
```bash
opencode
```

Type `/feat` in the TUI and verify `/feature-dev` appears in the autocomplete list with the description "Guided 7-phase feature development with codebase exploration, architecture design, and quality review".

Exit opencode (`/exit` or `Ctrl+C`).

---

## Self-Review Checklist (run before claiming done)

- [ ] Spec coverage: All 7 phases present in the command file
- [ ] Spec coverage: `@explore` used for Phase 2 (codebase exploration — read-only)
- [ ] Spec coverage: `@general` used for Phase 4 (architecture — needs file access)
- [ ] Spec coverage: `@general` used for Phase 6 (review — instructed as read-only via prompt)
- [ ] Spec coverage: User confirmation gates at Phases 3, 4, 5, and 6
- [ ] Spec coverage: `todowrite` referenced for progress tracking
- [ ] Spec coverage: `$ARGUMENTS` present for feature description passthrough
- [ ] No TODOs or placeholders in the command file
- [ ] File installs to `~/.config/opencode/commands/` (global, not project-local)
