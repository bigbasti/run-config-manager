import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { log } from '../utils/logger';

// Runs a one-shot Python invocation as a VS Code Task with
// `ShellExecution`. Falls back to system `python3` on PATH when no
// interpreter is selected.
//
// **Why a Task and not `createTerminal` + `sendText`?**
// `vscode.window.createTerminal` opens an interactive shell that
// sources `.bashrc` / `.zshrc` / `.profile`. On hosts with chatty rc
// files (WSL with `wsl-vpnkit`, oh-my-zsh, nvm autoloads, etc.) the
// shell init prints output BETWEEN VS Code attaching the terminal and
// our `sendText` arriving — the user sees their command get
// interleaved with `* start-stop-daemon: …`-style banners or, worse,
// duplicated when the shell-integration event fires after the fallback
// timer already sent the line.
//
// Tasks side-step the whole problem: VS Code launches them via
// `bash -c '<cmd>'` (non-interactive), which DOESN'T source rc files.
// The terminal opens, the command starts, the user sees output. No
// race, no banner, no duplication. This is the same path the
// npm-action / build-action helpers use.
export function runPythonInTerminal(
  pythonHome: string,
  args: string[],
  cwd: string,
  terminalName: string,
): void {
  const isWin = os.platform() === 'win32';
  const bin = !pythonHome
    ? 'python3'
    : isWin
      ? path.join(pythonHome, 'python.exe')
      : path.join(pythonHome, 'bin', 'python3');

  log.info(`runPythonInTerminal: ${bin} ${args.join(' ')} (cwd "${cwd}")`);
  // Empty cwd → don't pass it; VS Code uses the workspace default.
  const execution = new vscode.ShellExecution(bin, args, cwd ? { cwd } : undefined);
  // The task `scope` controls which workspace folder the run is
  // attributed to. We don't always have one (the missing-module toast
  // fires from ExecutionService where the cfg's folder isn't easy to
  // thread through), and a Global-scoped task works fine for these
  // one-shots — VS Code surfaces the terminal the same way.
  const task = new vscode.Task(
    { type: 'rcm-pip', cmd: terminalName } as any,
    vscode.TaskScope.Workspace,
    terminalName,
    'Run Configurations',
    execution,
    [],
  );
  vscode.tasks.executeTask(task).then(undefined, e => {
    log.warn(`runPythonInTerminal: failed to start task "${terminalName}": ${(e as Error).message}`);
    vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${(e as Error).message}`);
  });
}
