import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PythonFramework } from '../../shared/types';
import { FRAMEWORK_COMMANDS } from './frameworkCommands';
import { log } from '../../utils/logger';

// Best-effort port detection. Order, first hit wins:
//   1. Procfile parsing.
//   2. Framework convention default.
// Returns undefined when no port can be determined.
export async function detectPythonPort(
  projectUri: vscode.Uri,
  framework: PythonFramework,
): Promise<number | undefined> {
  const root = projectUri.fsPath;

  // 1. Procfile.
  try {
    const text = await fs.promises.readFile(path.join(root, 'Procfile'), 'utf8');
    for (const line of text.split('\n')) {
      const port = parseProcfilePort(line);
      if (port !== undefined) return port;
    }
  } catch (e) {
    log.debug(`detectPythonPort: no Procfile or unreadable: ${(e as Error).message}`);
  }

  // 2. Framework default.
  return defaultPortForFramework(framework);
}

// Parses a Procfile line for an explicit port. Recognises:
//   --port <n>, -p <n>, :<n> (in -b host:port style bind args).
// Returns undefined when no port appears in the line.
export function parseProcfilePort(line: string): number | undefined {
  const portFlag = line.match(/(?:--port|-p)\s+(\d+)/);
  if (portFlag) return Number(portFlag[1]);
  const bindFlag = line.match(/[:](\d{2,5})\b/);
  if (bindFlag) return Number(bindFlag[1]);
  return undefined;
}

export function defaultPortForFramework(framework: PythonFramework): number | undefined {
  const spec = FRAMEWORK_COMMANDS[framework];
  return spec?.defaultPort ?? undefined;
}
