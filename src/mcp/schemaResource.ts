import { zodToJsonSchema } from 'zod-to-json-schema';
import { RunConfigSchema } from '../shared/schema';

// Generated at runtime from the single source of truth (the Zod schema).
// `$refStrategy: 'none'` inlines the discriminated-union variants so an agent
// reading the resource sees each type's full shape without dereferencing.
export function runConfigJsonSchema(): object {
  return zodToJsonSchema(RunConfigSchema, {
    name: 'RunConfig',
    $refStrategy: 'none',
  });
}
