import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Run Configurations');
  return channel;
}

export const log = {
  info(msg: string): void {
    initLogger().appendLine(`[info]  ${msg}`);
  },
  warn(msg: string): void {
    initLogger().appendLine(`[warn]  ${msg}`);
  },
  error(msg: string, err?: unknown): void {
    initLogger().appendLine(`[error] ${msg}${err ? ` — ${(err as Error).message ?? String(err)}` : ''}`);
  },
  show(): void {
    initLogger().show();
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
