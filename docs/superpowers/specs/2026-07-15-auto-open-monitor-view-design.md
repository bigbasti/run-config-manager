# Auto-Open Monitor View on Monitoring Attach — Design

**Date:** 2026-07-15
**Status:** Approved (design)
**Related:** JVM monitoring (2026-05-12), Node monitoring (2026-06-26), MCP profiling (2026-07-15)

## Problem

When a user starts a config "with monitoring" — via the `runConfig.runMonitored` /
`runConfig.debugMonitored` tree commands, or via the MCP `run_config` /
`debug_config` tool with `monitor: true` — the monitoring data is collected but the
monitor webview (`MonitorPanel`) is not shown. The user must additionally invoke
`runConfig.openMonitor` to see it. The monitor view should open automatically when
monitoring attaches.

## Decision

**Reactive, single hook.** `extension.ts` subscribes once to `monitoring.onChanged`
and once to `nodeMonitoring.onChanged`. The first time a config gains monitoring
state during a session, the panel is opened. Because monitoring only ever attaches
when `monitor: true` was requested, this fires for exactly the monitored-start cases
and covers **every** trigger path (UI commands, MCP, and any future entry point)
without per-call-site changes.

## Behaviour

On each `onChanged(id)` event (from either service):

- **Config gained state** (`monitoring.state(id)` or `nodeMonitoring.state(id)`
  is defined) **and not already auto-opened this session** → open the panel and mark
  the id as auto-opened.
- **State is gone** (detach/stop; `onChanged` fires from both services' `detach`
  after removing the entry) → clear the auto-opened mark so the next monitored run
  re-opens the panel.
- Otherwise → do nothing.

`MonitorPanel.open` is idempotent (one panel per config id; reveals the existing
instance). The auto-opened guard means that if the user closes the panel mid-run, a
subsequent metrics tick will **not** force it back open — the guard is only cleared
on detach.

Timing: the panel opens when the agent actually connects — effectively immediate for
Node and most JVM runs, and up to ~30–60 s later for Quarkus (whose forked dev JVM
starts late; see the existing `QUARKUS_MONITOR_ATTACH_DELAY_MS`). This is acceptable:
the panel appears exactly when there is data to show.

## Config lookup

`onChanged` provides only the config id. The `RunConfig` needed by
`MonitorPanel.open` is resolved via `svc.getById(id)`; if the ref is missing or
invalid, skip (no panel).

## Setting

Add `runConfigManager.monitoring.autoOpenView` (boolean, default `true`) to
`package.json` `contributes.configuration.properties`, alongside the existing
`runConfigManager.mcp.enabled`. Checked at event time; when `false`, the reactive
hook never opens a panel (but still clears the guard on detach).

## Components

- **`src/services/monitorAutoOpen.ts`** (new, pure, unit-tested):

  ```ts
  export type AutoOpenAction = 'open' | 'clear' | 'noop';

  export function decideAutoOpen(params: {
    enabled: boolean;
    live: boolean;         // monitoring state currently exists for the id
    alreadyOpened: boolean;
  }): AutoOpenAction;
  ```

  Logic:
  - `!live` → `'clear'` (always, regardless of `enabled`).
  - `live && !enabled` → `'noop'`.
  - `live && enabled && alreadyOpened` → `'noop'`.
  - `live && enabled && !alreadyOpened` → `'open'`.

- **`src/extension.ts`** (thin wiring, not unit-tested — activation code):
  owns a `Set<string>` of auto-opened ids and a handler wired to both services'
  `onChanged`. The handler computes `live`/`enabled`/`alreadyOpened`, calls
  `decideAutoOpen`, and acts: `'open'` → add to set + `MonitorPanel.open(...)`;
  `'clear'` → delete from set; `'noop'` → nothing. Both subscriptions are pushed to
  `context.subscriptions`.

## Testing

- **`test/monitorAutoOpen.test.ts`** — table-drive `decideAutoOpen` over all
  `enabled` × `live` × `alreadyOpened` combinations, asserting the expected action.

No test for `extension.ts` wiring (consistent with the repo convention that
`src/extension.ts` is excluded from coverage).

## Non-goals (YAGNI)

- No change to when/how monitoring itself attaches.
- No new `MonitorPanel` behaviour or rendering changes.
- No auto-open for non-monitored runs.
- No per-config override of the setting (single global toggle only).
