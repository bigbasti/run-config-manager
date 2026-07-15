import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_PORT_ENV, MCP_TOKEN_ENV, MCP_GUIDE_PATH_ENV } from './protocol';

export interface McpProviderOpts {
  // Lazily starts (or returns) the bridge server's loopback port.
  port(): Promise<number>;
  token: string;
}

export function registerMcpProvider(
  context: vscode.ExtensionContext,
  opts: McpProviderOpts,
): vscode.Disposable {
  const serverPath = path.join(context.extensionUri.fsPath, 'out', 'mcp-server.js');
  const guidePath = path.join(context.extensionUri.fsPath, 'media', 'mcp', 'run-config-guide.md');
  const version = (context.extension?.packageJSON?.version as string) ?? '0.0.0';

  const emitter = new vscode.EventEmitter<void>();

  return vscode.lm.registerMcpServerDefinitionProvider('runConfigManager', {
    onDidChangeMcpServerDefinitions: emitter.event,
    provideMcpServerDefinitions: async () => {
      const port = await opts.port();
      // Positional constructor: (label, command, args?, env?, version?).
      return [
        new vscode.McpStdioServerDefinition(
          'Run Configuration Manager',
          process.execPath,
          [serverPath],
          {
            // Run the bundled script as Node rather than as an Electron window.
            ELECTRON_RUN_AS_NODE: '1',
            [MCP_PORT_ENV]: String(port),
            [MCP_TOKEN_ENV]: opts.token,
            [MCP_GUIDE_PATH_ENV]: guidePath,
          },
          version,
        ),
      ];
    },
    resolveMcpServerDefinition: server => server,
  });
}
