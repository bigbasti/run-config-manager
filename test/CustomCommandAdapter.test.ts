import { Uri } from 'vscode';
import { CustomCommandAdapter } from '../src/adapters/custom-command/CustomCommandAdapter';
import type { RunConfig } from '../src/shared/types';

const adapter = new CustomCommandAdapter();
const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;

function cfg(overrides: any = {}): RunConfig {
  const base = {
    id: 'gggggggg-1111-2222-3333-444444444444',
    name: 'x',
    type: 'custom-command' as const,
    projectPath: '',
    workspaceFolder: '',
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
    typeOptions: {
      command: 'echo hello',
      cwd: '',
      shell: 'bash' as const,
      interactive: false,
    },
  };
  return {
    ...base,
    ...overrides,
    typeOptions: { ...base.typeOptions, ...(overrides.typeOptions ?? {}) },
  } as RunConfig;
}

describe('CustomCommandAdapter.detect', () => {
  test('matches any folder (shell commands don\'t need project detection)', async () => {
    const r = await adapter.detect(Uri.file('/anywhere'));
    expect(r).not.toBeNull();
    expect(r!.defaults.type).toBe('custom-command');
  });

  test('supportsDebug is false', () => {
    expect(adapter.supportsDebug).toBe(false);
  });
});

describe('CustomCommandAdapter.buildCommand', () => {
  test('bash: wraps the whole command string with -c', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { shell: 'bash', command: 'echo hi && ls' } }));
    expect(r.command).toBe('bash');
    expect(r.args).toEqual(['-c', 'echo hi && ls']);
  });

  test('sh / zsh produce -c too', () => {
    expect(adapter.buildCommand(cfg({ typeOptions: { shell: 'sh' } })).command).toBe('sh');
    expect(adapter.buildCommand(cfg({ typeOptions: { shell: 'zsh' } })).command).toBe('zsh');
  });

  test('pwsh uses -Command (not -c) so PowerShell parses correctly', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'pwsh', command: 'Get-ChildItem | Select-Object -First 5' },
    }));
    expect(r.command).toBe('pwsh');
    expect(r.args).toEqual(['-Command', 'Get-ChildItem | Select-Object -First 5']);
  });

  test('cmd uses /c', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'cmd', command: 'dir & echo done' },
    }));
    expect(r.command).toBe('cmd.exe');
    expect(r.args).toEqual(['/c', 'dir & echo done']);
  });

  test('preserves the command string verbatim (no tokenisation)', () => {
    // The whole point of a shell-interpreted config: the shell handles
    // quoting/escaping/globbing, we just hand it the raw string.
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'bash', command: `echo "hello world" && find . -name '*.ts'` },
    }));
    expect(r.args[1]).toBe(`echo "hello world" && find . -name '*.ts'`);
  });
});

describe('CustomCommandAdapter.prepareLaunch', () => {
  test('colorOutput sets FORCE_COLOR + CLICOLOR_FORCE', async () => {
    const p = await adapter.prepareLaunch(cfg({ typeOptions: { colorOutput: true } }), folder, { debug: false });
    expect(p.env?.FORCE_COLOR).toBe('1');
    expect(p.env?.CLICOLOR_FORCE).toBe('1');
  });

  test('colorOutput omitted → env has no FORCE_COLOR', async () => {
    const p = await adapter.prepareLaunch(cfg(), folder, { debug: false });
    expect(p.env?.FORCE_COLOR).toBeUndefined();
  });

  test('cwd override resolves against the workspace folder when relative', async () => {
    const p = await adapter.prepareLaunch(
      cfg({ typeOptions: { cwd: 'tools/scripts' } }),
      folder,
      { debug: false },
    );
    expect(p.cwd).toBe('/ws/tools/scripts');
  });

  test('absolute cwd passes through unchanged', async () => {
    const p = await adapter.prepareLaunch(
      cfg({ typeOptions: { cwd: '/opt/custom' } }),
      folder,
      { debug: false },
    );
    expect(p.cwd).toBe('/opt/custom');
  });

  test('blank cwd leaves prepared.cwd undefined (ExecutionService falls back to projectPath)', async () => {
    const p = await adapter.prepareLaunch(cfg(), folder, { debug: false });
    expect(p.cwd).toBeUndefined();
  });
});
