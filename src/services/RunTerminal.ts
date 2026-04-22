import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

// Pseudoterminal implementation that owns a child process and forwards its
// stdout/stderr into the integrated terminal while simultaneously handing
// each chunk to a scanner callback (used to detect readiness patterns).
//
// Replaces vscode.ShellExecution for configs that want to observe output —
// ShellExecution gives the PTY to VS Code and our code sees nothing.
export interface RunTerminalOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  // Invoked once for every chunk of stdout+stderr. Exceptions bubble up as
  // unhandled rejections but don't affect the process; keep it cheap.
  onOutput?: (chunk: string) => void;
  // Invoked once when the child exits, before the terminal closes.
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class RunTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private child: cp.ChildProcess | undefined;
  private closed = false;

  constructor(private readonly opts: RunTerminalOpts) {}

  // VS Code calls this when the task (and thus the terminal) opens.
  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.spawnChild();
  }

  close(): void {
    this.kill();
  }

  // User-typed input — we don't forward to the child (it's a non-interactive
  // long-running process), but we accept Ctrl+C / Ctrl+D to stop.
  handleInput(data: string): void {
    if (data === '\x03' /* Ctrl+C */ || data === '\x04' /* Ctrl+D */) {
      this.writeEmitter.fire('^C\r\n');
      this.kill();
    }
  }

  private spawnChild(): void {
    const { command, args, cwd, env } = this.opts;
    // Shell out the same way vscode.ShellExecution does — that way commands
    // like "./gradlew :api:war" resolve correctly via PATH and shell metachars
    // (&&, |, etc.) in args still work if the adapter happens to emit them.
    const isWin = os.platform() === 'win32';
    const shell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/bash';
    const shellArgs = isWin ? ['/c'] : ['-c'];
    const cmdLine = [command, ...args].join(' ');

    this.writeLine(`> ${cmdLine}`);
    this.writeLine(`  (cwd: ${cwd})`);
    this.writeLine('');

    try {
      this.child = cp.spawn(shell, [...shellArgs, cmdLine], {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.writeLine(`Failed to spawn: ${(e as Error).message}`);
      this.closeEmitter.fire(1);
      this.closed = true;
      return;
    }

    const onChunk = (buf: Buffer) => {
      const text = buf.toString();
      // Normalize bare LF to CRLF for the VT100 terminal.
      this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
      try { this.opts.onOutput?.(text); } catch { /* keep output flowing */ }
    };

    this.child.stdout?.on('data', onChunk);
    this.child.stderr?.on('data', onChunk);

    this.child.on('error', e => {
      this.writeLine(`\r\nChild process error: ${e.message}`);
      this.finish(1, null);
    });

    this.child.on('exit', (code, signal) => {
      this.writeLine(`\r\nProcess exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`);
      this.finish(code, signal);
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    try { this.opts.onExit?.(code, signal); } catch { /* ignore */ }
    this.closeEmitter.fire(code ?? 0);
  }

  private kill(): void {
    if (!this.child || this.closed) return;
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    // Force-kill after 3s if the child ignores SIGTERM (Java apps sometimes do).
    setTimeout(() => {
      if (!this.closed && this.child && this.child.exitCode === null) {
        try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3000);
  }

  private writeLine(line: string): void {
    this.writeEmitter.fire(line + '\r\n');
  }
}
