import * as vscode from 'vscode';
import type { StreamingPatch } from '../RuntimeAdapter';
import { detectPythons, type PythonInfo } from './detectPythons';
import { probePythonVersion } from './probePythonVersion';
import { log } from '../../utils/logger';

// Two-phase Python detection used by PythonAdapter.detectStreaming.
// Mirrors probeJdksStreaming / probeNodesStreaming.
// Two emits:
//   1. After detectPythons(): contextPatch = { pythons: PythonInfo[] }
//      with paths only. Default seeded to first path. `resolved` omitted
//      so the field's spinner stays up while versions stream in.
//   2. After version probes settle: contextPatch with enriched PythonInfo[];
//      resolved = ['typeOptions.pythonPath'] to clear the spinner.
export async function probePythonsStreaming(
  projectUri: vscode.Uri,
  emit: (p: StreamingPatch) => void,
  defaultsPatchKey: string,
): Promise<void> {
  const paths = await detectPythons(projectUri);
  log.debug(`probePythonsStreaming: detected ${paths.length} Python path(s)`);

  const initial: PythonInfo[] = paths.map(p => ({ path: p }));
  emit({
    contextPatch: { pythons: initial },
    ...(paths[0]
      ? { defaultsPatch: buildDefaultsPatch(defaultsPatchKey, paths[0]) }
      : {}),
  });

  if (paths.length === 0) {
    emit({ contextPatch: {}, resolved: ['typeOptions.pythonPath'] });
    return;
  }

  const enriched: PythonInfo[] = await Promise.all(
    paths.map(async p => {
      try {
        const info = await probePythonVersion(p);
        return { path: p, ...info };
      } catch { return { path: p }; }
    }),
  );
  log.debug(
    `probePythonsStreaming: enriched ${enriched.filter(p => p.version).length}/` +
    `${enriched.length} with version info`,
  );
  emit({
    contextPatch: { pythons: enriched },
    resolved: ['typeOptions.pythonPath'],
  });
}

function buildDefaultsPatch(key: string, pythonPath: string) {
  log.debug(`probePythonsStreaming: defaulting ${key}.typeOptions.pythonPath to ${pythonPath}`);
  return { typeOptions: { pythonPath } } as any;
}

export function readPythons(value: unknown): PythonInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => {
    if (typeof v === 'string') return { path: v };
    if (v && typeof v === 'object' && typeof (v as PythonInfo).path === 'string') {
      return v as PythonInfo;
    }
    return null;
  }).filter((v): v is PythonInfo => v !== null);
}

export function pythonOption(p: PythonInfo): { value: string; label: string } {
  let label = p.path;
  if (p.version) label = `${p.path} — Python ${p.version}`;
  return { value: p.path, label };
}
