import type { RunConfig, InvalidConfigEntry } from '../shared/types';

// Best-effort extraction of RunConfig fields from an invalid entry's rawText.
// Pure function; never throws. Callers should treat the result as a Partial.
export function buildRecoveredConfig(entry: InvalidConfigEntry): Partial<RunConfig> {
  const base: Partial<RunConfig> = { id: entry.id, name: entry.name };

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.rawText);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;

  const o = parsed as Record<string, unknown>;
  const out: Partial<RunConfig> = { ...base };

  if (typeof o.id === 'string') out.id = o.id;
  if (typeof o.name === 'string') out.name = o.name;
  if (typeof o.type === 'string') out.type = o.type as RunConfig['type'];
  if (typeof o.projectPath === 'string') out.projectPath = o.projectPath;
  if (typeof o.workspaceFolder === 'string') out.workspaceFolder = o.workspaceFolder;
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    out.env = Object.fromEntries(
      Object.entries(o.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  }
  if (typeof o.programArgs === 'string') out.programArgs = o.programArgs;
  if (typeof o.vmArgs === 'string') out.vmArgs = o.vmArgs;
  if (typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0) out.port = o.port;
  if (o.typeOptions && typeof o.typeOptions === 'object' && !Array.isArray(o.typeOptions)) {
    const t = o.typeOptions as Record<string, unknown>;
    const scriptName = typeof t.scriptName === 'string' ? t.scriptName : '';
    const pmRaw = typeof t.packageManager === 'string' ? t.packageManager : 'npm';
    const packageManager =
      pmRaw === 'npm' || pmRaw === 'yarn' || pmRaw === 'pnpm' ? pmRaw : 'npm';
    out.typeOptions = { scriptName, packageManager };
  }

  return out;
}
