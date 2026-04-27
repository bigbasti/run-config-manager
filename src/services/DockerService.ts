import * as vscode from 'vscode';
import * as cp from 'child_process';
import { log } from '../utils/logger';

// Summary of one container from `docker ps -a --format '{{json .}}'`.
// We normalise the handful of fields the tree and form actually display;
// anything else surfaces via inspect() on demand.
export interface ContainerSummary {
  id: string;       // "Container ID" — full id where possible
  name: string;     // "Names" — first name if multiple
  image: string;    // "Image"
  state: string;    // "State" — running, exited, paused, restarting, created
  status: string;   // "Status" — human-readable ("Up 3 hours", "Exited (0) 1 minute ago")
  ports: string;    // "Ports" — raw text like "0.0.0.0:5432->5432/tcp"
}

// Subset of `docker inspect` output we surface in the form. Docker CLI
// returns a lot more — we cherry-pick for UI relevance and to avoid
// rebuilding whole json trees on every keystroke.
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  created: string;                             // ISO
  ports: Array<{ host: string; container: string; protocol: string }>;
  volumes: Array<{ source: string; destination: string; mode: string }>;
  env: string[];
  // Full inspect JSON for power users / debugging. Kept as a raw object so
  // the webview can pretty-print it in an advanced panel.
  raw: unknown;
}

// How often we re-query `docker ps -a` to catch externally-started/stopped
// containers. Every 3s is enough for UI responsiveness without swamping the
// daemon when the sidebar is idle.
const POLL_INTERVAL_MS = 3000;

export class DockerService {
  private cache: ContainerSummary[] = [];
  private dockerAvailable: boolean | undefined;
  private timer: NodeJS.Timeout | undefined;
  private emitter = new vscode.EventEmitter<void>();
  readonly onChanged = this.emitter.event;
  private lastListError: string | undefined;
  // Active logs terminals keyed by container id, so a second click on the
  // same config focuses the existing one instead of spawning another.
  private logsTerminals = new Map<string, vscode.Terminal>();
  private terminalCloseSub: vscode.Disposable;

  constructor() {
    this.terminalCloseSub = vscode.window.onDidCloseTerminal(t => {
      for (const [id, term] of this.logsTerminals.entries()) {
        if (term === t) this.logsTerminals.delete(id);
      }
    });
  }

  start(): void {
    if (this.timer) return;
    this.poll().catch(e => log.warn(`Initial docker poll failed: ${(e as Error).message}`));
    this.timer = setInterval(() => {
      this.poll().catch(e => log.debug(`Docker poll failed: ${(e as Error).message}`));
    }, POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.terminalCloseSub.dispose();
    for (const t of this.logsTerminals.values()) t.dispose();
    this.logsTerminals.clear();
    this.emitter.dispose();
  }

  // Synchronous peek into the last-known container list. Trees are rendered
  // sync so we can't await; readers see whatever the last poll produced.
  list(): ContainerSummary[] {
    return this.cache;
  }

  // True only after the first successful `docker ps` call, i.e. "docker is
  // actually reachable on this system". Used by the form to tailor its help
  // text when docker is missing.
  isAvailable(): boolean | undefined {
    return this.dockerAvailable;
  }

  listError(): string | undefined {
    return this.lastListError;
  }

  isRunning(containerId: string): boolean {
    const match = this.find(containerId);
    return match?.state === 'running';
  }

  find(containerId: string): ContainerSummary | undefined {
    if (!containerId) return undefined;
    // Users may save a short id (12 chars); Docker reports both — match on
    // prefix in either direction so either representation works.
    return this.cache.find(
      c => c.id === containerId || c.id.startsWith(containerId) || containerId.startsWith(c.id),
    );
  }

  // Force a fresh `docker ps -a` and wait for it. Used by the form's
  // selectOrCustom dropdown so the user sees up-to-date options even before
  // the next polling tick.
  async refresh(): Promise<void> {
    await this.poll();
  }

  // One-shot `docker inspect <id>` for the info panel. Errors surface to the
  // caller — the form renders a friendly message.
  async inspect(containerId: string): Promise<ContainerInfo | null> {
    if (!containerId) return null;
    const { stdout, code } = await runDocker(['inspect', containerId]);
    if (code !== 0) {
      log.warn(`docker inspect ${containerId} failed (code ${code})`);
      return null;
    }
    try {
      const arr = JSON.parse(stdout) as any[];
      const first = arr[0];
      if (!first) return null;
      return {
        id: first.Id,
        name: (first.Name ?? '').replace(/^\//, ''),
        image: first.Config?.Image ?? '',
        state: first.State?.Status ?? 'unknown',
        created: first.Created ?? '',
        ports: extractPorts(first.NetworkSettings?.Ports),
        volumes: extractMounts(first.Mounts),
        env: Array.isArray(first.Config?.Env) ? first.Config.Env : [],
        raw: first,
      };
    } catch (e) {
      log.warn(`docker inspect parse failed: ${(e as Error).message}`);
      return null;
    }
  }

  async startContainer(containerId: string): Promise<void> {
    const { code, stderr } = await runDocker(['start', containerId]);
    if (code !== 0) throw new Error(stderr.trim() || `docker start exited ${code}`);
    // Fire a poll so the tree flips to "running" without waiting 3s.
    await this.poll();
  }

  async stopContainer(containerId: string): Promise<void> {
    const { code, stderr } = await runDocker(['stop', containerId]);
    if (code !== 0) throw new Error(stderr.trim() || `docker stop exited ${code}`);
    await this.poll();
  }

  // Opens (or focuses) a terminal tailing the container's logs. Uses VS
  // Code's Terminal API — the user gets stop/copy/clear/search for free, and
  // ctrl+C detaches (container keeps running). Cheaper than rolling our own
  // pseudoterminal since the logs are just stdout text.
  showLogs(containerId: string, label?: string): void {
    const existing = this.logsTerminals.get(containerId);
    if (existing) { existing.show(true); return; }
    const terminalName = `docker logs: ${label ?? containerId.slice(0, 12)}`;
    const term = vscode.window.createTerminal({
      name: terminalName,
      shellPath: 'docker',
      shellArgs: ['logs', '-f', '--tail', '200', containerId],
    });
    this.logsTerminals.set(containerId, term);
    term.show(true);
  }

  // ----- internals -------------------------------------------------------

  private async poll(): Promise<void> {
    const { stdout, code, stderr } = await runDocker([
      'ps',
      '-a',
      '--no-trunc',
      '--format',
      '{{json .}}',
    ]);
    if (code !== 0) {
      const msg = stderr.trim() || `docker ps exited ${code}`;
      if (this.dockerAvailable === undefined) {
        log.info(`Docker not available: ${msg}`);
      }
      this.dockerAvailable = false;
      this.lastListError = msg;
      if (this.cache.length) {
        this.cache = [];
        this.emitter.fire();
      }
      return;
    }
    this.dockerAvailable = true;
    this.lastListError = undefined;

    const next: ContainerSummary[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as Record<string, string>;
        next.push({
          id: row.ID ?? '',
          // `Names` can be a comma-separated list when a container has aliases.
          name: (row.Names ?? '').split(',')[0] ?? '',
          image: row.Image ?? '',
          state: (row.State ?? '').toLowerCase(),
          status: row.Status ?? '',
          ports: row.Ports ?? '',
        });
      } catch {
        // `docker ps --format '{{json .}}'` occasionally emits malformed
        // lines when containers are removed mid-listing. Skip and move on.
      }
    }

    if (summariesChanged(this.cache, next)) {
      this.cache = next;
      this.emitter.fire();
    }
  }
}

function summariesChanged(a: ContainerSummary[], b: ContainerSummary[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].state !== b[i].state || a[i].status !== b[i].status) {
      return true;
    }
  }
  return false;
}

function extractPorts(
  ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined,
): ContainerInfo['ports'] {
  if (!ports) return [];
  const out: ContainerInfo['ports'] = [];
  for (const [containerSpec, bindings] of Object.entries(ports)) {
    // containerSpec is like "5432/tcp".
    const [containerPort, protocol = 'tcp'] = containerSpec.split('/');
    if (!bindings || bindings.length === 0) {
      out.push({ host: '', container: containerPort, protocol });
      continue;
    }
    for (const b of bindings) {
      out.push({
        host: `${b.HostIp || '0.0.0.0'}:${b.HostPort}`,
        container: containerPort,
        protocol,
      });
    }
  }
  return out;
}

function extractMounts(mounts: any[] | undefined): ContainerInfo['volumes'] {
  if (!Array.isArray(mounts)) return [];
  return mounts.map(m => ({
    source: m.Source ?? m.Name ?? '',
    destination: m.Destination ?? '',
    mode: m.Mode ?? (m.RW ? 'rw' : 'ro'),
  }));
}

// Runs `docker <args>` without a shell, captures stdout+stderr, never throws.
// A 15-second timeout guards against a hung daemon — long enough for a slow
// inspect, short enough that the UI doesn't freeze.
async function runDocker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise(resolve => {
    try {
      const child = cp.spawn('docker', args, { shell: false });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
      }, 15_000);
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', e => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message });
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: (e as Error).message });
    }
  });
}
