import * as vscode from 'vscode';
import { registerMcpProvider } from '../src/mcp/registerMcpProvider';

describe('registerMcpProvider', () => {
  it('registers a provider that yields one stdio definition with port/token env', async () => {
    const captured: { id?: string; provider?: any } = {};
    (vscode.lm.registerMcpServerDefinitionProvider as jest.Mock).mockImplementation(
      (id: string, provider: any) => { captured.id = id; captured.provider = provider; return { dispose: jest.fn() }; },
    );

    const context = {
      extensionUri: { fsPath: '/ext' },
      extension: { packageJSON: { version: '9.9.9' } },
    } as unknown as vscode.ExtensionContext;

    registerMcpProvider(context, { port: async () => 4321, token: 'tok' });

    expect(captured.id).toBe('runConfigManager');
    const defs = await captured.provider.provideMcpServerDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].command).toBe(process.execPath);
    expect(defs[0].env.RCM_MCP_PORT).toBe('4321');
    expect(defs[0].env.RCM_MCP_TOKEN).toBe('tok');
    expect(defs[0].env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(String(defs[0].args[0])).toContain('mcp-server.js');
  });
});
