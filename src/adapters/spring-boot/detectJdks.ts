import * as vscode from 'vscode';

// Returns a list of JDK install directories (each should contain a `bin/java`
// executable). Consumer is responsible for the path join to `bin/java`.
export async function detectJdks(): Promise<string[]> {
  const found: string[] = [];

  // 1. Java extension, if installed and active.
  try {
    const ext = vscode.extensions.getExtension('redhat.java');
    if (ext) {
      const api = ext.isActive ? await ext.activate() : await ext.activate();
      if (api) {
        if (Array.isArray((api as any).jdks)) {
          for (const j of (api as any).jdks) {
            if (j?.path) found.push(String(j.path));
          }
        } else if (typeof (api as any).getConfiguration === 'function') {
          const cfg = (api as any).getConfiguration();
          const runtimes = cfg?.get?.('java.configuration.runtimes') ?? [];
          for (const r of runtimes as any[]) {
            if (r?.path) found.push(String(r.path));
          }
        }
      }
    }
  } catch { /* ignore — fall through */ }

  // 2. JAVA_HOME.
  if (process.env.JAVA_HOME) found.push(process.env.JAVA_HOME);

  // 3. Filesystem probes.
  const roots = [
    '/usr/lib/jvm',
    '/opt',
    '/Library/Java/JavaVirtualMachines',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
  ];
  for (const root of roots) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
      for (const [name, kind] of entries) {
        if (kind !== vscode.FileType.Directory) continue;
        const candidate = `${root}/${name}`;
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(`${candidate}/bin/java`));
          found.push(candidate);
        } catch { /* not a JDK — skip */ }
      }
    } catch { /* root doesn't exist — skip */ }
  }

  // Dedupe, preserving first-seen order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of found) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
