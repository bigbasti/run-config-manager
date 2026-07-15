import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

// The extension host bundle. `vscode` is provided by the runtime.
const extCtx = await esbuild.context({
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  external: ['vscode'],
});

// The MCP server runs as its own Node process (spawned via stdio). It never
// imports `vscode`; the SDK + zod + zod-to-json-schema are bundled in so no
// node_modules ship in the VSIX.
const mcpCtx = await esbuild.context({
  ...shared,
  entryPoints: ['src/mcp/server.ts'],
  outfile: 'out/mcp-server.js',
});

if (watch) {
  await Promise.all([extCtx.watch(), mcpCtx.watch()]);
  console.log('esbuild watching...');
} else {
  await Promise.all([extCtx.rebuild(), mcpCtx.rebuild()]);
  await Promise.all([extCtx.dispose(), mcpCtx.dispose()]);
}
