# MCP Server for AI-Driven Run Configuration Management — Design

Date: 2026-07-15
Status: Approved (pending written-spec review)
Scope: Register an MCP server from the extension so AI agents (VS Code Copilot,
and any MCP client) can understand the run-configuration schema and
create/edit/run configurations on the user's behalf.

## Goal

Let an AI agent author and operate run configurations for the user. The agent
must be able to (a) read a machine-readable schema plus human-authored guidance
describing every config type, and (b) call tools to list/create/update/delete,
validate, and run/debug/stop configurations — all going through the extension's
existing services so `ConfigStore` remains the single source of truth.

The server must be **auto-listed** in VS Code's MCP server list and enabled by
the user through the standard MCP UI, connected over **stdio**.

## Decisions (from brainstorming)

- **Server surface:** Context resources **plus** full create/edit tools **plus**
  run/debug/stop lifecycle tools.
- **Mutation path:** Tools **bridge back to the extension host** over a loopback
  TCP socket; the extension executes them via `RunConfigService` /
  `ExecutionService` / `DebugService`. No direct filesystem writes from the
  server process — reuses atomic writes, migrations, invalid-entry handling,
  groups. Mirrors the existing Node-monitoring loopback pattern.
- **Schema context:** Auto-generate a JSON Schema from the existing Zod schema
  (`zod-to-json-schema`) **and** hand-author a per-type prose guide. Both exposed
  as MCP resources. Also expose the workspace's current configs as a resource.
- **Transport:** stdio. The server is a separate bundled Node script spawned by
  VS Code via `McpStdioServerDefinition`.

## Architecture

```
Copilot Agent  ──stdio──▶  MCP server process        ──loopback TCP──▶  Extension host
(VS Code)                  (out/mcp-server.js)        (JSON req/resp)     (McpBridgeServer)
                           - @modelcontextprotocol/sdk                    - RunConfigService (CRUD)
                           - resources (schema/guide/current)             - ExecutionService (run/stop)
                           - tools (CRUD + lifecycle)                     - DebugService (debug)
                                                                          - resolves workspace folders
```

- The extension registers the server via
  `vscode.lm.registerMcpServerDefinitionProvider('runConfigManager', ...)` and
  the `contributes.mcpServerDefinitionProviders` manifest point, so it
  auto-appears in VS Code's MCP server list. The user enables/starts it through
  the standard MCP UI. A single opt-out setting
  (`runConfigManager.mcp.enabled`, default `true`) lets a user suppress
  registration entirely.
- The MCP server is a **second esbuild entry point** (`src/mcp/server.ts` →
  `out/mcp-server.js`), Node CJS, with `@modelcontextprotocol/sdk` bundled in. It
  never imports `vscode`. It is stateless about configs — every tool forwards to
  the extension over loopback.
- Spawned with `command = process.execPath` and `env.ELECTRON_RUN_AS_NODE = '1'`
  (runs a Node script without assuming `node` is on PATH). The bridge port and a
  random auth token are passed via `env`. `resolveMcpServerDefinition` fills in
  the live port/token at start time (the loopback server is started lazily then).

## Existing architecture (the seam we build against)

- **Loopback pattern** — `NodeMonitoringService` (src/services/NodeMonitoringService.ts)
  creates a `net.Server` bound to `127.0.0.1:0`, hands the OS-assigned port to a
  spawned child via env, and dispatches messages by id. `McpBridgeServer` reuses
  this shape but is request/response rather than streaming.
- **CRUD** — `RunConfigService` (src/services/RunConfigService.ts) exposes
  `list()`, `getById(id)`, `create(folderKey, data)`, `update(folderKey, cfg)`,
  `delete(folderKey, id)`. All writes route through `ConfigStore.write` (atomic,
  debounced, migration-aware). `list()` returns `ConfigRef` with `folderKey`.
- **Lifecycle** — `ExecutionService.run(cfg, folder, opts?)` / `stop(id)` and
  `DebugService.debug(cfg, folder, opts?)`.
- **Schema** — `src/shared/schema.ts` is a `z.discriminatedUnion('type', ...)`
  over 12 variants; `parseRunFile`/`RunConfigSchema` are the validation entry
  points. `src/shared/` code is designed to run in multiple contexts (extension,
  webview) — the MCP bundle is one more.

## Resources

All read-only.

- `runconfig://schema` (`application/json`) — JSON Schema generated at build/run
  time from `RunConfigSchema` via `zod-to-json-schema`. Structural contract:
  discriminated variants, enums, required fields, common base fields.
- `runconfig://guide` (`text/markdown`) — hand-authored LLM guide living at
  `docs/mcp/run-config-guide.md`, bundled into the extension and served verbatim.
  Covers per-type purpose, when to choose each `launchMode`, field meanings, and
  1–2 worked examples per type.
- `runconfig://current` (`application/json`) — the workspace's current configs
  (via the bridge → `RunConfigService.list()`), so the agent can edit relative to
  what exists.

## Tools

Read-only (marked `readOnlyHint`, no confirmation prompt):

- `list_run_configs` — all configs across folders: `{ id, name, type, folderKey, valid }`.
- `get_run_config` — full config object by `id`.
- `validate_run_config` — validate a candidate config object against
  `RunConfigSchema`; return precise per-path errors. Lets the agent self-correct
  before writing.

Mutating / lifecycle (no `readOnlyHint` → VS Code prompts for confirmation):

- `create_run_config` — takes a config object (minus `id`) and optional
  `workspaceFolder`. Folder resolution: exactly one folder → default to it;
  multiple folders and none given → return an error listing available folders.
- `update_run_config` — takes a full config object; folder resolved from `id`.
- `delete_run_config` — by `id`; folder resolved from `id`.
- `run_config` / `debug_config` / `stop_config` — by `id`; folder resolved from `id`.

All map onto existing `RunConfigService` / `ExecutionService` / `DebugService`
methods.

## Loopback protocol (`src/mcp/protocol.ts`)

- Newline-delimited JSON, request/response keyed by a monotonic `id`.
- Every request carries the shared `token`; the bridge rejects any message with a
  missing/mismatched token before dispatch.
- Request: `{ id, token, method, params }`; response:
  `{ id, ok: true, result }` or `{ id, ok: false, error }`.
- `method` ∈ the tool/resource operations above (`list`, `get`, `create`,
  `update`, `delete`, `validate`, `run`, `debug`, `stop`, `currentConfigs`).

## Security

- Bridge listens only on `127.0.0.1`, OS-assigned port. A random token generated
  per activation is required on every loopback message — blocks other local
  processes from driving the bridge.
- Mutating + lifecycle tools omit `readOnlyHint`, so VS Code shows a confirmation
  dialog before each side-effecting call; the human stays in the loop.
- All mutations run through `RunConfigService`/`ConfigStore`, so malformed input
  produces the same Zod validation errors as the UI — no bypass.

## Manifest, dependencies & build

- **`engines.vscode`: `^1.85.0` → `^1.101.0`** — required; the MCP
  registration API and contribution point do not exist before 1.101. Bump
  `@types/vscode` to match. This drops support for VS Code < 1.101 (accepted
  trade-off; the alternative — a manual `.vscode/mcp.json` — loses the
  auto-listed / one-click-enable behavior that is the point of this feature).
- Runtime deps added: `@modelcontextprotocol/sdk`, `zod-to-json-schema` (`zod`
  already present).
- `esbuild.config.mjs`: add `src/mcp/server.ts` → `out/mcp-server.js` as a
  second Node CJS bundle (SDK bundled in; no `vscode` import).
- `package.json` `contributes.mcpServerDefinitionProviders`:
  `[{ "id": "runConfigManager", "label": "Run Configuration Manager" }]`.
- New setting `runConfigManager.mcp.enabled` (boolean, default `true`).

## New / changed files

```
src/mcp/server.ts               # MCP stdio server: SDK wiring, resources, tools -> loopback client
src/mcp/protocol.ts             # loopback req/resp message shapes + token
src/mcp/schemaResource.ts       # zod -> JSON Schema generation (shared, testable)
src/mcp/registerMcpProvider.ts  # vscode.lm.registerMcpServerDefinitionProvider wiring
src/services/McpBridgeServer.ts # ext-host loopback TCP server; dispatches to services
docs/mcp/run-config-guide.md    # hand-authored LLM guide (bundled resource)
src/extension.ts                # activate(): construct McpBridgeServer + register provider
package.json                    # engines bump, deps, contribution, setting
esbuild.config.mjs              # second bundle entry point
```

## Testing

Jest with the in-memory `vscode` mock, matching existing conventions:

- `schemaResource.test.ts` — generated JSON Schema includes all 12 type variants,
  required fields, and enums.
- `McpBridgeServer.test.ts` — loopback dispatch: token rejection; list/get/
  create/update/delete/validate mapping to a fake service set; folder resolution
  (single vs multi-root ambiguity error); unknown-method error; run/debug/stop
  routing.
- `mcpProtocol.test.ts` — request/response framing round-trips (partial-chunk
  reassembly, multiple messages per chunk).
- MCP SDK handlers stay thin (translate → bridge call), so logic is covered by
  the bridge + schema tests.

Verification bar: `npm run typecheck && npm test && npm run build`. **Do NOT
commit** — the user reviews and commits manually.

## Out of scope (v1)

- Prompts / slash commands, sampling, MCP Apps UI, authentication/OAuth.
- Resource templates and completions.
- Agent-driven detection (the agent supplies field values; it does not invoke
  adapter `detectStreaming`).
- Config `run.json` group/folder mutation tools (create/rename groups) — CRUD of
  configs only for v1.
```
