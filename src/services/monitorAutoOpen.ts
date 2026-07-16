// Pure decision for the reactive "auto-open monitor view" behavior. Kept free
// of vscode imports so it is unit-testable; extension.ts owns the side effects
// (the opened-ids Set and the MonitorPanel.open call).
export type AutoOpenAction = 'open' | 'clear' | 'noop';

// `live`         — monitoring state currently exists for the config id.
// `enabled`      — the runConfigManager.monitoring.autoOpenView setting.
// `alreadyOpened`— this id was already auto-opened this session (guard so
//                  closing the panel mid-run doesn't force it back open).
export function decideAutoOpen(params: {
  enabled: boolean;
  live: boolean;
  alreadyOpened: boolean;
}): AutoOpenAction {
  // When monitoring is gone (detach/stop), always clear the guard so the next
  // monitored run re-opens the panel — independent of the setting.
  if (!params.live) return 'clear';
  if (!params.enabled) return 'noop';
  if (params.alreadyOpened) return 'noop';
  return 'open';
}
