# Extending the harness

[简体中文](extensions.zh-CN.md) · [Architecture](architecture.md)

This tutorial uses the contracts currently being integrated in `src/extensions/types.ts` and the validated configuration in `src/extensions/config.ts`. Inspect current source and integration tests before deploying an extension. A configuration example is not evidence that a transport is connected or a model has successfully used its tools.

## A trusted plugin

Create a small `.mjs` plugin in a workspace you trust. This example registers a pure tool with no filesystem or network effects:

```js
export default {
  apiVersion: 1,
  id: 'hello',
  register(api) {
    api.registerTool({
      name: 'hello_project',
      description: 'Return a fixed greeting without reading project files.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      execute() {
        return {ok: true, output: 'Hello from the project extension.'};
      },
    });
  },
};
```

The `HarnessPlugin` contract requires `apiVersion: 1`, an `id`, and `register(api)`. Registration can return a cleanup function. `PluginAPI` also offers `addContext`, `addValidator`, and `onEvent`. These hooks are trusted in-process code: a timeout does not turn arbitrary plugin code into a sandbox.

The service's extension configuration has this shape. Resolve the plugin path under the workspace according to the current loader rules, then supply the config through the service configuration entry point. The CLI loads `extensions.json` in its runtime state directory when supported by the integrated version; inspect `src/cli/main.ts` rather than guessing an OS-specific state path.

```json
{
  "enabled": true,
  "timeoutMs": 30000,
  "skillRoots": [".agents/skills"],
  "plugins": [
    {"id": "hello", "path": "extensions/hello.mjs", "enabled": true, "trusted": true}
  ],
  "mcpServers": []
}
```

Use explicit trust only for code you have reviewed. Tool registration must respect reserved names and the loader's namespacing/collision rules. Inspect the registry after loading; do not assume the model-facing name equals the unqualified example name.

## MCP without embedded credentials

`StdioServerConfig` uses an executable and argument array, with environment mappings referencing runtime variable names. `HttpServerConfig` uses a credential-free URL and an optional `bearerTokenEnv` name. The config schema requires remote HTTP servers to use explicitly permitted HTTPS; loopback HTTP is permitted. Do not put credential values in a URL, JSON config, fixture, or log.

```json
{
  "enabled": true,
  "mcpServers": [
    {
      "id": "local_docs",
      "transport": "stdio",
      "command": "node",
      "args": ["extensions/docs-server.mjs"],
      "envFrom": {"DOCS_TOKEN": "MY_RUNTIME_DOCS_TOKEN"},
      "timeoutMs": 10000
    }
  ]
}
```

`envFrom` maps the child variable name to a variable in the parent runtime; it does not store or resolve a key at authoring time. The sample server path is a placeholder for a server you implement. `examples/extensions/mcp-fixture.mjs` is an offline fixture, not a live service or capability result. Stdio programs execute as your user; remote servers receive the requests you send them.

## Skills and repository instructions

Discovery adds attributed context and skill descriptors. Context contributions carry `trust: 'untrusted'`; they cannot override system policy, workspace boundaries, or the fixed model allowlist. Keep skill roots bounded to the intended workspace and inspect discovery diagnostics for missing, oversized, invalid, or rejected content. Do not claim that every installed third-party skill is compatible.

## Extending a built-in tool

For a read-only `project_summary` tool:

1. Define any shared data in `src/contracts` without importing implementations.
2. Add a strict schema to `src/tools/schemas.ts`; register and dispatch the tool through `ProjectTools` in `src/tools/index.ts`.
3. Reuse canonical workspace/file helpers in `src/tools/files.ts`; reject traversal, protected paths, and cancellation, and bound/redact output.
4. Test real behavior: valid output, wrong input, traversal/symlink escape, cancellation, and secret redaction. Pure tools need no write journal; tools with effects must persist intent/results and define uncertain-effect recovery.
5. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`. Validate model tool selection separately with authorized live calls.

For plugins and MCP, also test disabled/untrusted configurations, duplicate names, timeouts, disposal, transport failures, and credential redaction. Validators provide evidence for their defined checks; an arbitrary plugin validator is not an independent formal benchmark grader. See [maturity gates](../maturity.md).


## Isolated improvement configuration

For the ordinary CLI/server launcher, place a trusted `improvement-environment.json` in the server state directory. It has `version: 1`, separate `development` and `validation` objects (`root`, `manifestHash`, `evaluatorHash`), `dependenciesDir`, and optional absolute `nodeExecutable`/`bwrapExecutable`. The server reads the OpenRouter key from its existing credential vault and uses the same quota ledger. Do not put credentials in this file. HTTP requests cannot set these mount paths or evaluator pins. Windows preserves proposals until a verified Linux environment is available. Evaluator manifests and source installation must be prepared before enabling evaluation.
