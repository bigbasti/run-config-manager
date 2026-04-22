import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';

describe('NpmAdapter.getFormSchema — help text', () => {
  const adapter = new NpmAdapter();

  test('every field has a non-empty help string (with scripts detected)', () => {
    const schema = adapter.getFormSchema({ scripts: ['start', 'dev'] });
    const allFields = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
    for (const f of allFields) {
      expect(typeof f.help).toBe('string');
      expect(f.help!.length).toBeGreaterThan(0);
    }
  });

  test('every field has a non-empty help string (without scripts detected)', () => {
    const schema = adapter.getFormSchema({ scripts: [] });
    const allFields = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
    for (const f of allFields) {
      expect(typeof f.help).toBe('string');
      expect(f.help!.length).toBeGreaterThan(0);
    }
  });

  test('examples are arrays of strings where present', () => {
    const schema = adapter.getFormSchema({ scripts: ['start'] });
    const allFields = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
    for (const f of allFields) {
      if (f.examples !== undefined) {
        expect(Array.isArray(f.examples)).toBe(true);
        for (const e of f.examples) expect(typeof e).toBe('string');
      }
    }
  });

  test('specific fields have the expected help text', () => {
    const schema = adapter.getFormSchema({ scripts: ['start'] });
    const byKey = Object.fromEntries(
      [...schema.common, ...schema.typeSpecific, ...schema.advanced].map(f => [f.key, f]),
    );
    expect(byKey['name'].help).toMatch(/display/i);
    expect(byKey['projectPath'].help).toMatch(/workspace/i);
    expect(byKey['typeOptions.scriptName'].help).toMatch(/script/i);
    expect(byKey['env'].help).toMatch(/environment/i);
  });
});
