import type { RunConfig } from './types';

// Pure, synchronous preview used by the webview (no vscode imports).
// Mirrors NpmAdapter.buildCommand for display purposes only.
export function buildCommandPreview(cfg: RunConfig): string {
  if (cfg.type !== 'npm') return `(unsupported type: ${cfg.type})`;

  const pm = cfg.typeOptions.packageManager;
  const script = cfg.typeOptions.scriptName || '<script>';
  const base = `${pm} run ${script}`;
  const args = (cfg.programArgs ?? '').trim();
  const withArgs = args ? `${base} -- ${args}` : base;
  return cfg.projectPath ? `cd ${cfg.projectPath} && ${withArgs}` : withArgs;
}
