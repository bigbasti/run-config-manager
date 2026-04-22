import { buildRecoveredConfig } from '../src/recovery/buildRecoveredConfig';
import type { InvalidConfigEntry } from '../src/shared/types';

const entry = (rawText: string): InvalidConfigEntry => ({
  id: 'abc', name: 'x', rawText, error: 'ignored',
});

describe('buildRecoveredConfig', () => {
  test('recovers all present fields', () => {
    const raw = JSON.stringify({
      id: 'abc',
      name: 'MyApp',
      type: 'npm',
      projectPath: 'web',
      workspaceFolder: 'root',
      env: { FOO: 'bar' },
      programArgs: '--port 4200',
      vmArgs: '',
      typeOptions: { scriptName: 'dev', packageManager: 'yarn' },
    });
    const out = buildRecoveredConfig(entry(raw));
    expect(out.id).toBe('abc');
    expect(out.name).toBe('MyApp');
    expect(out.projectPath).toBe('web');
    expect((out.typeOptions as { scriptName?: string } | undefined)?.scriptName).toBe('dev');
    expect(out.env).toEqual({ FOO: 'bar' });
  });

  test('missing typeOptions yields undefined (does not throw)', () => {
    const raw = JSON.stringify({ id: 'abc', name: 'x' });
    const out = buildRecoveredConfig(entry(raw));
    expect(out.id).toBe('abc');
    expect(out.name).toBe('x');
    expect(out.typeOptions).toBeUndefined();
  });

  test('malformed JSON yields only id + name from the entry', () => {
    const out = buildRecoveredConfig({
      id: 'abc', name: 'fallback', rawText: 'not json {', error: '',
    });
    expect(out.id).toBe('abc');
    expect(out.name).toBe('fallback');
    expect(out.projectPath).toBeUndefined();
  });

  test('non-object JSON yields only id + name', () => {
    const out = buildRecoveredConfig({
      id: 'abc', name: 'x', rawText: '42', error: '',
    });
    expect(Object.keys(out)).toEqual(['id', 'name']);
  });
});
