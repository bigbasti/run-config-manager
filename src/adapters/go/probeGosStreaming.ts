import type { StreamingPatch } from '../RuntimeAdapter';
import { detectGos, type GoInstall } from './detectGos';
import { probeGoVersion } from './probeGoVersion';

// Two-phase streaming probe for Go installations — mirrors the Python
// `probePythonsStreaming` pattern:
//
//   Phase 1 (fast): emit all detected install paths with no version info.
//                   This immediately populates the runtime dropdown so the
//                   user sees options without waiting for the version probe.
//   Phase 2 (slow): probe each install's version; emit enriched list so
//                   the dropdown labels become "path — Go 1.22.3".
//
// `emit` is the StreamingPatch emitter from detectStreaming.
export async function probeGosStreaming(
  emit: (patch: StreamingPatch) => void,
): Promise<void> {
  const paths = await detectGos();

  // Phase 1: paths with no version
  const initial: GoInstall[] = paths.map(p => ({ path: p }));
  emit({
    contextPatch: { gos: initial },
    ...(paths[0] ? { defaultsPatch: { typeOptions: { goPath: paths[0] } } as any } : {}),
    resolved: [],
  });

  if (paths.length === 0) {
    emit({ contextPatch: {}, resolved: ['typeOptions.goPath'] });
    return;
  }

  // Phase 2: enrich with version strings
  const enriched: GoInstall[] = await Promise.all(
    paths.map(async p => {
      try {
        const version = await probeGoVersion(p);
        return { path: p, version };
      } catch {
        return { path: p };
      }
    }),
  );
  emit({ contextPatch: { gos: enriched }, resolved: ['typeOptions.goPath'] });
}

// Reads the `gos` context value into a typed array, tolerating the raw
// path-string form used during Phase 1 and the enriched object form from
// Phase 2. Never throws.
export function readGos(value: unknown): GoInstall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => {
      if (typeof v === 'string') return { path: v };
      if (v && typeof v === 'object' && typeof (v as GoInstall).path === 'string') {
        return v as GoInstall;
      }
      return null;
    })
    .filter((v): v is GoInstall => v !== null);
}

// Builds a { value, label } option for the selectOrCustom runtime dropdown.
export function goOption(g: GoInstall): { value: string; label: string } {
  const label = g.version ? `${g.path} — Go ${g.version}` : g.path;
  return { value: g.path, label };
}
