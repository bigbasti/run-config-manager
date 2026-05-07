import {
  runMigrations,
  compareSemver,
  MIGRATIONS,
  type MigrationEntry,
} from '../src/services/migrations';
import type { RunFile } from '../src/shared/types';

const baseFile = (version: string, extra: Partial<RunFile> = {}): RunFile => ({
  version,
  configurations: [],
  groups: [],
  ...extra,
});

describe('compareSemver', () => {
  test('orders major / minor / patch correctly', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.3.0')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  test('pads missing fields with zeros', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });

  test('strips prerelease tail', () => {
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBe(0);
  });
});

describe('runMigrations', () => {
  // Save and restore the registry so tests don't leak entries.
  let saved: MigrationEntry[];
  beforeEach(() => { saved = [...MIGRATIONS]; });
  afterEach(() => { MIGRATIONS.length = 0; MIGRATIONS.push(...saved); });

  test('idle when extension version matches on-disk version', () => {
    const file = baseFile('0.6.2');
    const r = runMigrations(file, '0.6.2');
    expect(r.contentChanged).toBe(false);
    expect(r.finalVersion).toBe('0.6.2');
    expect(r.file).toEqual(file);
  });

  test('newer-than-extension files are left alone with a warn', () => {
    const file = baseFile('99.0.0', { configurations: [{ id: 'x' }] as any });
    const r = runMigrations(file, '0.6.2');
    expect(r.contentChanged).toBe(false);
    expect(r.finalVersion).toBe('99.0.0');
    expect(r.file).toEqual(file);
  });

  test('applies a registered migration when extension is at-or-newer than its target', () => {
    MIGRATIONS.length = 0;
    MIGRATIONS.push({
      from: '0.6.0',
      to: '0.7.0',
      migrate: f => ({ ...f, configurations: [...f.configurations, { id: 'added-by-migration' } as any] }),
    });
    const r = runMigrations(baseFile('0.6.0'), '0.7.0');
    expect(r.contentChanged).toBe(true);
    expect(r.finalVersion).toBe('0.7.0');
    expect(r.file.configurations).toHaveLength(1);
    expect((r.file.configurations[0] as any).id).toBe('added-by-migration');
  });

  test('skips migrations whose target the extension hasn\'t reached yet', () => {
    MIGRATIONS.length = 0;
    MIGRATIONS.push({
      from: '0.6.0',
      to: '99.0.0',
      migrate: () => { throw new Error('should not have been called'); },
    });
    const r = runMigrations(baseFile('0.6.0'), '0.6.2');
    expect(r.contentChanged).toBe(false);
    // Stamps the extension version even when no migrations applied.
    expect(r.finalVersion).toBe('0.6.2');
  });

  test('chains migrations oldest → newest', () => {
    MIGRATIONS.length = 0;
    MIGRATIONS.push(
      { from: '0.5.0', to: '0.6.0', migrate: f => ({ ...f, configurations: [...f.configurations, { step: 1 } as any] }) },
      { from: '0.6.0', to: '0.7.0', migrate: f => ({ ...f, configurations: [...f.configurations, { step: 2 } as any] }) },
    );
    const r = runMigrations(baseFile('0.5.0'), '0.7.0');
    expect(r.file.configurations.map((c: any) => c.step)).toEqual([1, 2]);
    expect(r.finalVersion).toBe('0.7.0');
  });

  test('skips already-applied hops', () => {
    MIGRATIONS.length = 0;
    MIGRATIONS.push(
      { from: '0.5.0', to: '0.6.0', migrate: () => { throw new Error('already past this'); } },
      { from: '0.6.0', to: '0.7.0', migrate: f => ({ ...f, configurations: [...f.configurations, { step: 2 } as any] }) },
    );
    const r = runMigrations(baseFile('0.6.0'), '0.7.0');
    expect((r.file.configurations[0] as any).step).toBe(2);
  });

  test('contentChanged is false when migration is a no-op', () => {
    MIGRATIONS.length = 0;
    MIGRATIONS.push({ from: '0.6.0', to: '0.7.0', migrate: f => f });
    const r = runMigrations(baseFile('0.6.0'), '0.7.0');
    expect(r.contentChanged).toBe(false);
    expect(r.finalVersion).toBe('0.7.0');
  });

  test('always stamps the running extension version on the file', () => {
    const r = runMigrations(baseFile('0.6.0'), '0.7.0');
    expect(r.file.version).toBe('0.7.0');
  });

  test('the closeTerminalOnExit migration adds the field with true to existing configs', () => {
    // Use the real registry — exercises the actual migration we ship.
    const file = baseFile('0.0.0', {
      configurations: [
        { id: 'a', name: 'A', type: 'npm' } as any,
        { id: 'b', name: 'B', type: 'npm', closeTerminalOnExit: false } as any,
      ],
    });
    const r = runMigrations(file, '0.6.3');
    expect(r.contentChanged).toBe(true);
    // First config gets the default (true).
    expect((r.file.configurations[0] as any).closeTerminalOnExit).toBe(true);
    // Second config keeps its explicit value.
    expect((r.file.configurations[1] as any).closeTerminalOnExit).toBe(false);
  });
});
