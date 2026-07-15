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
    runConfig: async () => undefined,
    debugConfig: async () => undefined,
    stopConfig: async () => undefined,
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
});
