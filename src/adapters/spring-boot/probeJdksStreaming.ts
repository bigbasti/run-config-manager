import type { StreamingPatch } from '../RuntimeAdapter';
import { detectJdks, probeJdkVersion, type JdkInfo } from './detectJdks';
import { log } from '../../utils/logger';

// Two-phase JDK detection helper used by every adapter that exposes a JDK
// dropdown. It does what the inline detectJdks() call used to do, plus a
// second sweep that probes versions in parallel and re-emits an enriched
// list. The `typeOptions.jdkPath` field stays in `pending` (spinner) for
// the entire duration so the dropdown shows a working indicator while we
// learn each JDK's version.
//
// Two emits:
//   1. Right after detectJdks() returns: `jdks` is JdkInfo[] with paths
//      only. The dropdown is usable immediately. `typeOptions.jdkPath`
//      is NOT in `resolved` yet — the spinner stays.
//   2. After all version probes settle: `jdks` is the same JdkInfo[]
//      with `version`/`vendor` populated. We then clear the spinner.
export async function probeJdksStreaming(
  emit: (p: StreamingPatch) => void,
  defaultsPatchKey: string,
): Promise<void> {
  const paths = await detectJdks();
  log.debug(`probeJdksStreaming: detected ${paths.length} JDK path(s)`);
  // Phase 1 — paths only. Default is the first path; do NOT mark
  // typeOptions.jdkPath resolved yet so the spinner keeps showing while
  // versions stream in.
  const initial: JdkInfo[] = paths.map(p => ({ path: p }));
  emit({
    contextPatch: { jdks: initial },
    ...(paths[0]
      ? { defaultsPatch: buildDefaultsPatch(defaultsPatchKey, paths[0]) }
      : {}),
    // resolved omitted — keep spinner up.
  });

  if (paths.length === 0) {
    // No JDKs at all — clear the spinner so the user isn't waiting forever.
    emit({ contextPatch: {}, resolved: ['typeOptions.jdkPath'] });
    return;
  }

  // Phase 2 — probe each path's version in parallel. allSettled so a single
  // hung probe doesn't block the rest; the per-call timeout in
  // probeJdkVersion already prevents any one probe from running long.
  const enriched: JdkInfo[] = await Promise.all(
    paths.map(async p => {
      try {
        const info = await probeJdkVersion(p);
        return { path: p, ...info };
      } catch {
        return { path: p };
      }
    }),
  );
  log.debug(
    `probeJdksStreaming: enriched ${enriched.filter(j => j.version).length}/` +
    `${enriched.length} with version info`,
  );
  emit({
    contextPatch: { jdks: enriched },
    resolved: ['typeOptions.jdkPath'],
  });
}

// Helper so each adapter can pass the right defaultsPatch shape — every
// type stores the JDK in `typeOptions.jdkPath`, but the union types make
// a generic builder painful, so we accept a key tag to log against and
// build the patch with `as any`.
function buildDefaultsPatch(key: string, jdkPath: string) {
  log.debug(`probeJdksStreaming: defaulting ${key} to ${jdkPath}`);
  return { typeOptions: { jdkPath } } as any;
}

// Adapter-side helpers: tolerate both shapes during the migration so that
// older saved context (or the initial sync detect()) carrying string[]
// still renders correctly.
export function readJdks(value: unknown): JdkInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => {
    if (typeof v === 'string') return { path: v };
    if (v && typeof v === 'object' && typeof (v as JdkInfo).path === 'string') {
      return v as JdkInfo;
    }
    return null;
  }).filter((v): v is JdkInfo => v !== null);
}

// Format a dropdown option for a JdkInfo. When version is known, label
// reads "/path — Java 21.0.2 (Temurin)"; otherwise just the path.
export function jdkOption(j: JdkInfo): { value: string; label: string } {
  let label = j.path;
  if (j.version) {
    const display = j.vendor ? `Java ${j.version} (${j.vendor})` : `Java ${j.version}`;
    label = `${j.path} — ${display}`;
  }
  return { value: j.path, label };
}
