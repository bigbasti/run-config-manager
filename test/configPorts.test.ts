import { Uri } from 'vscode';
import { resolveExpectedPorts } from '../src/services/configPorts';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: Uri.file('/ws/a'), name: 'a', index: 0 } as any;

const npmCfg = (port?: number): RunConfig => ({
  id: 'n', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
  env: {}, programArgs: '', vmArgs: '', port,
  typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
});

const customCfg: RunConfig = {
  id: 'c', name: 'script', type: 'custom-command', projectPath: '', workspaceFolder: '',
  env: {}, programArgs: '', vmArgs: '',
  typeOptions: { command: 'echo hi', cwd: '', shell: 'default', interactive: false },
};

describe('resolveExpectedPorts', () => {
  test('includes an explicit cfg.port', async () => {
    const ports = await resolveExpectedPorts(npmCfg(4000), folder);
    expect(ports).toContain(4000);
  });

  test('returns [] for a config with no declarable / detectable port', async () => {
    const ports = await resolveExpectedPorts(customCfg, folder);
    expect(ports).toEqual([]);
  });

  test('de-duplicates and filters non-positive ports', async () => {
    const ports = await resolveExpectedPorts(npmCfg(0), folder);
    // port 0 is filtered out; no project files seeded → nothing detected.
    expect(ports).toEqual([]);
  });
});
