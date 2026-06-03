import type * as vscode from 'vscode';

// Persisted snapshot of a single config the extension started. Survives a
// window / extension-host reload via workspaceState, so activate() can find
// the still-running process by port and re-attach to it. Matching is keyed
// primarily on `ports`; `pid` (the actual listener pid, captured once the
// port comes up) is an extra guard against an unrelated process having
// since claimed the same port.
export interface PersistedRunState {
  // Ports this config is expected to listen on (explicit + project-file
  // detected). Empty-port configs are never persisted — they can't be
  // matched deterministically on reload.
  ports: number[];
  // Listener pid observed on one of `ports` after the app came up. 0 when
  // we couldn't determine it (e.g. the readiness signal never fired, or a
  // ShellExecution runtime where we don't scan output). Port-only match is
  // used in that case.
  pid: number;
  // Informational — surfaced in logs/diagnostics only.
  name: string;
  type: string;
  startedAt: number;
}

const KEY = 'rcm.runState.v1';

export class RunStateStore {
  private state: Record<string, PersistedRunState>;

  constructor(private readonly workspaceState: vscode.Memento) {
    this.state = workspaceState.get<Record<string, PersistedRunState>>(KEY) ?? {};
  }

  all(): Record<string, PersistedRunState> {
    // Shallow copy so callers can't mutate the backing map without going
    // through set()/delete() (which persist).
    return { ...this.state };
  }

  get(id: string): PersistedRunState | undefined {
    return this.state[id];
  }

  set(id: string, value: PersistedRunState): void {
    this.state[id] = value;
    void this.workspaceState.update(KEY, this.state);
  }

  // Update just the listener pid for an existing entry. No-op if the entry
  // is gone or the pid is unchanged.
  setPid(id: string, pid: number): void {
    const cur = this.state[id];
    if (!cur || cur.pid === pid) return;
    cur.pid = pid;
    void this.workspaceState.update(KEY, this.state);
  }

  delete(id: string): void {
    if (!(id in this.state)) return;
    delete this.state[id];
    void this.workspaceState.update(KEY, this.state);
  }
}
