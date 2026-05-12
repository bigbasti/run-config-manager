import * as vscode from 'vscode';
import type { PackageManager } from '../../shared/types';
import { detectNpmFramework } from './detectNpmFramework';

export interface PackageJsonInfo {
  scripts: string[];
  packageManager: PackageManager;
  defaultScript: string;
  // Full scripts map (key → command line). Surfaced so callers can
  // inspect script bodies without re-reading package.json.
  pkgScripts: Record<string, string>;
  // Union of dependencies + devDependencies. Used by the framework
  // detector + ExecutionService pre-flight.
  dependencies: string[];
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

export async function readPackageJsonInfo(
  folder: vscode.Uri,
): Promise<PackageJsonInfo | null> {
  const pkgUri = vscode.Uri.joinPath(folder, 'package.json');
  const raw = await readText(pkgUri);
  if (raw === null) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const scriptsObj = (parsed && typeof parsed === 'object' && parsed.scripts) || {};
  const pkgScripts: Record<string, string> = {};
  for (const k of Object.keys(scriptsObj)) {
    if (typeof scriptsObj[k] === 'string') pkgScripts[k] = scriptsObj[k];
  }
  const scripts = Object.keys(pkgScripts);

  const dependencies = uniqueDepNames(parsed?.dependencies, parsed?.devDependencies);

  // Ask the framework detector for a smarter default script. When no
  // framework is detected, fall back to the historic 'start' / 'dev' /
  // first-script preference order so behavior is unchanged on
  // unrecognized projects.
  const fw = await detectNpmFramework(folder, scripts, pkgScripts, dependencies);
  const defaultScript = fw.name && fw.defaultScript
    ? fw.defaultScript
    : (scripts.includes('start') ? 'start'
      : scripts.includes('dev') ? 'dev'
      : scripts[0] ?? '');

  const pm = await detectPackageManager(folder);

  return { scripts, defaultScript, packageManager: pm, pkgScripts, dependencies };
}

function uniqueDepNames(
  deps: unknown,
  devDeps: unknown,
): string[] {
  const set = new Set<string>();
  for (const obj of [deps, devDeps]) {
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj as Record<string, unknown>)) set.add(key);
    }
  }
  return [...set];
}

async function detectPackageManager(folder: vscode.Uri): Promise<PackageManager> {
  if (await exists(vscode.Uri.joinPath(folder, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(vscode.Uri.joinPath(folder, 'yarn.lock'))) return 'yarn';
  return 'npm';
}
