import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import { CancelledError } from './archiveInstall';

export interface NvmProgress {
  state: 'installing';
  // The most-recent line of nvm output. The dialog renders this directly
  // under "Installing via nvm".
  detail: string;
}

export interface NvmInstallResult {
  // Absolute path to the install dir (contains bin/node).
  // Same shape detection produces, so the form's dropdown picks it
  // up via the existing nvm version-manager scan.
  nodeHome: string;
  // The version label exactly as nvm reports it, with the leading 'v'.
  // Matches what the user picked in the dropdown.
  version: string;
}

// Drives `nvm install <version>` through a bash subshell that sources
// nvm.sh first. nvm is a shell function, not a binary — we can't call
// it directly via child_process.spawn. Streaming stdout/stderr line-by-
// line lets the dialog show what nvm is doing in real time (downloading,
// computing checksums, building, etc.).
//
// POSIX only — Windows nvm-windows is a different tool. Constructor
// inputs come from detectNvm().
export class NvmInstallerService {
  private child: cp.ChildProcess | undefined;
  private cancelled = false;
  // Last few lines of output, kept for failure-message construction.
  private readonly tail: string[] = [];
  private static readonly TAIL_LIMIT = 8;

  constructor(
    private readonly nvmDir: string,
    private readonly nvmShPath: string,
  ) {}

  async install(version: string, onProgress: (p: NvmProgress) => void): Promise<NvmInstallResult> {
    const normalized = parseNvmVersion(version);
    // Constructed-here string — no user-controlled shell injection
    // because `version` is constrained by the dropdown to nodejs.org's
    // semver shape and we strip the 'v' before splicing.
    const script = `. "${this.nvmShPath}" && nvm install ${normalized}`;
    log.info(`NvmInstallerService.install: bash -c '${script}'`);

    return new Promise<NvmInstallResult>((resolve, reject) => {
      this.cancelled = false;
      this.tail.length = 0;

      const child = cp.spawn('bash', ['-c', script], { windowsHide: true });
      this.child = child;

      let stdoutBuf = '';
      let stderrBuf = '';

      const flushLines = (chunk: string, side: 'out' | 'err'): void => {
        const buf = side === 'out' ? stdoutBuf + chunk : stderrBuf + chunk;
        const lines = buf.split('\n');
        // Last fragment is the (possibly partial) trailing line.
        const trailing = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.replace(/\r$/, '');
          if (!trimmed) continue;
          this.tail.push(trimmed);
          if (this.tail.length > NvmInstallerService.TAIL_LIMIT) this.tail.shift();
          try { onProgress({ state: 'installing', detail: trimmed }); }
          catch { /* swallow — progress is best-effort */ }
        }
        if (side === 'out') stdoutBuf = trailing;
        else stderrBuf = trailing;
      };

      child.stdout?.on('data', (b: Buffer) => flushLines(b.toString('utf8'), 'out'));
      child.stderr?.on('data', (b: Buffer) => flushLines(b.toString('utf8'), 'err'));

      child.on('error', (e) => {
        this.child = undefined;
        reject(e);
      });

      child.on('close', (code) => {
        this.child = undefined;
        if (this.cancelled) {
          reject(new CancelledError());
          return;
        }
        if (code !== 0) {
          const tail = this.tail.join('\n');
          reject(new Error(`nvm install failed (exit ${code}): ${tail}`));
          return;
        }
        // Compute the install path — nvm's standard layout.
        const nodeHome = path.join(this.nvmDir, 'versions', 'node', `v${normalized}`);
        const nodeBin = path.join(nodeHome, 'bin', 'node');
        fs.promises.stat(nodeBin).then(() => {
          resolve({ nodeHome, version: `v${normalized}` });
        }).catch(() => {
          reject(new Error(
            `nvm reported success but no node binary at ${nodeBin}. ` +
            `Last output:\n${this.tail.join('\n')}`,
          ));
        });
      });
    });
  }

  cancel(): void {
    if (!this.child) return;
    this.cancelled = true;
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    // 3-second grace period, then SIGKILL. Matches RunTerminal.kill semantics.
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3000).unref?.();
  }
}

// Strips a leading 'v' and trims whitespace. Exported for unit tests.
// Input examples: 'v20.10.0' → '20.10.0'; '18.19.1' → '18.19.1'.
export function parseNvmVersion(input: string): string {
  return input.trim().replace(/^v/, '');
}
