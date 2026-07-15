# MCP Server for AI-Driven Run Configuration Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register an MCP server from the extension so AI agents (VS Code Copilot) can read the run-configuration schema/guide as resources and create/edit/validate/run/debug/stop configurations via tools.

**Architecture:** A separate bundled Node script (`out/mcp-server.js`) speaks MCP over stdio and forwards every operation over a localhost TCP loopback socket to an in-extension `McpBridgeServer`, which dispatches to `RunConfigService`/`ExecutionService`/`DebugService`. The extension registers the server via `vscode.lm.registerMcpServerDefinitionProvider` so it auto-appears in VS Code's MCP list.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod` (existing), `zod-to-json-schema`, Node `net`, esbuild, Jest with in-memory `vscode` mock.

**Verification bar:** `npm run typecheck && npm test && npm run build`. **DO NOT COMMIT** — the user reviews and commits manually. (Individual "Commit" steps below prepare a clean staged diff; execute them only if the user has opted into commits — otherwise stop at the staged/verified state.)

**Note on guide location:** `.vscodeignore` excludes `docs/`, so the shipped guide lives at `media/mcp/run-config-guide.md` (the `media/` tree is packaged). This is a deliberate deviation from the spec's `docs/mcp/` path.

---

## File Structure

```
src/mcp/protocol.ts              # loopback message types + newline framing helpers
src/mcp/schemaResource.ts        # zod -> JSON Schema generation
src/mcp/bridgeServices.ts        # BridgeServices interface + createBridgeServices (folder resolution, validation)
src/mcp/loopbackClient.ts        # TCP client used by the MCP server process
src/mcp/server.ts                # MCP stdio entry: SDK resources + tools -> loopbackClient
src/mcp/registerMcpProvider.ts   # vscode.lm.registerMcpServerDefinitionProvider wiring
src/services/McpBridgeServer.ts  # ext-host loopback TCP server; token auth; dispatch to BridgeServices
media/mcp/run-config-guide.md    # hand-authored LLM guide (shipped resource)
src/extension.ts                 # activate(): construct bridge + services + register provider
package.json                     # engines bump, deps, contribution point, setting
esbuild.config.mjs               # second bundle entry (out/mcp-server.js)
__mocks__/vscode.ts              # add lm.registerMcpServerDefinitionProvider + McpStdioServerDefinition
test/mcpProtocol.test.ts
test/schemaResource.test.ts
test/bridgeServices.test.ts
test/McpBridgeServer.test.ts
test/registerMcpProvider.test.ts
```

---

## Task 1: Manifest, dependencies, contribution point, setting

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump engine and add dependencies**

Edit `package.json`. Change `engines.vscode` from `"^1.85.0"` to `"^1.101.0"`. In `devDependencies` change `"@types/vscode": "^1.85.0"` to `"^1.101.0"`. Add to `dependencies`:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.19.0",
    "uuid": "^9.0.1",
    "zod": "^3.22.4",
    "zod-to-json-schema": "^3.24.1"
  }
```

- [ ] **Step 2: Add the MCP contribution point**

In `package.json` under `"contributes"`, add a top-level key (sibling of `"commands"`):

```json
    "mcpServerDefinitionProviders": [
      {
        "id": "runConfigManager",
        "label": "Run Configuration Manager"
      }
    ]
```

- [ ] **Step 3: Add the opt-out setting**

In `package.json` under `"contributes"`, add:

```json
    "configuration": {
      "title": "Run Configuration Manager",
      "properties": {
        "runConfigManager.mcp.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Register the Run Configuration Manager MCP server so AI agents can read the config schema and manage run configurations."
        }
      }
    }
```

- [ ] **Step 4: Install**

Run: `npm install`
Expected: `node_modules/@modelcontextprotocol/sdk` and `node_modules/zod-to-json-schema` exist; no peer-dependency errors that fail the install.

- [ ] **Step 5: Verify the installed MCP API surface**

Run: `node -e "const t=require('fs').readFileSync('node_modules/@types/vscode/index.d.ts','utf8'); console.log(t.includes('registerMcpServerDefinitionProvider'), t.includes('McpStdioServerDefinition'))"`
Expected: `true true`. If either is `false`, the `@types/vscode` version is too old — bump it until both are present. This confirms the exact constructor/typing used in Tasks 11–12.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(mcp): add MCP SDK deps, engine bump, contribution point, setting"
```

---

## Task 2: Second esbuild bundle for the MCP server process

**Files:**
- Modify: `esbuild.config.mjs`

- [ ] **Step 1: Replace the esbuild config with two bundles**

Replace the entire contents of `esbuild.config.mjs` with:

```js
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
```

- [ ] **Step 2: Verify the config parses (build will fail until src/mcp/server.ts exists — that's expected)**

Run: `node -e "import('./esbuild.config.mjs').catch(e => { console.error(e.message); process.exit(0); })"`
Expected: an esbuild error mentioning `src/mcp/server.ts` could not be resolved (the config itself is syntactically valid). This is expected until Task 10.

- [ ] **Step 3: Commit**

```bash
git add esbuild.config.mjs
git commit -m "build(mcp): add out/mcp-server.js as a second esbuild bundle"
```

---

## Task 3: Loopback protocol module

**Files:**
- Create: `src/mcp/protocol.ts`
- Test: `test/mcpProtocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/mcpProtocol.test.ts`:

```ts
import { encodeFrame, createFrameDecoder, BridgeRequest, BridgeResponse } from '../src/mcp/protocol';

describe('mcp loopback protocol framing', () => {
  it('encodes a message as one newline-terminated JSON line', () => {
    const req: BridgeRequest = { id: 1, token: 't', method: 'list' };
    const frame = encodeFrame(req);
    expect(frame.endsWith('\n')).toBe(true);
    expect(JSON.parse(frame.trimEnd())).toEqual(req);
  });

  it('decodes multiple messages arriving in one chunk', () => {
    const decode = createFrameDecoder<BridgeResponse>();
    const chunk =
      encodeFrame({ id: 1, ok: true, result: 'a' }) +
      encodeFrame({ id: 2, ok: false, error: 'boom' });
    const msgs = decode(chunk);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ id: 1, ok: true, result: 'a' });
    expect(msgs[1]).toEqual({ id: 2, ok: false, error: 'boom' });
  });

  it('reassembles a message split across chunks', () => {
    const decode = createFrameDecoder<BridgeResponse>();
    const full = encodeFrame({ id: 7, ok: true, result: 42 });
    const half = Math.floor(full.length / 2);
    expect(decode(full.slice(0, half))).toHaveLength(0);
    const msgs = decode(full.slice(half));
    expect(msgs).toEqual([{ id: 7, ok: true, result: 42 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/mcpProtocol.test.ts`
Expected: FAIL — cannot find module `../src/mcp/protocol`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/protocol.ts`:

```ts
// Environment variables the extension passes to the spawned MCP server process.
export const MCP_PORT_ENV = 'RCM_MCP_PORT';
export const MCP_TOKEN_ENV = 'RCM_MCP_TOKEN';
export const MCP_GUIDE_PATH_ENV = 'RCM_MCP_GUIDE_PATH';

export type BridgeMethod =
  | 'list'
  | 'get'
  | 'currentConfigs'
  | 'validate'
  | 'create'
  | 'update'
  | 'delete'
  | 'run'
  | 'debug'
  | 'stop';

export interface BridgeRequest {
  id: number;
  token: string;
  method: BridgeMethod;
  params?: unknown;
}

export type BridgeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// The loopback channel is newline-delimited JSON. One JSON document per line.
export function encodeFrame(msg: BridgeRequest | BridgeResponse): string {
  return JSON.stringify(msg) + '\n';
}

// Returns a stateful decoder that buffers partial input and yields complete
// messages as they arrive. Handles multiple messages per chunk and messages
// split across chunks.
export function createFrameDecoder<T>(): (chunk: string) => T[] {
  let buf = '';
  return (chunk: string): T[] => {
    buf += chunk;
    const out: T[] = [];
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) out.push(JSON.parse(line) as T);
    }
    return out;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/mcpProtocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/protocol.ts test/mcpProtocol.test.ts
git commit -m "feat(mcp): loopback protocol message types and framing"
```

---

## Task 4: JSON Schema resource generation

**Files:**
- Create: `src/mcp/schemaResource.ts`
- Test: `test/schemaResource.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/schemaResource.test.ts`:

```ts
import { runConfigJsonSchema } from '../src/mcp/schemaResource';

describe('runConfigJsonSchema', () => {
  it('produces an object schema string mentioning every config type', () => {
    const schema = runConfigJsonSchema();
    const json = JSON.stringify(schema);
    for (const t of [
      'npm', 'spring-boot', 'tomcat', 'quarkus', 'java', 'python',
      'maven-goal', 'gradle-task', 'custom-command', 'docker',
      'http-request', 'go',
    ]) {
      expect(json).toContain(`"${t}"`);
    }
  });

  it('includes common base field names', () => {
    const json = JSON.stringify(runConfigJsonSchema());
    expect(json).toContain('projectPath');
    expect(json).toContain('typeOptions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/schemaResource.test.ts`
Expected: FAIL — cannot find module `../src/mcp/schemaResource`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/schemaResource.ts`:

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RunConfigSchema } from '../shared/schema';

// Generated at runtime from the single source of truth (the Zod schema).
// `$refStrategy: 'none'` inlines the discriminated-union variants so an agent
// reading the resource sees each type's full shape without dereferencing.
export function runConfigJsonSchema(): object {
  return zodToJsonSchema(RunConfigSchema, {
    name: 'RunConfig',
    $refStrategy: 'none',
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/schemaResource.test.ts`
Expected: PASS (2 tests). If `zod-to-json-schema` errors on the `.superRefine` schemas, that is a real incompatibility — it is expected to succeed because `zod-to-json-schema` treats refinements as pass-through on the base object shape.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/schemaResource.ts test/schemaResource.test.ts
git commit -m "feat(mcp): generate run-config JSON Schema from Zod"
```

---

## Task 5: Bridge services (folder resolution + validation + service mapping)

**Files:**
- Create: `src/mcp/bridgeServices.ts`
- Test: `test/bridgeServices.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/bridgeServices.test.ts`:

```ts
import { createBridgeServices, BridgeDeps } from '../src/mcp/bridgeServices';
import type { RunConfig } from '../src/shared/types';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeNpm(id: string, name: string): RunConfig {
  return {
    id, name, projectPath: '/w', workspaceFolder: '/w',
    env: {}, programArgs: '', vmArgs: '',
    type: 'npm',
    typeOptions: { scriptName: 'start', packageManager: 'npm', nodePath: '' },
  } as RunConfig;
}

function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  const cfg = makeNpm(VALID_ID, 'Web');
  return {
    svc: {
      list: () => [{ folderKey: '/w', config: cfg, valid: true }],
      getById: (id) => (id === VALID_ID ? { folderKey: '/w', config: cfg, valid: true } : undefined),
      create: jest.fn(async (_k, data) => ({ ...data, id: VALID_ID } as RunConfig)),
      update: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    },
    store: {
      folderKeys: () => ['/w'],
      getFolder: (k) => (k === '/w' ? ({ uri: { fsPath: '/w' }, name: 'w', index: 0 } as any) : undefined),
      getForFolder: () => ({ configurations: [cfg] }),
    },
    exec: { run: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) },
    dbg: { debug: jest.fn(async () => true) },
    ...overrides,
  } as BridgeDeps;
}

describe('bridgeServices', () => {
  it('lists config summaries', () => {
    const s = createBridgeServices(deps());
    expect(s.listConfigs()).toEqual([
      { id: VALID_ID, name: 'Web', type: 'npm', folderKey: '/w', valid: true },
    ]);
  });

  it('validate returns ok for a good candidate', () => {
    const s = createBridgeServices(deps());
    expect(s.validateConfig(makeNpm(VALID_ID, 'Web'))).toEqual({ ok: true });
  });

  it('validate returns path-scoped errors for a bad candidate', () => {
    const s = createBridgeServices(deps());
    const bad = { ...makeNpm(VALID_ID, ''), name: '' };
    const res = s.validateConfig(bad);
    expect(res.ok).toBe(false);
    expect(res.errors!.some(e => e.path === 'name')).toBe(true);
  });

  it('create defaults to the only folder when workspaceFolder omitted', async () => {
    const d = deps();
    const s = createBridgeServices(d);
    const { config: _omit, ...rest } = makeNpm(VALID_ID, 'Web') as any;
    void _omit;
    const out = await s.createConfig({ config: { ...makeNpm(VALID_ID, 'Web') } });
    expect(out).toEqual({ id: VALID_ID });
    expect(d.svc.create).toHaveBeenCalledWith('/w', expect.objectContaining({ type: 'npm' }));
  });

  it('create errors when multiple folders and none chosen', async () => {
    const d = deps({
      store: {
        folderKeys: () => ['/a', '/b'],
        getFolder: (k) => ({ uri: { fsPath: k }, name: k, index: 0 } as any),
        getForFolder: () => ({ configurations: [] }),
      },
    });
    const s = createBridgeServices(d);
    await expect(s.createConfig({ config: makeNpm(VALID_ID, 'Web') }))
      .rejects.toThrow(/workspaceFolder is required/);
  });

  it('run resolves the folder from the config id and calls exec.run', async () => {
    const d = deps();
    const s = createBridgeServices(d);
    await s.runConfig(VALID_ID);
    expect(d.exec.run).toHaveBeenCalled();
  });

  it('run throws for an unknown id', async () => {
    const s = createBridgeServices(deps());
    await expect(s.runConfig('nope')).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/bridgeServices.test.ts`
Expected: FAIL — cannot find module `../src/mcp/bridgeServices`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/bridgeServices.ts`:

```ts
import type * as vscode from 'vscode';
import type { RunConfig, InvalidConfigEntry } from '../shared/types';
import { RunConfigSchema } from '../shared/schema';

export interface ConfigSummary {
  id: string;
  name: string;
  type: string;
  folderKey: string;
  valid: boolean;
}

export interface ValidateResult {
  ok: boolean;
  errors?: { path: string; message: string }[];
}

export interface BridgeServices {
  listConfigs(): ConfigSummary[];
  getConfig(id: string): RunConfig | InvalidConfigEntry | undefined;
  currentConfigs(): { folderKey: string; configurations: RunConfig[] }[];
  validateConfig(candidate: unknown): ValidateResult;
  createConfig(params: { config: unknown; workspaceFolder?: string }): Promise<{ id: string }>;
  updateConfig(config: unknown): Promise<void>;
  deleteConfig(id: string): Promise<void>;
  runConfig(id: string): Promise<void>;
  debugConfig(id: string): Promise<void>;
  stopConfig(id: string): Promise<void>;
}

// Narrow structural views of the real services — keeps this module unit-testable
// with plain fakes and free of concrete service imports.
export interface BridgeDeps {
  svc: {
    list(): { folderKey: string; config: RunConfig | InvalidConfigEntry; valid: boolean }[];
    getById(id: string):
      | { folderKey: string; config: RunConfig | InvalidConfigEntry; valid: boolean }
      | undefined;
    create(folderKey: string, data: Omit<RunConfig, 'id'>): Promise<RunConfig>;
    update(folderKey: string, cfg: RunConfig): Promise<void>;
    delete(folderKey: string, id: string): Promise<void>;
  };
  store: {
    folderKeys(): string[];
    getFolder(key: string): vscode.WorkspaceFolder | undefined;
    getForFolder(key: string): { configurations: RunConfig[] };
  };
  exec: {
    run(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<unknown>;
    stop(id: string): Promise<void>;
  };
  dbg: { debug(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<boolean> };
}

// A syntactically valid UUID used only to satisfy the schema's `id` field when
// validating a candidate that has not been assigned an id yet.
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

function issuesToErrors(issues: { path: (string | number)[]; message: string }[]) {
  return issues.map(i => ({ path: i.path.join('.'), message: i.message }));
}

export function createBridgeServices(deps: BridgeDeps): BridgeServices {
  const { svc, store, exec, dbg } = deps;

  const resolveValid = (id: string): { folderKey: string; config: RunConfig } => {
    const ref = svc.getById(id);
    if (!ref) throw new Error(`Configuration not found: ${id}`);
    if (!ref.valid) throw new Error(`Configuration is invalid: ${id}`);
    return ref as { folderKey: string; config: RunConfig };
  };

  const folderOrThrow = (key: string): vscode.WorkspaceFolder => {
    const f = store.getFolder(key);
    if (!f) throw new Error(`Unknown workspace folder: ${key}`);
    return f;
  };

  return {
    listConfigs: () =>
      svc.list().map(r => ({
        id: r.config.id,
        name: (r.config as { name?: string }).name ?? '(invalid)',
        type: (r.config as { type?: string }).type ?? 'invalid',
        folderKey: r.folderKey,
        valid: r.valid,
      })),

    getConfig: id => svc.getById(id)?.config,

    currentConfigs: () =>
      store.folderKeys().map(k => ({
        folderKey: k,
        configurations: store.getForFolder(k).configurations,
      })),

    validateConfig: candidate => {
      const res = RunConfigSchema.safeParse(candidate);
      if (res.success) return { ok: true };
      return { ok: false, errors: issuesToErrors(res.error.issues) };
    },

    createConfig: async ({ config, workspaceFolder }) => {
      const keys = store.folderKeys();
      let key = workspaceFolder;
      if (!key) {
        if (keys.length === 1) key = keys[0];
        else throw new Error(`workspaceFolder is required; choose one of: ${keys.join(', ')}`);
      }
      if (!keys.includes(key)) throw new Error(`Unknown workspace folder: ${key}`);

      const src = config as Record<string, unknown>;
      const parsed = RunConfigSchema.safeParse({ ...src, id: PLACEHOLDER_ID });
      if (!parsed.success) {
        throw new Error(
          `Invalid configuration: ${issuesToErrors(parsed.error.issues)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ')}`,
        );
      }
      const { id: _dropId, ...rest } = src;
      void _dropId;
      const created = await svc.create(key, rest as unknown as Omit<RunConfig, 'id'>);
      return { id: created.id };
    },

    updateConfig: async config => {
      const parsed = RunConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(
          `Invalid configuration: ${issuesToErrors(parsed.error.issues)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ')}`,
        );
      }
      const cfg = parsed.data as RunConfig;
      const ref = svc.getById(cfg.id);
      if (!ref) throw new Error(`Configuration not found: ${cfg.id}`);
      await svc.update(ref.folderKey, cfg);
    },

    deleteConfig: async id => {
      const ref = svc.getById(id);
      if (!ref) return;
      await svc.delete(ref.folderKey, id);
    },

    runConfig: async id => {
      const ref = resolveValid(id);
      await exec.run(ref.config, folderOrThrow(ref.folderKey));
    },

    debugConfig: async id => {
      const ref = resolveValid(id);
      await dbg.debug(ref.config, folderOrThrow(ref.folderKey));
    },

    stopConfig: async id => {
      await exec.stop(id);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/bridgeServices.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/bridgeServices.ts test/bridgeServices.test.ts
git commit -m "feat(mcp): bridge services with folder resolution and validation"
```

---

## Task 6: Loopback TCP bridge server + client (integration)

**Files:**
- Create: `src/services/McpBridgeServer.ts`
- Create: `src/mcp/loopbackClient.ts`
- Test: `test/McpBridgeServer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/McpBridgeServer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/McpBridgeServer.test.ts`
Expected: FAIL — cannot find module `../src/services/McpBridgeServer`.

- [ ] **Step 3: Implement the bridge server**

Create `src/services/McpBridgeServer.ts`:

```ts
import * as net from 'net';
import { log } from '../utils/logger';
import {
  createFrameDecoder,
  encodeFrame,
  BridgeRequest,
  BridgeResponse,
} from '../mcp/protocol';
import type { BridgeServices } from '../mcp/bridgeServices';

// Loopback request/response server. Mirrors NodeMonitoringService's transport
// shape (127.0.0.1:0, OS-assigned port) but is request/response rather than a
// one-way stream. Every request must carry the shared token or it is rejected
// before dispatch.
export class McpBridgeServer {
  private server: net.Server | null = null;
  private port = 0;
  private listenPromise?: Promise<number>;

  constructor(
    private readonly token: string,
    private readonly services: BridgeServices,
  ) {}

  listenPort(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    if (this.listenPromise) return this.listenPromise;
    this.server = net.createServer(sock => this.onConnection(sock));
    this.server.on('error', e => log.warn(`MCP bridge server error: ${e.message}`));
    this.listenPromise = new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = addr && typeof addr === 'object' ? addr.port : 0;
        log.info(`MCP bridge listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
    return this.listenPromise;
  }

  private onConnection(sock: net.Socket): void {
    sock.setEncoding('utf8');
    const decode = createFrameDecoder<BridgeRequest>();
    sock.on('data', chunk => {
      for (const req of decode(chunk)) void this.handle(req, sock);
    });
    sock.on('error', () => { /* client disconnects are normal */ });
  }

  private async handle(req: BridgeRequest, sock: net.Socket): Promise<void> {
    const reply = (res: BridgeResponse) => {
      try { sock.write(encodeFrame(res)); } catch { /* socket closed */ }
    };
    if (req.token !== this.token) {
      reply({ id: req.id, ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const result = await this.dispatch(req.method, req.params);
      reply({ id: req.id, ok: true, result });
    } catch (e) {
      reply({ id: req.id, ok: false, error: (e as Error).message });
    }
  }

  private dispatch(method: string, params: unknown): Promise<unknown> | unknown {
    const p = (params ?? {}) as { id?: string; config?: unknown; workspaceFolder?: string };
    switch (method) {
      case 'list': return this.services.listConfigs();
      case 'get': return this.services.getConfig(String(p.id));
      case 'currentConfigs': return this.services.currentConfigs();
      case 'validate': return this.services.validateConfig(p.config);
      case 'create': return this.services.createConfig({ config: p.config, workspaceFolder: p.workspaceFolder });
      case 'update': return this.services.updateConfig(p.config);
      case 'delete': return this.services.deleteConfig(String(p.id));
      case 'run': return this.services.runConfig(String(p.id));
      case 'debug': return this.services.debugConfig(String(p.id));
      case 'stop': return this.services.stopConfig(String(p.id));
      default: throw new Error(`unknown method: ${method}`);
    }
  }

  dispose(): void {
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
  }
}
```

- [ ] **Step 4: Implement the loopback client**

Create `src/mcp/loopbackClient.ts`:

```ts
import * as net from 'net';
import {
  createFrameDecoder,
  encodeFrame,
  BridgeMethod,
  BridgeRequest,
  BridgeResponse,
} from './protocol';

// Client used by the MCP server process to call back into the extension host.
// One persistent connection; requests are correlated by a monotonic id.
export class LoopbackClient {
  private socket: net.Socket | null = null;
  private connectPromise?: Promise<net.Socket>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private decode = createFrameDecoder<BridgeResponse>();

  constructor(private readonly port: number, private readonly token: string) {}

  private ensure(): Promise<net.Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
        this.socket = sock;
        resolve(sock);
      });
      sock.setEncoding('utf8');
      sock.on('data', chunk => {
        for (const res of this.decode(chunk)) {
          const p = this.pending.get(res.id);
          if (!p) continue;
          this.pending.delete(res.id);
          if (res.ok) p.resolve(res.result);
          else p.reject(new Error(res.error));
        }
      });
      sock.on('error', e => {
        this.socket = null;
        this.connectPromise = undefined;
        reject(e);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
      });
      sock.on('close', () => {
        this.socket = null;
        this.connectPromise = undefined;
      });
    });
    return this.connectPromise;
  }

  async call(method: BridgeMethod, params?: unknown): Promise<unknown> {
    const sock = await this.ensure();
    const id = this.nextId++;
    const req: BridgeRequest = { id, token: this.token, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      sock.write(encodeFrame(req));
    });
  }

  dispose(): void {
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest test/McpBridgeServer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/McpBridgeServer.ts src/mcp/loopbackClient.ts test/McpBridgeServer.test.ts
git commit -m "feat(mcp): loopback bridge server and client with token auth"
```

---

## Task 7: The MCP server entry point

**Files:**
- Create: `src/mcp/server.ts`

This file is thin glue over the SDK; its logic (framing, dispatch, schema) is covered by Tasks 3–6. Verification is a successful bundle (Task 8's build) plus a manual smoke check.

- [ ] **Step 1: Write the server**

Create `src/mcp/server.ts`:

```ts
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
```

- [ ] **Step 2: Type-check the extension project (excludes this file if tsconfig scoping requires — confirm it is included)**

Run: `npm run typecheck`
Expected: PASS. If `registerTool`'s `inputSchema` raw-shape form produces a type error, wrap each in `z.object({...})` (both forms are accepted by the SDK) — adjust and re-run. If TS complains about the `.js` import specifiers, that is expected to resolve because esbuild handles them; if `tsc` errors, add `"moduleResolution": "bundler"` is NOT required — instead confirm the SDK ships types for the subpath. If it does not type-check, add `// @ts-expect-error SDK subpath types` only as a last resort and note it.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): MCP stdio server exposing schema/guide resources and CRUD+lifecycle tools"
```

---

## Task 8: Build the MCP bundle and smoke-test it

**Files:** none (build + manual check)

- [ ] **Step 1: Build both bundles**

Run: `npm run build`
Expected: `out/extension.js` and `out/mcp-server.js` both produced, no esbuild errors.

- [ ] **Step 2: Smoke-test the server handshake over stdio**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | RCM_MCP_PORT=0 RCM_MCP_TOKEN=x node out/mcp-server.js
```
Expected: a single JSON-RPC line on stdout containing `"result"` with `serverInfo.name` = `run-config-manager` (the loopback client is only used inside tool/resource calls, so `initialize` succeeds even with no bridge listening). The process will not exit on its own — Ctrl-C after you see the response.

- [ ] **Step 3: Commit (only if any tweak was needed; otherwise skip)**

No file changes expected here.

---

## Task 9: The hand-authored LLM guide resource

**Files:**
- Create: `media/mcp/run-config-guide.md`

- [ ] **Step 1: Write the guide**

Create `media/mcp/run-config-guide.md` with content covering: (a) file model, (b) common base fields, (c) one subsection per type with when-to-use, launch modes, key fields, and a JSON example. Use the following starter and complete every type section (npm, spring-boot, tomcat, quarkus, java, python, maven-goal, gradle-task, custom-command, docker, http-request, go), drawing field details from `src/shared/types.ts` and `docs/LLM_ONBOARDING.md`:

```markdown
# Run Configuration Manager — Guide for AI Agents

Run configurations live in `.vscode/run.json`. Each configuration is an object
with common base fields plus a `type` discriminator and a `typeOptions` object
whose shape depends on `type`. Always call `validate_run_config` before
`create_run_config` or `update_run_config`.

## Common base fields (every type)

- `name` (string, required, non-empty) — display name.
- `projectPath` (string) — the project directory the command runs in.
- `workspaceFolder` (string) — the workspace folder path this config belongs to.
- `env` (object of string→string) — extra environment variables.
- `programArgs` (string) — arguments passed to the program.
- `vmArgs` (string) — JVM/tool flags (repurposed per type; e.g. Go tool flags).
- `port` (number, optional) — primary port the app serves on.
- `envFiles` (string[], optional) — dotenv files loaded fresh each run.
- `dependsOn` (array, optional) — `{ ref, delaySeconds? }`; ref is
  `rcm:<id>`, `launch:<name>`, or `task:<source>::<name>`.
- `group` (string, optional) — slash-separated folder path in the tree.

`id` is assigned by the tool on create — do not supply it when creating.

## Type: npm

Runs a `package.json` script. Use for Node / frontend dev servers.
`typeOptions`: `scriptName` (required), `packageManager` (`npm|yarn|pnpm`),
`nodePath` (optional; empty = node from PATH).

Example:
```json
{
  "name": "Web Dev Server",
  "projectPath": "${workspaceFolder}/web",
  "workspaceFolder": "${workspaceFolder}",
  "env": {}, "programArgs": "", "vmArgs": "",
  "type": "npm",
  "typeOptions": { "scriptName": "dev", "packageManager": "npm", "nodePath": "" }
}
```

## Type: python
<!-- launchMode: script|module|framework|pytest|custom; fields per mode. -->

## Type: spring-boot
<!-- launchMode: maven|gradle|java-main; buildTool; profiles; mainClass; etc. -->

## Type: java
<!-- launchMode: maven|gradle|java-main|maven-custom|gradle-custom. -->

## Type: quarkus
<!-- launchMode: maven|gradle; single profile. -->

## Type: tomcat
<!-- tomcatHome, artifactPath (required); ports; artifactKind war|exploded. -->

## Type: maven-goal
<!-- goal (required, free-form). supportsDebug=false. -->

## Type: gradle-task
<!-- task (required, free-form). supportsDebug=false. -->

## Type: go
<!-- launchMode: run|test|build|install|custom; goPath; packagePath. -->

## Type: docker
<!-- containerId (required). Runs docker start. -->

## Type: custom-command
<!-- command (required); shell; interactive. supportsDebug=false. -->

## Type: http-request
<!-- url (required), method, headers, body. Driven by HttpRequestRunner. -->
```

Replace every `<!-- ... -->` placeholder with a complete subsection (when-to-use, the required/optional `typeOptions` fields with types drawn from `src/shared/schema.ts`, and a full JSON example like the npm one). The machine-readable contract is the `runconfig://schema` resource; this guide adds the "why/when" prose.

- [ ] **Step 2: Verify it is not ignored from packaging**

Run: `node -e "const {execSync}=require('child_process'); const out=execSync('npx vsce ls 2>/dev/null || true').toString(); console.log(out.includes('media/mcp/run-config-guide.md'))"`
Expected: `true`. (If `vsce ls` is unavailable offline, instead confirm `.vscodeignore` has no `media/` exclusion — it does not.)

- [ ] **Step 3: Commit**

```bash
git add media/mcp/run-config-guide.md
git commit -m "docs(mcp): hand-authored run configuration guide resource"
```

---

## Task 10: vscode mock additions for the provider API

**Files:**
- Modify: `__mocks__/vscode.ts`

- [ ] **Step 1: Inspect the current mock's export shape**

Read `__mocks__/vscode.ts` to find how `EventEmitter` and namespaces like `window`/`workspace` are exported, so the additions match the file's existing style (single default-ish module object vs named exports).

- [ ] **Step 2: Add `lm` namespace and `McpStdioServerDefinition`**

Add to `__mocks__/vscode.ts` (adapt to the file's export pattern):

```ts
export class McpStdioServerDefinition {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  version?: string;
  cwd?: unknown;
  // The real API uses positional args; accept an options object OR positionals
  // so tests and impl both compile regardless of which form Task 11 uses.
  constructor(
    labelOrOpts: string | { label: string; command: string; args?: string[]; env?: Record<string, string | number | null>; version?: string; cwd?: unknown },
    command?: string,
    args?: string[],
    env?: Record<string, string | number | null>,
    version?: string,
  ) {
    if (typeof labelOrOpts === 'object') {
      this.label = labelOrOpts.label;
      this.command = labelOrOpts.command;
      this.args = labelOrOpts.args ?? [];
      this.env = labelOrOpts.env ?? {};
      this.version = labelOrOpts.version;
      this.cwd = labelOrOpts.cwd;
    } else {
      this.label = labelOrOpts;
      this.command = command ?? '';
      this.args = args ?? [];
      this.env = env ?? {};
      this.version = version;
    }
  }
}

export const lm = {
  registerMcpServerDefinitionProvider: jest.fn(
    (_id: string, _provider: unknown) => ({ dispose: jest.fn() }),
  ),
};
```

NOTE: In Task 11, match the constructor call form to whatever the real `@types/vscode` (verified in Task 1 Step 5) declares. If the real type is positional-only, use positional in `registerMcpProvider.ts`; the mock above accepts both.

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm test`
Expected: PASS — no regressions from the mock additions (existing suite is green apart from the known-flaky `test/detectTomcat.test.ts:73` on macOS).

- [ ] **Step 4: Commit**

```bash
git add __mocks__/vscode.ts
git commit -m "test(mcp): mock vscode.lm and McpStdioServerDefinition"
```

---

## Task 11: Register the MCP server definition provider

**Files:**
- Create: `src/mcp/registerMcpProvider.ts`
- Test: `test/registerMcpProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/registerMcpProvider.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/registerMcpProvider.test.ts`
Expected: FAIL — cannot find module `../src/mcp/registerMcpProvider`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/registerMcpProvider.ts` (use the constructor form that matches the verified `@types/vscode`; object-form shown, switch to positional if required):

```ts
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
      return [
        new vscode.McpStdioServerDefinition({
          label: 'Run Configuration Manager',
          command: process.execPath,
          args: [serverPath],
          env: {
            // Run the bundled script as Node rather than as an Electron window.
            ELECTRON_RUN_AS_NODE: '1',
            [MCP_PORT_ENV]: String(port),
            [MCP_TOKEN_ENV]: opts.token,
            [MCP_GUIDE_PATH_ENV]: guidePath,
          },
          version,
        }),
      ];
    },
    resolveMcpServerDefinition: async server => server,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/registerMcpProvider.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/registerMcpProvider.ts test/registerMcpProvider.test.ts
git commit -m "feat(mcp): register MCP server definition provider"
```

---

## Task 12: Wire everything into extension activation

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add imports near the other service imports**

Add to the import block at the top of `src/extension.ts`:

```ts
import * as crypto from 'crypto';
import { McpBridgeServer } from './services/McpBridgeServer';
import { createBridgeServices } from './mcp/bridgeServices';
import { registerMcpProvider } from './mcp/registerMcpProvider';
```

- [ ] **Step 2: Construct the bridge + register the provider**

In `activate()`, immediately after the line `const groups = new GroupService(svc);` (currently `src/extension.ts:103`), insert:

```ts
  // MCP server: let AI agents read the config schema/guide and manage configs.
  // Gated behind a setting; the bridge listens lazily (first provider fetch).
  if (vscode.workspace.getConfiguration('runConfigManager').get<boolean>('mcp.enabled', true)) {
    const mcpToken = crypto.randomBytes(24).toString('hex');
    const bridgeServices = createBridgeServices({ svc, store, exec, dbg });
    const bridge = new McpBridgeServer(mcpToken, bridgeServices);
    context.subscriptions.push({ dispose: () => bridge.dispose() });
    context.subscriptions.push(
      registerMcpProvider(context, { port: () => bridge.listenPort(), token: mcpToken }),
    );
  }
```

- [ ] **Step 3: Confirm the injected service shapes match**

The `createBridgeServices` deps expect `svc.list/getById/create/update/delete`, `store.folderKeys/getFolder/getForFolder`, `exec.run/stop`, and `dbg.debug` — all present on the existing `RunConfigService`, `ConfigStore`, `ExecutionService`, and `DebugService`. No signature changes needed. `exec.run(cfg, folder)` is called without `opts` (plain run), and `dbg.debug(cfg, folder)` without monitor opts.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: PASS. If `createBridgeServices` complains that `exec.run` returns `Promise<vscode.TaskExecution | undefined>` where the dep declares `Promise<unknown>`, that is compatible (`unknown` accepts it). If `dbg.debug` arity mismatches, confirm the dep's `debug(cfg, folder)` matches the real optional third param (it does — the third param is optional).

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck PASS; tests PASS (new suites + existing, apart from the known macOS-flaky `test/detectTomcat.test.ts:73`); build produces `out/extension.js` and `out/mcp-server.js`.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat(mcp): wire MCP bridge and provider into activation behind a setting"
```

---

## Task 13: Manual end-to-end verification in the Extension Development Host

**Files:** none

- [ ] **Step 1: Launch and enable**

Press F5 to open the Extension Development Host. Open a folder that has (or can have) a `.vscode/run.json`. Run **MCP: List Servers** from the Command Palette; confirm **Run Configuration Manager** appears. Start it and choose **Show Output** — confirm no connection errors.

- [ ] **Step 2: Exercise resources and tools from Copilot Chat (agent mode)**

- Ask the agent to read the `runconfig://schema` and `runconfig://guide` resources (via **Add Context → MCP Resource**), then ask it to "create an npm run configuration named 'Dev' that runs the `dev` script". Confirm a confirmation dialog appears for `create_run_config`, approve it, and verify `.vscode/run.json` gains the config and the tree refreshes.
- Ask it to "list run configurations" (read-only, no prompt) and "validate" a deliberately-invalid config (empty name) — confirm the returned errors reference `name`.
- Ask it to "run" then "stop" the config; confirm the tree shows the running state and stops.

- [ ] **Step 3: Multi-root + disable checks**

- With two workspace folders, ask the agent to create a config without specifying a folder — confirm the tool returns the "workspaceFolder is required" error listing both folders.
- Set `"runConfigManager.mcp.enabled": false`, reload, and confirm the server no longer appears in **MCP: List Servers**.

- [ ] **Step 4: Update the onboarding memory (optional, no commit)**

Note the new MCP feature in `docs/LLM_ONBOARDING.md`'s architectural-decisions section if the user wants the doc kept current (leave uncommitted per the no-auto-commit rule).

---

## Self-Review Notes (already applied)

- **Spec coverage:** resources (schema/guide/current) → Tasks 4, 7, 9; CRUD+validate tools → Tasks 5, 7; run/debug/stop → Tasks 5, 7; loopback bridge + token → Task 6; provider registration + engine bump + setting → Tasks 1, 11, 12; second bundle → Task 2; tests → Tasks 3–6, 10, 11; manual E2E → Task 13.
- **Type consistency:** `BridgeMethod`, `BridgeRequest`, `BridgeResponse`, `BridgeServices`, `BridgeDeps`, `createBridgeServices`, `McpBridgeServer(token, services)`, `LoopbackClient(port, token).call(method, params)`, and the env constants (`MCP_PORT_ENV`/`MCP_TOKEN_ENV`/`MCP_GUIDE_PATH_ENV`) are used identically across Tasks 3, 5, 6, 7, 11, 12.
- **Guide path deviation:** ships at `media/mcp/run-config-guide.md` (not `docs/mcp/`) because `.vscodeignore` excludes `docs/`. Documented in the header.
- **Known-flaky test** `test/detectTomcat.test.ts:73` is unrelated and may fail on macOS.
