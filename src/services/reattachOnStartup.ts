import type { PortEntry } from './PortScanner';
import type { RunStateStore } from './RunStateStore';
import { log } from '../utils/logger';

export interface ReattachDeps {
  runState: RunStateStore;
  // Marks the config as running against an already-live external process.
  reattach(configId: string, pid: number, ports: number[]): void;
  // True when the config id still exists as a valid config in the workspace.
  configExists(configId: string): boolean;
  // Snapshot of currently-listening ports.
  scan: () => Promise<PortEntry[]>;
}

// Re-attaches configs the extension started before a window / extension-host
// reload. For each persisted entry we look for one of its recorded ports
// among the currently-listening sockets:
//   - config deleted in the meantime  → drop the stale entry.
//   - no recorded port is listening    → the process is gone; drop the entry.
//   - a recorded port IS listening     → reattach, adopting the live pid.
//
// When a listener pid was recorded at run time, we require it to match the
// live pid so an unrelated process that has since claimed the same port
// doesn't get falsely adopted. If no pid was recorded (0), we fall back to a
// port-only match.
//
// Returns the number of configs reattached. Never throws — a failed port
// scan just means nothing is reattached this session.
export async function reattachOnStartup(deps: ReattachDeps): Promise<number> {
  const persisted = deps.runState.all();
  const ids = Object.keys(persisted);
  if (ids.length === 0) return 0;

  let rows: PortEntry[];
  try {
    rows = await deps.scan();
  } catch (e) {
    log.warn(`reattach: port scan failed — ${(e as Error).message}; skipping reattach`);
    return 0;
  }

  const byPort = new Map<number, PortEntry>();
  for (const r of rows) {
    if (r.port > 0 && !byPort.has(r.port)) byPort.set(r.port, r);
  }

  let count = 0;
  for (const id of ids) {
    const st = persisted[id];
    if (!deps.configExists(id)) {
      log.debug(`reattach: config "${id}" no longer exists — dropping persisted run state`);
      deps.runState.delete(id);
      continue;
    }
    const match = st.ports
      .map(p => byPort.get(p))
      .find((e): e is PortEntry => e !== undefined);
    if (!match) {
      log.debug(`reattach: no listening port for "${st.name || id}" (ports=[${st.ports.join(', ')}]) — dropping`);
      deps.runState.delete(id);
      continue;
    }
    if (st.pid > 0 && match.pid > 0 && match.pid !== st.pid) {
      log.debug(
        `reattach: port ${match.port} for "${st.name || id}" now owned by PID ${match.pid} ` +
        `(expected ${st.pid}) — different process, dropping`,
      );
      deps.runState.delete(id);
      continue;
    }
    deps.reattach(id, match.pid, st.ports);
    log.info(`reattach: "${st.name || id}" → port ${match.port}, PID ${match.pid}`);
    count++;
  }
  return count;
}
