import * as vscode from 'vscode';
import type { DebugConfiguration } from 'vscode';
import type { RunConfig, RunConfigType } from '../shared/types';
import type { FormSchema } from '../shared/formSchema';

export interface DetectionResult {
  defaults: Partial<RunConfig>;
  // Arbitrary adapter-specific data used to shape the form (e.g., list of scripts).
  context: Record<string, unknown>;
}

export interface RuntimeAdapter {
  readonly type: RunConfigType;
  readonly label: string;

  // Whether this adapter can produce a working debug configuration for v1.
  // Adapters that return false have their Debug button hidden in the tree.
  readonly supportsDebug: boolean;

  detect(folder: vscode.Uri): Promise<DetectionResult | null>;

  getFormSchema(context: Record<string, unknown>): FormSchema;

  buildCommand(cfg: RunConfig): { command: string; args: string[] };

  // Only required when supportsDebug === true. Adapters that don't support
  // debug can omit this method.
  getDebugConfig?(cfg: RunConfig, folder: vscode.WorkspaceFolder): DebugConfiguration;
}
