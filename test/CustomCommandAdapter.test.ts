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
  // Tests assume a Unix host (jest runs in node; our CI is Linux). When the
  // chosen shell matches the outer shell (bash on Unix, cmd on Windows), we
  // pass the command verbatim with no wrapping — RunTerminal's /bin/bash -c
  // around the final cmdLine is already the one layer of shell we need.

  test('bash (matches outer shell on Unix): no inner wrap', () => {
    // The pipe-bug fix: wrapping a pipe command in `bash -c <cmd>` caused
    // the OUTER shell to pipe-split before the inner bash saw anything.
    // Passing the command verbatim lets the outer shell handle pipes right.
    const r = adapter.buildCommand(cfg({ typeOptions: { shell: 'bash', command: 'ls -la | grep java' } }));
    expect(r.command).toBe('ls -la | grep java');
    expect(r.args).toEqual([]);
  });

  test('default (= bash on Unix): no inner wrap', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { shell: 'default', command: 'echo hi && ls' } }));
    expect(r.command).toBe('echo hi && ls');
    expect(r.args).toEqual([]);
  });

  test('sh wraps with bashQuote so outer bash delivers command as one arg', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'sh', command: 'ls -la | grep foo' },
    }));
    expect(r.command).toBe('sh');
    expect(r.args).toEqual(['-c', `'ls -la | grep foo'`]);
  });

  test('zsh wraps + quotes too', () => {
    const r = adapter.buildCommand(cfg({ typeOptions: { shell: 'zsh', command: 'echo hi' } }));
    expect(r.command).toBe('zsh');
    expect(r.args).toEqual(['-c', `'echo hi'`]);
  });

  test('pwsh uses -Command + single-quoted string (outer bash unwraps)', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'pwsh', command: 'Get-ChildItem | Select-Object -First 5' },
    }));
    expect(r.command).toBe('pwsh');
    expect(r.args).toEqual(['-Command', `'Get-ChildItem | Select-Object -First 5'`]);
  });

  test('cmd shell on Unix: wrapped + quoted (outer bash passes through)', () => {
    // Running 'cmd' shell from a Unix host is unusual but not forbidden —
    // the assertion documents the quoting shape.
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'cmd', command: 'dir & echo done' },
    }));
    expect(r.command).toBe('cmd.exe');
    expect(r.args).toEqual(['/c', `'dir & echo done'`]);
  });

  test('bash preserves the command verbatim (shell handles quoting/escaping/globs)', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'bash', command: `echo "hello world" && find . -name '*.ts'` },
    }));
    // No inner wrap for bash on Unix — command is the whole string.
    expect(r.command).toBe(`echo "hello world" && find . -name '*.ts'`);
    expect(r.args).toEqual([]);
  });

  test('sh-wrapped single-quote escaping: inner quotes don\'t break the wrapper', () => {
    const r = adapter.buildCommand(cfg({
      typeOptions: { shell: 'sh', command: `echo 'hi'` },
    }));
    // bashQuote escapes inner ' as '\''.
    expect(r.args[1]).toBe(`'echo '\\''hi'\\'''`);
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
