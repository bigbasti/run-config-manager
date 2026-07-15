import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import { z } from 'zod';
import { LoopbackClient } from './loopbackClient';
import { runConfigJsonSchema } from './schemaResource';
import { MCP_PORT_ENV, MCP_TOKEN_ENV, MCP_GUIDE_PATH_ENV } from './protocol';

const port = Number(process.env[MCP_PORT_ENV] ?? '0');
const token = process.env[MCP_TOKEN_ENV] ?? '';
const guidePath = process.env[MCP_GUIDE_PATH_ENV] ?? '';
const client = new LoopbackClient(port, token);

const server = new McpServer({ name: 'run-config-manager', version: '0.9.2' });

const text = (obj: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
  }],
});

server.registerResource(
  'schema',
  'runconfig://schema',
  {
    title: 'Run Configuration Schema',
    description: 'JSON Schema describing every run configuration type and its fields.',
    mimeType: 'application/json',
  },
  async uri => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(runConfigJsonSchema(), null, 2),
    }],
  }),
);

server.registerResource(
  'guide',
  'runconfig://guide',
  {
    title: 'Run Configuration Guide',
    description: 'Human-authored guide: purpose of each config type, launch modes, field meanings, examples.',
    mimeType: 'text/markdown',
  },
  async uri => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: guidePath && fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '',
    }],
  }),
);

server.registerResource(
  'current',
  'runconfig://current',
  {
    title: 'Current Run Configurations',
    description: "The workspace's current run configurations, grouped by folder.",
    mimeType: 'application/json',
  },
  async uri => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(await client.call('currentConfigs'), null, 2),
    }],
  }),
);

server.registerTool(
  'list_run_configs',
  {
    title: 'List run configurations',
    description: 'List all run configurations across workspace folders (id, name, type, folder, validity).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => text(await client.call('list')),
);

server.registerTool(
  'get_run_config',
  {
    title: 'Get run configuration',
    description: 'Return the full configuration object for a given id.',
    inputSchema: { id: z.string().describe('The configuration id.') },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => text(await client.call('get', { id })),
);

server.registerTool(
  'validate_run_config',
  {
    title: 'Validate run configuration',
    description: 'Validate a candidate configuration object against the schema. Returns { ok } or path-scoped errors. Call this before create/update.',
    inputSchema: { config: z.record(z.string(), z.any()).describe('A candidate run configuration object.') },
    annotations: { readOnlyHint: true },
  },
  async ({ config }) => text(await client.call('validate', { config })),
);

server.registerTool(
  'create_run_config',
  {
    title: 'Create run configuration',
    description: 'Create a new run configuration in the workspace. Omit `id`; it is generated. In a multi-root workspace, pass `workspaceFolder`.',
    inputSchema: {
      config: z.record(z.string(), z.any()).describe('The run configuration object (without id).'),
      workspaceFolder: z.string().optional().describe('Target workspace folder path (required only when multiple folders exist).'),
    },
  },
  async ({ config, workspaceFolder }) => text(await client.call('create', { config, workspaceFolder })),
);

server.registerTool(
  'update_run_config',
  {
    title: 'Update run configuration',
    description: 'Replace an existing configuration. The `config.id` must match an existing configuration.',
    inputSchema: { config: z.record(z.string(), z.any()).describe('The full run configuration object including its id.') },
  },
  async ({ config }) => text(await client.call('update', { config })),
);

server.registerTool(
  'delete_run_config',
  {
    title: 'Delete run configuration',
    description: 'Delete a configuration by id.',
    inputSchema: { id: z.string().describe('The configuration id.') },
    annotations: { destructiveHint: true },
  },
  async ({ id }) => text(await client.call('delete', { id })),
);

server.registerTool(
  'run_config',
  {
    title: 'Run configuration',
    description: 'Start a configuration by id (non-debug).',
    inputSchema: { id: z.string().describe('The configuration id.') },
  },
  async ({ id }) => text(await client.call('run', { id })),
);

server.registerTool(
  'debug_config',
  {
    title: 'Debug configuration',
    description: 'Start a configuration by id in debug mode (if the type supports debugging).',
    inputSchema: { id: z.string().describe('The configuration id.') },
  },
  async ({ id }) => text(await client.call('debug', { id })),
);

server.registerTool(
  'stop_config',
  {
    title: 'Stop configuration',
    description: 'Stop a running configuration by id.',
    inputSchema: { id: z.string().describe('The configuration id.') },
  },
  async ({ id }) => text(await client.call('stop', { id })),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch(err => {
  process.stderr.write(`MCP server fatal: ${String(err)}\n`);
  process.exit(1);
});
