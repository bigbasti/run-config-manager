import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new NpmAdapter();

function cfg(overrides: Partial<RunConfig> = {}): RunConfig {
  const base = {
    id: 'a'.repeat(8) + '-1111-2222-3333-444444444444',
    name: 'x',
    type: 'npm' as const,
    projectPath: 'frontend',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: { scriptName: 'start', packageManager: 'npm' as const },
  };
  return { ...base, ...overrides } as RunConfig;
}

describe('NpmAdapter.buildCommand', () => {
  test('builds `npm run start` with no args', () => {
    const r = adapter.buildCommand(cfg());
    expect(r.command).toBe('npm');
    expect(r.args).toEqual(['run', 'start']);
  });

  test('passes programArgs after --', () => {
    const r = adapter.buildCommand(cfg({ programArgs: '--port 5000 --ssl' }));
    expect(r.args).toEqual(['run', 'start', '--', '--port', '5000', '--ssl']);
  });

  test('uses yarn executable when packageManager is yarn', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { scriptName: 'dev', packageManager: 'yarn' },
    }));
    expect(r.command).toBe('yarn');
    expect(r.args).toEqual(['run', 'dev']);
  });

  test('uses pnpm executable when packageManager is pnpm', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { scriptName: 'dev', packageManager: 'pnpm' },
    }));
    expect(r.command).toBe('pnpm');
    expect(r.args).toEqual(['run', 'dev']);
  });

  test('quoted program args with spaces are preserved', () => {
    const r = adapter.buildCommand(cfg({ programArgs: '--title "Hello World" --x 1' }));
    expect(r.args).toEqual(['run', 'start', '--', '--title', 'Hello World', '--x', '1']);
  });
});

describe('NpmAdapter.getFormSchema', () => {
  test('type-specific fields include script select, package-manager select, port', () => {
    const schema = adapter.getFormSchema({ scripts: ['start', 'dev'] });
    const keys = schema.typeSpecific.map(f => f.key);
    expect(keys).toEqual(expect.arrayContaining(['typeOptions.scriptName', 'typeOptions.packageManager', 'port']));
    const scriptField = schema.typeSpecific.find(f => f.key === 'typeOptions.scriptName');
    expect(scriptField?.kind).toBe('select');
    if (scriptField?.kind === 'select') {
      expect(scriptField.options.map(o => o.value)).toEqual(['start', 'dev']);
    }
  });

  test('script field renders as text input when no scripts detected', () => {
    const schema = adapter.getFormSchema({ scripts: [] });
    const scriptField = schema.typeSpecific.find(f => f.key === 'typeOptions.scriptName');
    expect(scriptField?.kind).toBe('text');
    if (scriptField?.kind === 'text') {
      expect(scriptField.required).toBe(true);
      expect(scriptField.placeholder).toBe('start');
    }
  });

  test('common fields always include name and projectPath', () => {
    const schema = adapter.getFormSchema({ scripts: [] });
    expect(schema.common.map(f => f.key)).toEqual(['name', 'projectPath']);
  });

  test('advanced fields include env, programArgs, vmArgs, dependsOn', () => {
    const schema = adapter.getFormSchema({ scripts: [] });
    expect(schema.advanced.map(f => f.key)).toEqual(['env', 'programArgs', 'vmArgs', 'dependsOn']);
  });
});

describe('NpmAdapter.getDebugConfig', () => {
  const folder = { uri: { fsPath: '/ws/app' } as any, name: 'app', index: 0 };

  test('produces pwa-node launch config with runtimeExecutable matching package manager', () => {
    const r = adapter.getDebugConfig(cfg({ typeOptions: { scriptName: 'dev', packageManager: 'pnpm' } }), folder as any);
    expect(r.type).toBe('pwa-node');
    expect(r.request).toBe('launch');
    expect(r.runtimeExecutable).toBe('pnpm');
    expect(r.runtimeArgs).toEqual(['run', 'dev']);
    expect(r.cwd).toBe('/ws/app/frontend');
    expect(r.console).toBe('integratedTerminal');
  });

  test('passes env and skipFiles defaults', () => {
    const r = adapter.getDebugConfig(cfg({ env: { FOO: 'bar' } }), folder as any);
    expect(r.env).toEqual({ FOO: 'bar' });
    expect(r.skipFiles).toEqual(['<node_internals>/**']);
  });
});
