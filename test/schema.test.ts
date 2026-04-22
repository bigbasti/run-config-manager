import { RunFileSchema, parseRunFile } from '../src/shared/schema';

describe('RunFileSchema', () => {
  const minimalConfig = {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'My App',
    type: 'npm',
    projectPath: 'frontend',
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: { scriptName: 'start', packageManager: 'npm' },
  };

  test('accepts a valid v1 file', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [minimalConfig],
    });
    expect(result.success).toBe(true);
  });

  test('accepts optional port field', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{ ...minimalConfig, port: 4200 }],
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing required field (name)', () => {
    const { name, ...rest } = minimalConfig;
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [rest],
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown type', () => {
    const result = RunFileSchema.safeParse({
      version: 1,
      configurations: [{ ...minimalConfig, type: 'cobol' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects version != 1', () => {
    const result = RunFileSchema.safeParse({
      version: 2,
      configurations: [minimalConfig],
    });
    expect(result.success).toBe(false);
  });

  test('parseRunFile returns a typed error on invalid JSON', () => {
    const outcome = parseRunFile('not json {');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/JSON/i);
  });

  test('parseRunFile returns a typed error with the Zod path on schema mismatch', () => {
    const outcome = parseRunFile(JSON.stringify({ version: 1, configurations: [{}] }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/configurations/);
  });

  test('parseRunFile succeeds on empty configurations array', () => {
    const outcome = parseRunFile(JSON.stringify({ version: 1, configurations: [] }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.configurations).toEqual([]);
  });
});
