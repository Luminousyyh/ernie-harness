# Extension host integration

`src/extensions/index.ts` exports `ExtensionHost(config?, baseRegistry?)`, `parseExtensionConfig`, `ComposableToolRegistry`, `InstructionDiscovery`, `namespaceToolName` and the public types. The independent plugin author entrypoint is `src/extensions/sdk.ts` (compiled as `dist/extensions/sdk.js`); it has no runtime dependency on the host or MCP transports.

## Main integration contract

Main owns loading `stateDir/extensions.json`. Pass its parsed JSON through `parseExtensionConfig` or directly to the host constructor. Missing config resolves to `enabled: false`. Invalid config throws a generic validation error without echoing values. This module does not write persisted state.

```ts
import { ExtensionHost, parseExtensionConfig } from './extensions/index.js';

// Main loads the JSON file, treating ENOENT as {}.
const host = new ExtensionHost(parseExtensionConfig(savedJson ?? {}), projectTools);
await host.start(workspace);
const toolsForEngine = host.registry; // ToolRegistry, including projectTools

const discovery = await host.discover(workspace, 'src/feature/file.ts');
const context = await host.collectContext({ workspace, runId, signal }, 'src/feature/file.ts');
const status = host.inspect();
// Optional extension hooks, called by main at the appropriate engine checkpoints:
const checks = await host.validate({ workspace, runId, signal });
await host.emitEvent({ type: 'run.started', data: {}, workspace, runId, signal });

// Existing engine permission + intent journal + one-writer flow must surround
// toolsForEngine.execute(name, args, context), including all extension names.
// Registry cancellation propagates to base tools and extension SDK signals:
await toolsForEngine.cancelAll?.(runId);
// Main shutdown/workspace switch:
await host.dispose();
```

Create one host per workspace. `start` is idempotent for that workspace; a different workspace requires another host. `dispose` is idempotent and revokes extension tools. The base registry stays owned by main. `definitions()` returns cloned definitions and rejects duplicate names; `execute()` delegates base tools without adding a second permission system. The host performs no external model requests.

`inspect()` returns `enabled`, `started`, `disposed`, instruction source/byte summaries, skill descriptors, bounded discovery diagnostics, and MCP/plugin states with tool names. It excludes command arguments, environment mappings/values, authorization headers, transport instances and module exports. `discover()` returns `{ agents, skills, diagnostics }`. AGENTS context includes source labels and content; skill descriptors omit skill bodies. All returned instruction context has `trust: 'untrusted'`.

MCP failures are reported per server by `inspect()` so one failed server does not disable other configured extensions. A completed `start()` is not proof that every server connected. Use `connectMcp(id)`, `listMcpTools(id)`, and `disconnectMcp(id)` for explicit reconnect/refresh/disconnect. Refresh validates a whole tool batch before replacement. Disconnection/disposal removes callable tools and aborts active requests.

## Configuration

All fields are strict. Unknown fields (including literal `env`, `headers`, tokens or inline credentials) are rejected. No configuration is discovered in model output, AGENTS text or skill prose.

```json
{
  "enabled": false,
  "timeoutMs": 30000,
  "skillRoots": [],
  "mcpServers": [],
  "plugins": []
}
```

The top-level switch is off by default. Entries in an enabled host activate unless their own `enabled` is false. Server/plugin IDs are lowercase identifiers of at most 20 characters using letters, digits, hyphens and single underscores; double underscores are reserved. At most 16 MCP servers, 32 plugins and 16 additional skill roots can be configured. Timeout values are integer milliseconds from 10 through 120000.

A stdio entry has `id`, `transport: 'stdio'`, `command`, optional `args`, optional workspace-scoped `cwd`, optional `timeoutMs` and optional `envFrom`. The latter maps subprocess environment names to runtime process environment names, e.g. `{ "SERVICE_AUTH": "ERNIE_SERVICE_AUTH" }`. Place actual credentials only in the runtime environment. Command arguments and persisted files must contain no credentials. The subprocess inherits a small system environment allowlist, plus these explicit mappings; Node/Python/loader injection variables are rejected. The SDK's own default inherited variable list contains system/user/path variables, not model credentials. Stderr is discarded rather than forwarded into logs or SSE.

An HTTP entry has `id`, `transport: 'http'`, `url`, optional `bearerTokenEnv`, optional `timeoutMs` and optional `allowRemote`. Plain HTTP is accepted only for explicitly configured loopback URLs (`localhost`, `127.0.0.1`, `[::1]`). Other hosts require HTTPS and `allowRemote: true`. URL userinfo, query strings and fragments are rejected. Authorization is constructed from the named runtime environment variable. Redirects and automatic stream reconnection are disabled; tools are not automatically replayed.

A plugin entry has `id`, `path`, optional `enabled` and `trusted`. Main must explicitly persist `trusted: true` before a configured module is evaluated. Paths resolve relative to the workspace, or may be absolute. Modules must be existing `.js`, `.mjs` or `.cjs` files and default-export a plugin whose ID matches the configured ID. Loading a plugin is trusted in-process code execution, with the Node process's authority. The SDK is not an isolation sandbox. Programmatic `loadPlugin(plugin)` likewise means the caller already trusts that code.

## AGENTS and standard Skills

Discovery walks `AGENTS.md` from the workspace root to the requested target directory (or a new file's nearest existing parent), in root-to-leaf order. It never inherits instructions above the workspace. Paths and symlink targets must stay within the canonical workspace, and protected secret/repository paths are rejected. Labels such as `workspace:src/AGENTS.md` retain provenance and order; main decides how to apply precedence when composing a run prompt.

Skills are discovered in `<workspace>/.agents/skills` and explicitly configured `skillRoots` (absolute or workspace-relative). Each root contains skill directories with `SKILL.md`. User roots receive labels `user-0`, `user-1`, etc.; discovery never scans the entire home directory. A symlinked workspace skill root cannot escape the workspace. Each explicitly configured user root is its own canonical boundary, and child links cannot escape it. Invocation repeats the boundary/file checks so replacing a discovered path cannot authorize an outside read.

The parser accepts the standard Agent Skills fields `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. `name` must match the containing directory, be at most 64 characters, and use lowercase letters/digits with single hyphens between components. `description` is required and at most 1024 characters. Supported YAML is intentionally bounded: quoted or plain scalars, literal/folded text blocks, and flat scalar metadata. YAML object constructors, tags, anchors/aliases, duplicate/unknown fields and complex nested metadata are rejected with generic diagnostics. `allowed-tools` is descriptive metadata and grants no authority.

Limits: 128 KiB per document, 8 KiB/160 lines of frontmatter, 32 target path layers, 4 skill directory layers, 512 visited entries and 128 discovered skills per discovery. Directory enumeration is streamed and bounded. File size and identity are checked before/after bounded descriptor reads; canonical targets are checked again after reading. Keep adversarial writers outside the workspace's one-writer boundary: filesystem path checks do not constitute an OS sandbox.

`invoke_skill` is the only built-in extension tool. Its closed object schema accepts `{ "id": "workspace:skill-name" }` or `{ "id": "user-0:skill-name" }`. It reads one previously discovered skill body and returns JSON containing `content`, `source`, and `trust: 'untrusted'`. Large bodies are clipped before JSON serialization; both the JSON and ToolResult carry `truncated: true`, and the output remains valid JSON within 64 KiB. It does not execute commands, traverse links found in prose, auto-load related files, change tool permissions or launch MCP servers/plugins. Calling `discover()` alone returns no skill body.

## Plugin SDK v1

```ts
import { definePlugin } from './dist/extensions/sdk.js';

export default definePlugin({
  apiVersion: 1,
  id: 'example',
  register(api) {
    api.registerTool({
      name: 'hello', description: 'Return a greeting',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async (_args, context) => ({ ok: true, output: `Hello ${context.runId}` }),
    });
    api.addContext('guide', async context => `Workspace: ${context.workspace}`);
    api.addValidator('quality', async context => ({ ok: true, messages: [] }));
    api.onEvent(async event => { /* observe a main-supplied event */ });
    return async () => { /* release registration-owned resources */ };
  },
  async dispose() { /* release module-owned resources, including partial setup */ },
});
```

The interface is `HarnessPlugin { apiVersion: 1; id; register(api); dispose? }`. `register` may return a cleanup function. `PluginAPI` exposes `registerTool`, `addContext`, `addValidator`, and `onEvent`, plus `apiVersion: 1`. Tool handlers receive the existing `ToolContext` and return `ToolResult`. The passed signal combines cancellation, unload and timeout. Context and validator providers receive a bounded signal as well. Events are explicitly delivered by main; the plugin never receives a direct engine/store/transport handle from this API.

Registration stages tools and publishes them atomically after it succeeds. Duplicate tool names, IDs or contribution IDs fail registration and clean up contributions. Registration timeout/failure revokes the API handle, removes tools/hooks, calls available cleanup and `dispose`, and discards raw error text. Late returned cleanup is still called. Unload revokes tools first, aborts active calls, removes all hooks, runs returned cleanup and calls `dispose` even if another disposer fails. An older failed registration cannot unload a replacement plugin with the same ID.

Tools are namespaced `plugin_<id>__<localName>` or `mcp_<id>__<remoteName>`. MCP names with periods or long names receive a stable sanitized prefix and SHA-256 suffix, staying within provider-compatible 64-character names; exact collisions are rejected, including collisions with base tools. Input schemas remain object JSON schemas and are validated using the official SDK's AJV provider. External schema references, structurally excessive schemas and oversized inputs are rejected. Ordinary `$ref` strings in tool data remain ordinary data. Each MCP list is limited to 8 pages / 128 tools, each plugin to 128 tools / 64 hooks of each kind, and the registry to 64 active extension calls. JSON schemas/inputs are limited to 64 KiB, depth 32 and 10000 nodes.

Extension calls have bounded output, secret redaction for known runtime credentials (including later rotations), and isolated error reporting. Host-controlled stderr, status, errors, tool output, emitted tool/hook data, context and validation messages do not expose runtime credential values. Trusted plugins can access the process directly, so their own I/O is their responsibility. Timeout/cancellation signals stop waiting and notify the SDK/handler; they cannot prove an external write did not happen. Results explicitly say effects may be uncertain. Main must journal such effects and must not blindly replay them. Long synchronous plugin code cannot be preempted by JavaScript timers.

## Validation evidence

`tests/extensions-discovery.test.ts`, `tests/extensions-plugins.test.ts`, and `tests/extensions-mcp.test.ts` cover file boundaries, unsafe frontmatter, schema/namespace collisions, plugin rollback/replacement/cleanup, and official SDK local stdio and Streamable HTTP lifecycle fixtures. The stdio fixture is `examples/extensions/mcp-fixture.mjs`. Tests use synthetic fixture credentials, local processes and loopback HTTP only. No external model/service evidence is implied.
