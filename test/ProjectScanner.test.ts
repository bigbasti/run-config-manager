import { Uri, __resetFs, __writeFs } from 'vscode';
import { ProjectScanner } from '../src/services/ProjectScanner';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';

describe('ProjectScanner', () => {
  beforeEach(() => __resetFs());

  test('returns null when no adapter detects anything', async () => {
    const reg = new AdapterRegistry();
    reg.register(new NpmAdapter());
    const s = new ProjectScanner(reg);
    const r = await s.scan(Uri.file('/empty'), 'npm');
    expect(r).toBeNull();
  });

  test('delegates to the adapter for the chosen type', async () => {
    __writeFs('/proj/package.json', JSON.stringify({ scripts: { start: 's' } }));
    const reg = new AdapterRegistry();
    reg.register(new NpmAdapter());
    const s = new ProjectScanner(reg);
    const r = await s.scan(Uri.file('/proj'), 'npm');
    expect(r).not.toBeNull();
    expect(r!.defaults.type).toBe('npm');
  });

  test('throws on unknown type', async () => {
    const s = new ProjectScanner(new AdapterRegistry());
    await expect(s.scan(Uri.file('/x'), 'npm')).rejects.toThrow(/no adapter/i);
  });
});
