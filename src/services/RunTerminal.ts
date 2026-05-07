import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import type { Prettifier } from './prettyOutput';

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
  // Optional. When set, output is line-buffered through the prettifier before
  // hitting the terminal (hyperlinks, bold ready/fail markers, level coloring).
  // The readiness scanner (onOutput) still receives the raw, untransformed
  // text so regex matches aren't thrown off by inserted ANSI codes.
  prettifier?: Prettifier;
  // Invoked once when the child exits, before the terminal closes.
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  // When true, the terminal LINGERS after the child exits — the user
  // can scroll through logs and dismiss it manually with any key.
  // Mirrors VS Code's built-in "Terminal will be reused by tasks,
  // press any key to close it" behavior. When false (default), the
  // terminal closes as soon as the process exits, matching the
  // pre-toggle behavior.
  keepOpenOnExit?: boolean;
}

export class RunTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private child: cp.ChildProcess | undefined;
  // True once we've fired closeEmitter — guards against double-fires
  // and tells us whether subsequent input/close calls are operating on
  // a dead terminal.
  private closed = false;
  // True after the child has exited but the terminal is intentionally
  // staying open (keepOpenOnExit + the child is gone). In this state:
  //   - any input from the user dismisses the terminal,
  //   - VS Code's close() fires closeEmitter immediately (no kill —
  //     there's nothing to kill).
  private lingering = false;

  constructor(private readonly opts: RunTerminalOpts) {}

  // VS Code calls this when the task (and thus the terminal) opens.
  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.spawnChild();
  }

  close(): void {
    if (this.lingering) {
      // The child is already gone; the user (or VS Code's task system)
      // is asking the terminal to actually close now. Honor it.
      this.fireClose(0);
      return;
    }
    this.kill();
  }

  // Public kill entrypoint. Called by ExecutionService.stop when the
  // user clicks the Stop button, INSTEAD of going through
  // TaskExecution.terminate() — that path makes VS Code fire close()
  // on the pseudoterminal, which then tears it down before our linger
  // hook can prevent it. Going direct lets the child exit, the
  // terminal flip into lingering mode, and stay alive until the user
  // dismisses it.
  requestStop(): void {
    this.kill();
  }

  // User-typed input. Two phases:
  //   - while the child is alive: Ctrl+C / Ctrl+D forwards a stop;
  //     other keys are ignored.
  //   - while lingering (child exited, keepOpenOnExit is true): ANY
  //     key dismisses the terminal so the user doesn't have to hunt
  //     for the close button. Matches VS Code's built-in launcher.
  handleInput(data: string): void {
    if (this.lingering) {
      this.fireClose(0);
      return;
    }
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
        // detached:true makes the child a process-group leader on Unix so
        // signalling its negative pid hits every grandchild too. Without this,
        // stopping a config kills only the shell and leaves dev servers
        // (node/vite/angular) orphaned and holding the port. No-op on Windows
        // — we use taskkill /T there instead.
        detached: !isWin,
      });
    } catch (e) {
      this.writeLine(`Failed to spawn: ${(e as Error).message}`);
      this.closeEmitter.fire(1);
      this.closed = true;
      return;
    }

    const prettifier = this.opts.prettifier;
    const onChunk = (buf: Buffer) => {
      const text = buf.toString();
      const transformed = prettifier ? prettifier.process(text) : text;
      // Normalize bare LF to CRLF for the VT100 terminal.
      this.writeEmitter.fire(transformed.replace(/\r?\n/g, '\r\n'));
      // Scanner sees raw text so inserted ANSI codes don't break its regexes.
      try { this.opts.onOutput?.(text); } catch { /* keep output flowing */ }
    };

    this.child.stdout?.on('data', onChunk);
    this.child.stderr?.on('data', onChunk);

    this.child.on('error', e => {
      this.writeLine(`\r\nChild process error: ${e.message}`);
      this.finish(1, null);
    });

    this.child.on('exit', (code, signal) => {
      // Flush any partial line the prettifier was still buffering.
      if (prettifier) {
        const tail = prettifier.flush();
        if (tail) this.writeEmitter.fire(tail.replace(/\r?\n/g, '\r\n'));
      }
      this.writeLine(`\r\nProcess exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`);
      this.finish(code, signal);
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed || this.lingering) return;
    // Always notify the caller (ExecutionService) that the child is
    // gone — running-state must update regardless of whether we
    // linger the terminal afterwards.
    try { this.opts.onExit?.(code, signal); } catch { /* ignore */ }

    if (this.opts.keepOpenOnExit) {
      // Stay open and wait for the user to dismiss us. We deliberately
      // do NOT fire closeEmitter here — that would ask VS Code to
      // tear down the terminal.
      this.lingering = true;
      this.writeLine('');
      this.writeLine('\x1b[2mTerminal will be closed on next key press.\x1b[0m');
      return;
    }

    this.fireClose(code ?? 0);
  }

  private fireClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.lingering = false;
    this.closeEmitter.fire(code);
  }

  private kill(): void {
    if (!this.child || this.closed) return;
    const pid = this.child.pid;
    if (!pid) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
      return;
    }

    if (os.platform() === 'win32') {
      // /T kills the whole tree rooted at pid; /F is force. Graceful stop
      // isn't really a thing on Windows for console processes — taskkill
      // without /F only works on windowed apps.
      try {
        cp.spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } catch { /* ignore */ }
      return;
    }

    // Unix: signal the whole process group (negative pid). Requires the
    // child to have been spawned with detached:true so it's a group leader.
    // SIGTERM gives dev servers (Vite, Angular, webpack) a chance to close
    // their ports cleanly; grandchildren (node) get it too and exit.
    try { process.kill(-pid, 'SIGTERM'); } catch {
      // Fallback: signal just the shell if the group send fails (e.g. the
      // child died between check and kill).
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }

    // Force-kill the group if anything survives 3s. Java apps with shutdown
    // hooks and Gradle daemons are the usual holdouts.
    setTimeout(() => {
      if (this.closed || !this.child || this.child.exitCode !== null) return;
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3000);
  }

  private writeLine(line: string): void {
    this.writeEmitter.fire(line + '\r\n');
  }
}
