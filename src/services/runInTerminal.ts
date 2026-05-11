import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { log } from '../utils/logger';

// Spawns a Python invocation in a fresh integrated terminal. Falls back
// to the system `python3` on PATH when no interpreter is selected.
//
// **Race-safe send.** `term.sendText` immediately after `createTerminal`
// can land in the prompt before the shell has finished its rc/profile
// initialization — the first half of the command appears, then shell
// init output (`* start-stop-daemon: …`) interrupts it, and the rest
// of the command lands at a later prompt as a separate, broken line.
//
// VS Code 1.93+ ships `Terminal.shellIntegration` which guarantees the
// shell is ready and lets us send via `executeCommand` (no race). We
// use that when available and fall back to a delayed `sendText` when
// not — the delay is shorter than the typical shell init so the user
// sees their command appear quickly on a healthy host, and works
// around the race on hosts with chatty rc files.
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
  // Quote the binary path so spaces in the install dir survive. Args
  // are shell-safe by construction (callers pass constants + a
  // regex-validated package name).
  const quoted = bin.includes(' ') ? `"${bin}"` : bin;
  const cmdLine = `${quoted} ${args.join(' ')}`;

  const term = vscode.window.createTerminal({
    name: terminalName,
    // Empty cwd → omit so VS Code picks the workspace default. Used
    // by the missing-module pip-install toast which doesn't carry a
    // resolved project path.
    ...(cwd ? { cwd } : {}),
    iconPath: new vscode.ThemeIcon('cloud-download'),
  });
  term.show(true);
  log.info(`runPythonInTerminal: ${cmdLine} (cwd ${cwd})`);
  sendWhenReady(term, cmdLine);
}

// Either uses shell integration (no race) or polls for it for up to
// 3 seconds, then falls back to a plain sendText. The poll is cheap
// and avoids the "first chars get eaten by shell init" failure mode.
function sendWhenReady(term: vscode.Terminal, cmdLine: string): void {
  // Fast path: integration already available (rare on cold terminal).
  if (term.shellIntegration) {
    term.shellIntegration.executeCommand(cmdLine);
    return;
  }
  // Listen for the shell-integration-ready event. Most healthy hosts
  // surface it within a few hundred ms.
  let resolved = false;
  const sub = vscode.window.onDidChangeTerminalShellIntegration?.(e => {
    if (resolved || e.terminal !== term || !e.shellIntegration) return;
    resolved = true;
    sub?.dispose();
    e.shellIntegration.executeCommand(cmdLine);
  });
  // Fallback: if shell integration never arrives (older VS Code,
  // unsupported shell, or a slow host), send a plain text line after
  // 800 ms — long enough for typical bash / zsh init to finish and
  // print its banner, short enough that the user doesn't notice a
  // pause.
  setTimeout(() => {
    if (resolved) return;
    resolved = true;
    sub?.dispose();
    term.sendText(cmdLine, true);
  }, 800).unref?.();
}
