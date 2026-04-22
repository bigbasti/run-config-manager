import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';

describe('AdapterRegistry', () => {
  test('returns registered adapter by type', () => {
    const r = new AdapterRegistry();
    const npm = new NpmAdapter();
    r.register(npm);
    expect(r.get('npm')).toBe(npm);
  });

  test('returns undefined for unknown type', () => {
    const r = new AdapterRegistry();
    expect(r.get('npm')).toBeUndefined();
  });

  test('all() returns every registered adapter in registration order', () => {
    const r = new AdapterRegistry();
    const npm = new NpmAdapter();
    r.register(npm);
    expect(r.all()).toEqual([npm]);
  });

  test('register overwrites existing adapter of the same type', () => {
    const r = new AdapterRegistry();
    const a = new NpmAdapter();
    const b = new NpmAdapter();
    r.register(a);
    r.register(b);
    expect(r.get('npm')).toBe(b);
    expect(r.all()).toHaveLength(1);
  });
});
