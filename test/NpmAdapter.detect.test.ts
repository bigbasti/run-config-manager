import { Uri, __resetFs, __writeFs } from 'vscode';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';

describe('NpmAdapter.detect', () => {
  const adapter = new NpmAdapter();

  beforeEach(() => __resetFs());

  test('returns null when package.json is missing', async () => {
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).toBeNull();
  });

  test('returns null on malformed package.json', async () => {
    __writeFs('/proj/package.json', 'not json {');
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).toBeNull();
  });

  test('extracts scripts and prefers "start"', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { build: 'tsc', start: 'node server.js', dev: 'node --inspect server.js' },
    }));
    const result = await adapter.detect(Uri.file('/proj'));
    expect(result).not.toBeNull();
    expect(result!.defaults.type).toBe('npm');
    expect((result!.defaults.typeOptions as any).scriptName).toBe('start');
    expect((result!.context as any).scripts).toEqual(['build', 'start', 'dev']);
  });

  test('prefers "dev" when "start" is absent', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { build: 'tsc', dev: 'ng serve' },
    }));
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.defaults.typeOptions as any).scriptName).toBe('dev');
  });

  test('falls back to first script when no "start"/"dev"', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { build: 'tsc', lint: 'eslint .' },
    }));
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.defaults.typeOptions as any).scriptName).toBe('build');
  });

  test('detects yarn when yarn.lock is present', async () => {
    __writeFs('/proj/package.json', JSON.stringify({ scripts: { start: 'x' } }));
    __writeFs('/proj/yarn.lock', '');
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.defaults.typeOptions as any).packageManager).toBe('yarn');
  });

  test('detects pnpm when pnpm-lock.yaml is present', async () => {
    __writeFs('/proj/package.json', JSON.stringify({ scripts: { start: 'x' } }));
    __writeFs('/proj/pnpm-lock.yaml', '');
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.defaults.typeOptions as any).packageManager).toBe('pnpm');
  });

  test('defaults to npm when no lockfile is present', async () => {
    __writeFs('/proj/package.json', JSON.stringify({ scripts: { start: 'x' } }));
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.defaults.typeOptions as any).packageManager).toBe('npm');
  });

  test('returns empty scripts list when scripts object absent', async () => {
    __writeFs('/proj/package.json', JSON.stringify({ name: 'x' }));
    const result = await adapter.detect(Uri.file('/proj'));
    expect((result!.context as any).scripts).toEqual([]);
    expect((result!.defaults.typeOptions as any).scriptName).toBe('');
  });
});

describe('NpmAdapter form schema — Node field', () => {
  test('includes typeOptions.nodePath as the second typeSpecific field, with options from context.nodes', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({
      scripts: ['start', 'build'],
      nodes: [
        { path: '/opt/node-20', version: '20.10.0' },
        { path: '/opt/node-18' },
      ],
    });
    const node = schema.typeSpecific.find(f => f.key === 'typeOptions.nodePath');
    expect(node).toBeDefined();
    expect(node!.kind).toBe('selectOrCustom');
    // First typeSpecific field after Script.
    expect(schema.typeSpecific[0].key).toBe('typeOptions.scriptName');
    expect(schema.typeSpecific[1].key).toBe('typeOptions.nodePath');
    // Options reflect both detected paths.
    const opts = (node as any).options as Array<{ value: string; label: string }>;
    expect(opts.map(o => o.value)).toEqual(['/opt/node-20', '/opt/node-18']);
    expect(opts[0].label).toBe('/opt/node-20 — v20.10.0');
    expect(opts[1].label).toBe('/opt/node-18');
  });

  test('renders an empty options list when no nodes detected', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({ scripts: ['start'] });
    const node = schema.typeSpecific.find(f => f.key === 'typeOptions.nodePath');
    expect(node).toBeDefined();
    expect((node as any).options).toEqual([]);
  });
});

describe('NpmAdapter form schema — Detected framework badge', () => {
  test('badge appears when context.npmFramework.name is set', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({
      scripts: ['dev', 'build'],
      npmFramework: {
        name: 'nextjs',
        source: 'next.config.ts',
        defaultScript: 'dev',
        defaultPort: 3000,
      },
    });
    const badge = schema.typeSpecific.find(f => f.key === 'npmFrameworkBadge');
    expect(badge).toBeDefined();
    expect(badge!.kind).toBe('info');
    expect((badge as any).content.banner.text).toContain('Next.js');
    expect((badge as any).content.banner.text).toContain('next.config.ts');
  });

  test('no badge when npmFramework is null or absent', () => {
    const adapter = new NpmAdapter();
    const schema = adapter.getFormSchema({
      scripts: ['build'],
      npmFramework: { name: null, source: '', defaultScript: 'build', defaultPort: null },
    });
    expect(schema.typeSpecific.find(f => f.key === 'npmFrameworkBadge')).toBeUndefined();
    const noContext = adapter.getFormSchema({});
    expect(noContext.typeSpecific.find(f => f.key === 'npmFrameworkBadge')).toBeUndefined();
  });
});
