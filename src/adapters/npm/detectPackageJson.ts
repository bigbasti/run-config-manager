import * as vscode from 'vscode';
import type { PackageManager } from '../../shared/types';

export interface PackageJsonInfo {
  scripts: string[];
  packageManager: PackageManager;
  defaultScript: string;
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
  const scripts = Object.keys(scriptsObj).filter(k => typeof scriptsObj[k] === 'string');

  const defaultScript =
    scripts.includes('start') ? 'start'
    : scripts.includes('dev') ? 'dev'
    : scripts[0] ?? '';

  const pm = await detectPackageManager(folder);

  return { scripts, defaultScript, packageManager: pm };
}

async function detectPackageManager(folder: vscode.Uri): Promise<PackageManager> {
  if (await exists(vscode.Uri.joinPath(folder, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(vscode.Uri.joinPath(folder, 'yarn.lock'))) return 'yarn';
  return 'npm';
}
