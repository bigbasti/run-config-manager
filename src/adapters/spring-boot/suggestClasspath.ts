import * as vscode from 'vscode';
import type { JavaBuildTool } from '../../shared/types';

// Synchronous best-effort classpath suggestion during detection. Does not
// invoke Maven/Gradle; that slow path lives in `recomputeClasspath`.
export async function suggestClasspath(
  folder: vscode.Uri,
  buildTool: JavaBuildTool,
): Promise<string> {
  // 1. Java extension, if installed.
  try {
    const ext = vscode.extensions.getExtension('redhat.java');
    if (ext) {
      const api = await ext.activate();
      if (api && typeof (api as any).getClasspath === 'function') {
        const cp = await (api as any).getClasspath(folder.fsPath);
        if (Array.isArray(cp) && cp.length > 0) return cp.join(pathSeparator());
      }
    }
  } catch { /* ignore */ }

  // 2. Hint. User clicks "Recompute" for the real one.
  return buildTool === 'maven'
    ? `target/classes${pathSeparator()}target/dependency/*`
    : `build/classes/java/main${pathSeparator()}build/libs/*`;
}

export function pathSeparator(): string {
  return process.platform === 'win32' ? ';' : ':';
}
