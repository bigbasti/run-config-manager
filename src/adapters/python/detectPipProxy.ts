import * as path from 'path';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

export interface PipProxyInfo {
  proxyUrl: string | null;
  indexUrl: string | null;
  noProxy: string | null;
  source: 'pip' | 'env' | 'mixed' | 'none';
}

interface PipConfigBag {
  proxy: string | null;
  indexUrl: string | null;
  noProxy: string | null;
}

// Probes pip's effective configuration for the chosen interpreter, then
// merges with HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars. Pip values
// take precedence; env fills in any blanks.
export async function detectPipProxy(pythonHome: string | undefined): Promise<PipProxyInfo> {
  const fromPip = pythonHome
    ? parsePipConfigOutput(await runPipConfigList(pythonHome) ?? '')
    : { proxy: null, indexUrl: null, noProxy: null };
  return mergePipProxy(fromPip, {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  });
}

// Parses `pip config list` output. Each line is either `<scope>.<key>=<val>`
// (unquoted) or `<scope>.<key>='<val>'` (quoted). We only look at the keys
// that matter for proxy display.
export function parsePipConfigOutput(text: string): PipConfigBag {
  const bag: PipConfigBag = { proxy: null, indexUrl: null, noProxy: null };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^['"]|['"]$/g, '').trim();
    if (key.endsWith('proxy')) bag.proxy = val;
    else if (key.endsWith('index-url') || key.endsWith('index_url')) bag.indexUrl = val;
    else if (key.endsWith('no-proxy') || key.endsWith('no_proxy')) bag.noProxy = val;
  }
  return bag;
}

export function mergePipProxy(
  pip: PipConfigBag,
  env: { HTTP_PROXY?: string; HTTPS_PROXY?: string; NO_PROXY?: string },
): PipProxyInfo {
  const envProxy = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? null;
  const proxyUrl = pip.proxy ?? envProxy ?? null;
  const indexUrl = pip.indexUrl ?? null;
  const noProxy = pip.noProxy ?? env.NO_PROXY ?? null;

  const pipHasAny = !!(pip.proxy || pip.indexUrl || pip.noProxy);
  const envHasAny = !!envProxy || !!env.NO_PROXY;
  let source: PipProxyInfo['source'];
  if (pipHasAny && envHasAny) source = 'mixed';
  else if (pipHasAny) source = 'pip';
  else if (envHasAny) source = 'env';
  else source = 'none';

  return { proxyUrl, indexUrl, noProxy, source };
}

async function runPipConfigList(pythonHome: string): Promise<string | undefined> {
  const bin = process.platform === 'win32'
    ? path.join(pythonHome, 'python.exe')
    : path.join(pythonHome, 'bin', 'python3');
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(bin, ['-m', 'pip', 'config', 'list'], { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, 2000);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
  });
}
