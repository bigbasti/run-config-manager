# Add Config Wizard Reorder — Design

**Date:** 2026-05-28
**Status:** Approved
**Scope:** `addConfig` wizard UX in `extension.ts`, `RuntimeAdapter` interface, 5 adapter files

---

## Problem

The current "Add Run Configuration" wizard asks:

1. (multi-root only) Which workspace folder?
2. Which project folder? — OS native folder-picker dialog
3. Which config type? — QuickPick popup

This order is wrong: the folder picker is shown unconditionally before the user has chosen
a type, even though several types (`http-request`, `docker`, `custom-command`,
`maven-goal`, `gradle-task`) do not need a project folder selection at all.

---

## Goals

- Type selection is always the first choice the user makes.
- The OS folder picker is shown only for types that need it.
- Types that don't need a folder picker use the workspace root as `projectPath`
  (empty string = workspace root) and let the user adjust it in the form.
- No changes to adapter detection logic, EditorPanel, form fields, or the webview.

---

## Non-Goals

- Changing how any adapter detects or builds its configuration.
- Back-navigation between wizard steps.

---

## Design

### 1. RuntimeAdapter Interface

Add `readonly needsFolderPick?: boolean` to `src/adapters/RuntimeAdapter.ts`.
Default is `true` (undefined treated as true; opt-out model).

### 2. Adapter Declarations

Five adapters add `readonly needsFolderPick = false`:
- `custom-command`, `docker`, `http-request`, `maven-goal`, `gradle-task`

### 3. addConfig Wizard Reorder

New order:
1. Type QuickPick (always first)
2. Workspace folder pick (only if >1 workspace root)
3. OS folder picker — only if `adapter.needsFolderPick !== false`
   - Skipped types: `projectUri = folder.uri`, `relProject = ''`

### 4. Testing

- `npm run typecheck && npm test && npm run build` must pass.
- Verify 5 adapters expose `needsFolderPick === false` in their respective test files.
