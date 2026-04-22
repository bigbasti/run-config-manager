import { z } from 'zod';
import type { RunFile, Result } from './types';

export const PackageManagerSchema = z.enum(['npm', 'yarn', 'pnpm']);

export const NpmTypeOptionsSchema = z.object({
  scriptName: z.string().min(1),
  packageManager: PackageManagerSchema,
});

export const RunConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: z.literal('npm'),
  projectPath: z.string(),
  workspaceFolder: z.string(),
  env: z.record(z.string(), z.string()),
  programArgs: z.string(),
  vmArgs: z.string(),
  port: z.number().int().positive().optional(),
  typeOptions: NpmTypeOptionsSchema,
});

export const RunFileSchema = z.object({
  version: z.literal(1),
  configurations: z.array(RunConfigSchema),
});

export function parseRunFile(raw: string): Result<RunFile, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const result = RunFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join('.');
    return { ok: false, error: `Schema error at "${path}": ${issue.message}` };
  }
  return { ok: true, value: result.data };
}

export function stringifyRunFile(file: RunFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}
