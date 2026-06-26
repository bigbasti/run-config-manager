import { ExecutionService } from '../src/services/ExecutionService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any;
function npm(): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('ExecutionService Node monitoring routing', () => {
  test('npm + monitor uses nodeMonitoring (expect + listenPort), not JVM attach', async () => {
    const registry = new AdapterRegistry();
    registry.register(new NpmAdapter());

    const jvm = { attach: jest.fn(), detach: jest.fn() } as any;
    const node = {
      listenPort: jest.fn().mockResolvedValue(6123),
      agentPath: '/x/agent.cjs',
      expect: jest.fn(),
      detach: jest.fn(),
    } as any;

    // nodeMonitoring is the LAST ctor param.
    const exec = new ExecutionService(registry, jvm, undefined, undefined, node);
    await exec.run(npm(), folder, { monitor: true });

    expect(node.listenPort).toHaveBeenCalled();
    expect(node.expect).toHaveBeenCalledWith('cfg1');
    expect(jvm.attach).not.toHaveBeenCalled();
  });
});
