import { PythonAdapter } from '../src/adapters/python/PythonAdapter';

describe('PythonAdapter.getFormSchema', () => {
  const adapter = new PythonAdapter();

  test('typeSpecific includes python runtime, launchMode, mode-specific fields', () => {
    const schema = adapter.getFormSchema({
      pythons: [{ path: '/opt/py-3.12', version: '3.12.1' }],
      entryPoints: { scripts: [{ relativePath: 'app.py' }], modules: [{ dotted: 'pkg.cli' }] },
      frameworks: [{ name: 'django', source: 'pyproject.toml' }],
    });
    const keys = schema.typeSpecific.map(f => f.key);
    expect(keys).toContain('typeOptions.pythonPath');
    expect(keys).toContain('typeOptions.launchMode');
    expect(keys).toContain('typeOptions.scriptPath');
    expect(keys).toContain('typeOptions.moduleName');
    expect(keys).toContain('typeOptions.framework');
    expect(keys).toContain('typeOptions.frameworkCommand');
    expect(keys).toContain('typeOptions.pytestArgs');
    expect(keys).toContain('typeOptions.customArgs');
    expect(keys).toContain('port');
  });

  test('framework field options come from detected frameworks', () => {
    const schema = adapter.getFormSchema({
      pythons: [], entryPoints: { scripts: [], modules: [] },
      frameworks: [{ name: 'django', source: '...' }, { name: 'celery', source: '...' }],
    });
    const fwField = schema.typeSpecific.find(f => f.key === 'typeOptions.framework');
    const opts = (fwField as any).options as Array<{ value: string }>;
    expect(opts.map(o => o.value)).toContain('django');
    expect(opts.map(o => o.value)).toContain('celery');
  });

  test('script field options come from detected entry points', () => {
    const schema = adapter.getFormSchema({
      pythons: [], entryPoints: { scripts: [{ relativePath: 'main.py' }, { relativePath: 'src/cli.py' }], modules: [] },
      frameworks: [],
    });
    const f = schema.typeSpecific.find(field => field.key === 'typeOptions.scriptPath');
    const opts = (f as any).options as Array<{ value: string }>;
    expect(opts.map(o => o.value)).toEqual(['main.py', 'src/cli.py']);
  });

  test('module field options come from detected modules', () => {
    const schema = adapter.getFormSchema({
      pythons: [], entryPoints: { scripts: [], modules: [{ dotted: 'pkg.cli' }, { dotted: 'pkg.web' }] },
      frameworks: [],
    });
    const f = schema.typeSpecific.find(field => field.key === 'typeOptions.moduleName');
    const opts = (f as any).options as Array<{ value: string }>;
    expect(opts.map(o => o.value)).toEqual(['pkg.cli', 'pkg.web']);
  });
});

describe('PythonAdapter.detect', () => {
  test('returns default RunConfig shape with launchMode=script', async () => {
    // Detect runs the lightweight (sync) detection path. The streaming
    // detector populates pythons/entryPoints/frameworks asynchronously.
    const adapter = new PythonAdapter();
    const result = await adapter.detect(require('vscode').Uri.file('/tmp/nonexistent'));
    if (result === null) return;
    expect(result.defaults.type).toBe('python');
    expect((result.defaults.typeOptions as any).launchMode).toBe('script');
  });
});
