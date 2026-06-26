import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import type { RunConfig } from '../src/shared/types';

const folder = { uri: { fsPath: '/ws' } as any, name: 'ws', index: 0 } as any;
function npm(): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName: 'dev', packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('NpmAdapter.prepareLaunch monitoring', () => {
  const a = new NpmAdapter();

  test('no monitor env when ctx.monitor is false', async () => {
    const r = await a.prepareLaunch(npm(), folder, { debug: false });
    expect(r.env?.NODE_OPTIONS).toBeUndefined();
    expect(r.env?.RCM_MONITOR_ID).toBeUndefined();
  });

  test('injects agent env when monitor + nodeAgentPath present', async () => {
    const r = await a.prepareLaunch(npm(), folder,
      { debug: false, monitor: true, monitorPort: 5555, nodeAgentPath: '/x/agent.cjs' });
    expect(r.env?.NODE_OPTIONS).toContain('--require "/x/agent.cjs"');
    expect(r.env?.RCM_MONITOR_PORT).toBe('5555');
    expect(r.env?.RCM_MONITOR_ID).toBe('cfg1');
    expect(r.env?.FORCE_COLOR).toBe('1'); // existing behavior preserved
  });
});
