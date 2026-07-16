import { McpBridgeServer } from '../src/services/McpBridgeServer';
import { LoopbackClient } from '../src/mcp/loopbackClient';
import type { BridgeServices } from '../src/mcp/bridgeServices';

function fakeServices(): BridgeServices {
  return {
    listConfigs: () => [{ id: 'a', name: 'A', type: 'npm', folderKey: '/w', valid: true }],
    getConfig: (id) => (id === 'a' ? ({ id: 'a' } as any) : undefined),
    currentConfigs: () => [{ folderKey: '/w', configurations: [] }],
    validateConfig: () => ({ ok: true }),
    createConfig: async () => ({ id: 'new' }),
    updateConfig: async () => undefined,
    deleteConfig: async () => undefined,
    runConfig: async (_id, monitor) => ({ monitoring: monitor ? 'requested' : undefined }),
    debugConfig: async () => ({}),
    stopConfig: async () => undefined,
    runStatus: () => ({
      running: true, started: true, failed: false, preparing: false,
      monitored: true, runtime: 'node',
    }),
    monitoringSnapshot: (_id, sections) => ({
      runtime: 'node', status: 'live', latest: { rss: 1 },
      ...(sections?.includes('metrics') ? { metrics: [{ rss: 1 }] } : {}),
    }),
    threadDump: async (_id, tid) => ({
      type: 'threadDump', t: 1, tid, name: 'main', state: 'RUNNABLE', stack: [],
    }) as any,
  };
}

describe('McpBridgeServer + LoopbackClient', () => {
  let server: McpBridgeServer;
  let port: number;

  beforeEach(async () => {
    server = new McpBridgeServer('secret', fakeServices());
    port = await server.listenPort();
  });
  afterEach(() => server.dispose());

  it('round-trips a list call with the correct token', async () => {
    const client = new LoopbackClient(port, 'secret');
    const result = await client.call('list');
    expect(result).toEqual([{ id: 'a', name: 'A', type: 'npm', folderKey: '/w', valid: true }]);
    client.dispose();
  });

  it('rejects a call with a wrong token', async () => {
    const client = new LoopbackClient(port, 'WRONG');
    await expect(client.call('list')).rejects.toThrow(/unauthorized/);
    client.dispose();
  });

  it('returns an error for an unknown method', async () => {
    const client = new LoopbackClient(port, 'secret');
    await expect(client.call('bogus' as any)).rejects.toThrow(/unknown method/);
    client.dispose();
  });

  it('propagates a params-carrying create call', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('create', { config: { type: 'npm' } });
    expect(res).toEqual({ id: 'new' });
    client.dispose();
  });

  it('round-trips runStatus', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('runStatus', { id: 'a' });
    expect(res).toMatchObject({ running: true, runtime: 'node', monitored: true });
    client.dispose();
  });

  it('round-trips monitoringSnapshot with sections', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('monitoringSnapshot', { id: 'a', sections: ['metrics'] });
    expect(res).toMatchObject({ runtime: 'node', status: 'live' });
    expect((res as any).metrics).toEqual([{ rss: 1 }]);
    client.dispose();
  });

  it('round-trips threadDump', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('threadDump', { id: 'a', tid: 7 });
    expect(res).toMatchObject({ type: 'threadDump', tid: 7 });
    client.dispose();
  });

  it('forwards the monitor flag on run', async () => {
    const client = new LoopbackClient(port, 'secret');
    const res = await client.call('run', { id: 'a', monitor: true });
    expect(res).toEqual({ monitoring: 'requested' });
    client.dispose();
  });
});
