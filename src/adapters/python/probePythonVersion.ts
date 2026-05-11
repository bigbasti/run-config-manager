import * as path from 'path';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

export async function probePythonVersion(pythonHome: string): Promise<{ version?: string }> {
  try {
    const bin = pythonBinPath(pythonHome);
    const out = await runOnce(bin, ['--version'], 2000);
    if (!out) return {};
    const v = parsePythonVersion(out);
    return v ? { version: v } : {};
  } catch (e) {
    log.debug(`probePythonVersion(${pythonHome}) failed: ${(e as Error).message}`);
    return {};
  }
}

// Python --version output has been stable for years: `Python 3.12.1`.
// Pre-3.4 it wrote to stderr; 3.4+ writes to stdout. We capture both.
export function parsePythonVersion(text: string): string | undefined {
  const m = text.match(/Python\s+(\d+\.\d+\.\d+(?:[a-z]\d+)?)/);
  return m ? m[1] : undefined;
}

function pythonBinPath(home: string): string {
  if (process.platform === 'win32') return path.join(home, 'python.exe');
  return path.join(home, 'bin', 'python3');
}

function runOnce(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(command, args, { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, timeoutMs);
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
