import * as cp from 'child_process';
import * as os from 'os';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';

export interface PortEntry {
  port: number;
  address: string;
  pid: number;
  processName: string;
  protocol: 'tcp' | 'tcp6';
}

// Scan all listening TCP ports. Platform-dispatched:
//   Linux  → ss -tlnp (fallback: netstat -tlnp)
//   macOS  → lsof -iTCP -sTCP:LISTEN -nP
//   Windows → netstat -ano + tasklist for PID→name mapping
export async function scanPorts(): Promise<PortEntry[]> {
  const platform = os.platform();
  if (platform === 'win32') return scanWindows();
  if (platform === 'darwin') return scanMacOs();
  return scanLinux();
}

export async function killProcess(pid: number): Promise<void> {
  if (os.platform() === 'win32') {
    await run('taskkill', ['/F', '/PID', String(pid)]);
    return;
  }
  process.kill(pid, 'SIGTERM');
}

// =========================================================================
// Linux: ss -tlnp (preferred), netstat -tlnp (fallback)
// =========================================================================

async function scanLinux(): Promise<PortEntry[]> {
  try {
    return await parseFromSs();
  } catch (e) {
    log.debug(`ss failed (${(e as Error).message}), trying netstat`);
    try {
      return await parseFromLinuxNetstat();
    } catch (e2) {
      log.warn(`Linux port scan failed: ${(e2 as Error).message}`);
      return [];
    }
  }
}

async function parseFromSs(): Promise<PortEntry[]> {
  const raw = await run('ss', ['-tlnp']);
  const lines = raw.split('\n').filter(l => l.startsWith('LISTEN'));
  const out: PortEntry[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const localAddr = parts[3] ?? '';
    const processInfo = parts.slice(5).join(' ');
    const { address, port, protocol } = parseLocalAddr(localAddr);
    if (port === 0) continue;
    const { pid, name } = parseSsProcess(processInfo);
    out.push({ port, address, pid, processName: name, protocol });
  }
  return out;
}

async function parseFromLinuxNetstat(): Promise<PortEntry[]> {
  const raw = await run('netstat', ['-tlnp']);
  const lines = raw.split('\n').filter(l => /^tcp/.test(l));
  const out: PortEntry[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const localAddr = parts[3] ?? '';
    const pidProg = parts[6] ?? '';
    const { address, port, protocol } = parseLocalAddr(localAddr);
    if (port === 0) continue;
    const [pidStr, name] = pidProg.split('/');
    out.push({
      port, address,
      pid: parseInt(pidStr, 10) || 0,
      processName: name ?? '',
      protocol: parts[0]?.includes('6') ? 'tcp6' : 'tcp',
    });
  }
  return out;
}

// =========================================================================
// macOS: lsof -iTCP -sTCP:LISTEN -nP -F pcnT
// =========================================================================

async function scanMacOs(): Promise<PortEntry[]> {
  try {
    return await parseFromLsof();
  } catch (e) {
    log.warn(`macOS port scan failed: ${(e as Error).message}`);
    return [];
  }
}

async function parseFromLsof(): Promise<PortEntry[]> {
  // -F outputs machine-readable fields: p=PID, c=command, n=name, T=TCP info.
  // Each record starts with 'p' (process) then 'c' (command) then one or more
  // 'n' lines with the TCP endpoint. We only want LISTEN entries.
  const raw = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP']);
  const lines = raw.split('\n').filter(l => l.trim());
  const out: PortEntry[] = [];
  // Header line starts with "COMMAND" — skip it.
  for (const line of lines) {
    if (line.startsWith('COMMAND')) continue;
    // Columns: COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME
    // NAME is like: 127.0.0.1:8080 or *:3000 or [::1]:5432
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const processName = parts[0] ?? '';
    const pid = parseInt(parts[1], 10) || 0;
    const nodeType = parts[7] ?? '';
    const nameField = parts[8] ?? '';
    if (nodeType !== 'TCP' && nodeType !== 'IPv4' && nodeType !== 'IPv6') continue;
    // lsof NAME looks like: *:3000 or 127.0.0.1:8080 or [::1]:5432
    // Sometimes has a suffix like " (LISTEN)" which we strip.
    const cleaned = nameField.replace(/\s*\(LISTEN\)$/i, '');
    const { address, port, protocol } = parseLocalAddr(cleaned);
    if (port === 0) continue;
    out.push({ port, address, pid, processName, protocol });
  }
  return out;
}

// =========================================================================
// Windows: netstat -ano  +  tasklist (for PID → process name)
// =========================================================================

async function scanWindows(): Promise<PortEntry[]> {
  try {
    return await parseFromWindowsNetstat();
  } catch (e) {
    log.warn(`Windows port scan failed: ${(e as Error).message}`);
    return [];
  }
}

async function parseFromWindowsNetstat(): Promise<PortEntry[]> {
  const raw = await run('netstat', ['-ano']);
  const lines = raw.split('\n').filter(l => /LISTENING/i.test(l) && /TCP/i.test(l));
  const pids = new Set<number>();
  const entries: Array<{ port: number; address: string; pid: number; protocol: 'tcp' | 'tcp6' }> = [];
  for (const line of lines) {
    // Columns: Proto  Local Address  Foreign Address  State  PID
    const parts = line.trim().split(/\s+/);
    const proto = parts[0] ?? '';
    const localAddr = parts[1] ?? '';
    const pid = parseInt(parts[parts.length - 1], 10) || 0;
    const { address, port } = parseWindowsLocalAddr(localAddr);
    if (port === 0) continue;
    const protocol: 'tcp' | 'tcp6' = proto.toLowerCase().includes('v6') ? 'tcp6' : 'tcp';
    entries.push({ port, address, pid, protocol });
    if (pid > 0) pids.add(pid);
  }
  // Map PIDs → names via tasklist. Single call, cheaper than per-PID lookup.
  const nameMap = await buildPidNameMap(pids);
  return entries.map(e => ({
    ...e,
    processName: nameMap.get(e.pid) ?? '',
  }));
}

function parseWindowsLocalAddr(s: string): { address: string; port: number } {
  // Windows format: 0.0.0.0:8080 or [::]:8080 or [::1]:5432
  // IPv6 brackets are already present.
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return { address: s, port: 0 };
  return {
    address: s.slice(0, lastColon),
    port: parseInt(s.slice(lastColon + 1), 10) || 0,
  };
}

async function buildPidNameMap(pids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.size === 0) return map;
  try {
    const raw = await run('tasklist', ['/FO', 'CSV', '/NH']);
    for (const line of raw.split('\n')) {
      // "Image Name","PID","Session Name","Session#","Mem Usage"
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (!match) continue;
      const pid = parseInt(match[2], 10);
      if (pids.has(pid)) map.set(pid, match[1]);
    }
  } catch {
    // tasklist not available — names stay empty.
  }
  return map;
}

// =========================================================================
// Shared helpers
// =========================================================================

function parseLocalAddr(s: string): { address: string; port: number; protocol: 'tcp' | 'tcp6' } {
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return { address: s, port: 0, protocol: 'tcp' };
  const addr = s.slice(0, lastColon);
  const port = parseInt(s.slice(lastColon + 1), 10);
  const protocol = addr.includes('[') || addr === '::' || addr.startsWith('::') ? 'tcp6' : 'tcp';
  return { address: addr, port: isNaN(port) ? 0 : port, protocol };
}

function parseSsProcess(info: string): { pid: number; name: string } {
  const pidMatch = info.match(/pid=(\d+)/);
  const nameMatch = info.match(/\("([^"]+)"/);
  return {
    pid: pidMatch ? parseInt(pidMatch[1], 10) : 0,
    name: nameMatch ? nameMatch[1] : '',
  };
}

// --- port inference from configs -----------------------------------------

export function inferConfigPorts(cfg: RunConfig): number[] {
  const { explicit, defaultPorts } = inferConfigPortsDetailed(cfg);
  return [...new Set([...explicit, ...defaultPorts])];
}

// Separates ports the user actually declared (explicit `port` field,
// scanned programArgs / vmArgs / env, or type-specific fields like
// tomcat.httpPort / debugPort) from framework-default guesses (8080 for
// Spring Boot, 3000 for npm, …). The port viewer uses this split to decide
// whether to nudge the user into setting the `port` field — if NO config
// contributed an explicit port, the "Configuration Ports" group is
// populated by defaults only, which is unreliable, and we should say so.
export function inferConfigPortsDetailed(cfg: RunConfig): {
  explicit: number[];
  defaultPorts: number[];
} {
  const explicit: number[] = [];
  const defaultPorts: number[] = [];
  if (typeof cfg.port === 'number' && cfg.port > 0) explicit.push(cfg.port);

  if (cfg.type === 'npm') {
    const found = scanForPort(cfg.programArgs, '--port');
    if (found) explicit.push(found);
    if (explicit.length === 0) defaultPorts.push(3000);
  } else if (cfg.type === 'spring-boot') {
    const from = scanForPort(cfg.programArgs, '--server.port')
      ?? scanForPort(cfg.vmArgs, '-Dserver.port')
      ?? scanForSystemProp(cfg.env, 'server.port')
      ?? scanForSystemProp(cfg.env, 'SERVER_PORT');
    if (from) explicit.push(from);
    if (cfg.typeOptions.launchMode === 'gradle' || cfg.typeOptions.launchMode === 'maven') {
      const debugPort = cfg.typeOptions.debugPort;
      if (typeof debugPort === 'number' && debugPort > 0) explicit.push(debugPort);
    }
    if (explicit.length === 0) defaultPorts.push(8080);
  } else if (cfg.type === 'tomcat') {
    // Tomcat httpPort is always a user-configured field (it lives on the
    // form with a sensible default), so treat it as explicit.
    explicit.push(cfg.typeOptions.httpPort);
    if (cfg.typeOptions.debugPort) explicit.push(cfg.typeOptions.debugPort);
  } else if (cfg.type === 'quarkus') {
    const from = scanForPort(cfg.programArgs, '-Dquarkus.http.port')
      ?? scanForPort(cfg.vmArgs, '-Dquarkus.http.port');
    if (from) explicit.push(from);
    if (cfg.typeOptions.debugPort) explicit.push(cfg.typeOptions.debugPort);
    if (explicit.length === 0) defaultPorts.push(8080);
  } else if (cfg.type === 'java') {
    if (cfg.typeOptions.debugPort) explicit.push(cfg.typeOptions.debugPort);
    if (explicit.length === 0) defaultPorts.push(8080);
  }
  return {
    explicit: [...new Set(explicit)],
    defaultPorts: [...new Set(defaultPorts)],
  };
}

function scanForPort(text: string | undefined, prefix: string): number | null {
  if (!text) return null;
  const re = new RegExp(`${escapeRegex(prefix)}[= ](\\d+)`);
  const m = text.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function scanForSystemProp(env: Record<string, string> | undefined, key: string): number | null {
  if (!env) return null;
  const val = env[key];
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- child_process helper ------------------------------------------------

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { shell: os.platform() === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out`));
    }, 10_000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}
