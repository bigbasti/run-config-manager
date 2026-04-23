import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Run Configurations');
  return channel;
}

// HH:MM:SS.mmm — stable across locales, enough precision to see why a probe
// that should be fast is actually slow.
function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export const log = {
  // Things the user would plausibly care about: started/stopped, errors
  // from their perspective, top-level command dispatches. Keep this lean so
  // the channel is useful to read.
  info(msg: string): void {
    initLogger().appendLine(`${ts()} [info]  ${msg}`);
  },
  // Internal details — prepareLaunch env keys, buildCommand output, streaming
  // patches, webview messages. Enabled unconditionally for now; gate behind
  // a setting if the channel gets noisy.
  debug(msg: string): void {
    initLogger().appendLine(`${ts()} [debug] ${msg}`);
  },
  warn(msg: string): void {
    initLogger().appendLine(`${ts()} [warn]  ${msg}`);
  },
  error(msg: string, err?: unknown): void {
    initLogger().appendLine(
      `${ts()} [error] ${msg}${err ? ` — ${(err as Error).message ?? String(err)}` : ''}`,
    );
  },
  show(): void {
    initLogger().show();
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
