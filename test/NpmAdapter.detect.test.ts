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
