import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../../utils/logger';

export interface ScriptEntryPoint {
  // Path relative to the project root, with forward slashes.
  relativePath: string;
}

export interface ModuleEntryPoint {
  // Dotted module name (e.g. 'mypkg.cli').
  dotted: string;
}

// Walks the project for scripts containing `if __name__ == "__main__":` and
// modules with a `__main__.py`. Skips conventional non-source folders so
// large projects don't take seconds to scan.
//
// Returns at most 50 of each — covers every realistic project size and
// caps the cost on monorepos.
export async function findEntryPoints(projectUri: vscode.Uri): Promise<{
  scripts: ScriptEntryPoint[];
  modules: ModuleEntryPoint[];
}> {
  const root = projectUri.fsPath;
  const scripts: ScriptEntryPoint[] = [];
  const modules: ModuleEntryPoint[] = [];
  const skipDirs = new Set([
    '.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.tox',
    '.nox', '.eggs', 'site-packages',
  ]);

  // Try common source-prefix dirs in order of likelihood.
  const candidatePrefixes = await detectSourcePrefix(root);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return; // bound the recursion
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (scripts.length >= 50 && modules.length >= 50) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.py')) continue;

      // __main__.py → module entry.
      if (entry.name === '__main__.py') {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const prefix = matchPrefix(rel, candidatePrefixes);
        const dotted = splitDottedFromPath(rel, prefix);
        if (dotted && modules.length < 50) modules.push({ dotted });
        continue;
      }

      // Otherwise check for the __main__ guard.
      try {
        const text = await fs.promises.readFile(full, 'utf8');
        if (text.split('\n').some(isMainGuardLine)) {
          if (scripts.length < 50) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            scripts.push({ relativePath: rel });
          }
        }
      } catch (e) {
        log.debug(`findEntryPoints: read ${full} failed: ${(e as Error).message}`);
      }
    }
  }

  await walk(root, 0);
  return { scripts, modules };
}

// Matches `if __name__ == "__main__":` (single or double quotes, optional
// leading whitespace, no comments, no other content on the line).
export function isMainGuardLine(line: string): boolean {
  return /^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:\s*$/.test(line);
}

// Convert a relative path like "src/mypkg/cli.py" into a dotted module
// name "mypkg.cli", honoring an optional source-prefix dir (e.g. "src").
// `__main__.py` collapses to the parent package name.
export function splitDottedFromPath(relativePath: string, sourcePrefix: string): string {
  let rel = relativePath.replace(/\\/g, '/');
  if (sourcePrefix && rel.startsWith(sourcePrefix + '/')) {
    rel = rel.slice(sourcePrefix.length + 1);
  }
  if (rel.endsWith('/__main__.py')) rel = rel.slice(0, -'/__main__.py'.length);
  else if (rel.endsWith('.py')) rel = rel.slice(0, -3);
  else return '';
  return rel.split('/').filter(Boolean).join('.');
}

async function detectSourcePrefix(root: string): Promise<string[]> {
  // Prefer common source-prefix dirs if they exist.
  const candidates = ['src'];
  const out: string[] = [];
  for (const c of candidates) {
    try {
      const stat = await fs.promises.stat(path.join(root, c));
      if (stat.isDirectory()) out.push(c);
    } catch { /* not present */ }
  }
  out.push(''); // also try root-as-prefix.
  return out;
}

function matchPrefix(rel: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (!p) continue;
    if (rel.startsWith(p + '/')) return p;
  }
  return '';
}
