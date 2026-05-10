import type { StreamingPatch } from '../RuntimeAdapter';
import { detectNodes, probeNodeVersion } from './detectNodes';
import type { NodeInfo } from './detectNodes';
import { log } from '../../utils/logger';

// Two-phase Node detection used by NpmAdapter.detectStreaming. Mirrors
// `probeJdksStreaming.ts`. Two emits:
//   1. After detectNodes(): contextPatch = { nodes: NodeInfo[] } with
//      paths only. Default seeded to first path. `resolved` omitted so
//      the field's spinner stays up while versions stream in.
//   2. After version probes settle: contextPatch with enriched
//      NodeInfo[]; resolved = ['typeOptions.nodePath'] to clear the
//      spinner.
export async function probeNodesStreaming(
  emit: (p: StreamingPatch) => void,
  defaultsPatchKey: string,
): Promise<void> {
  const paths = await detectNodes();
  log.debug(`probeNodesStreaming: detected ${paths.length} Node path(s)`);

  const initial: NodeInfo[] = paths.map(p => ({ path: p }));
  emit({
    contextPatch: { nodes: initial },
    ...(paths[0]
      ? { defaultsPatch: buildDefaultsPatch(defaultsPatchKey, paths[0]) }
      : {}),
  });

  if (paths.length === 0) {
    emit({ contextPatch: {}, resolved: ['typeOptions.nodePath'] });
    return;
  }

  const enriched: NodeInfo[] = await Promise.all(
    paths.map(async p => {
      try {
        const info = await probeNodeVersion(p);
        return { path: p, ...info };
      } catch { return { path: p }; }
    }),
  );
  log.debug(
    `probeNodesStreaming: enriched ${enriched.filter(n => n.version).length}/` +
    `${enriched.length} with version info`,
  );
  emit({
    contextPatch: { nodes: enriched },
    resolved: ['typeOptions.nodePath'],
  });
}

function buildDefaultsPatch(key: string, nodePath: string) {
  log.debug(`probeNodesStreaming: defaulting ${key}.typeOptions.nodePath to ${nodePath}`);
  return { typeOptions: { nodePath } } as any;
}

export function readNodes(value: unknown): NodeInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => {
    if (typeof v === 'string') return { path: v };
    if (v && typeof v === 'object' && typeof (v as NodeInfo).path === 'string') {
      return v as NodeInfo;
    }
    return null;
  }).filter((v): v is NodeInfo => v !== null);
}

export function nodeOption(n: NodeInfo): { value: string; label: string } {
  let label = n.path;
  if (n.version) label = `${n.path} — v${n.version}`;
  return { value: n.path, label };
}
