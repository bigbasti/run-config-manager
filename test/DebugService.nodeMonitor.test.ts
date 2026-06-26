import * as vscode from 'vscode';
import { DebugService } from '../src/services/DebugService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any;
function npm(): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('DebugService Debug-with-Monitoring (npm)', () => {
  test('injects agent env into the debug config and registers expect', async () => {
    const registry = new AdapterRegistry();
    registry.register(new NpmAdapter());
    const node = {
      listenPort: jest.fn().mockResolvedValue(7001),
      agentPath: '/x/agent.cjs',
      expect: jest.fn(),
      detach: jest.fn(),
    } as any;
    const startSpy = jest.spyOn(vscode.debug, 'startDebugging').mockResolvedValue(true as any);

    // nodeMonitoring is the LAST ctor param.
    const dbg = new DebugService(registry, undefined, node);
    await dbg.debug(npm(), folder, { monitor: true });

    expect(node.listenPort).toHaveBeenCalled();
    expect(node.expect).toHaveBeenCalledWith('cfg1');
    const conf = startSpy.mock.calls[0][1] as any;
    expect(conf.env.NODE_OPTIONS).toContain('--require "/x/agent.cjs"');
    expect(conf.env.RCM_MONITOR_PORT).toBe('7001');
    expect(conf.env.RCM_MONITOR_ID).toBe('cfg1');
    startSpy.mockRestore();
  });
});
