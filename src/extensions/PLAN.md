# Extension implementation plan

**Goal:** Explicitly configured standard Skills, MCP clients, and a trusted plugin SDK behind the existing ToolRegistry.
**Architecture:** Keep discovery read-only and workspace bounded; compose registries at the engine boundary. The host owns subprocesses, SDK transports, plugin contributions and cancellation. State loading and engine integration stay with main.
**Constraints:** Only src/extensions/**, tests/extensions*.test.ts and examples/extensions/**. No external model requests, package/contract/server/core edits, credential persistence or automatic instruction execution.

- [x] Discovery and registry: first test disabled defaults, layered source labels, symlink escape, malformed/oversized frontmatter, explicit invocation, collision rejection and base delegation. Implement bounded discovery and a composable registry.
- [x] Plugin SDK: test version/trust gates, rollback on registration failure, unload cleanup, hook isolation, cancellation. Implement scoped registration and bounded lifecycle.
- [x] MCP: test real local stdio and Streamable HTTP SDK fixtures, input schema translation, environment scrubbing, redaction, namespace collisions, cancellation, timeout and disposal. Implement official SDK clients without call replay.
- [x] Integrate host, document API and examples; run focused tests and repository typecheck. Report local fixture evidence separately from external evidence.

Review focus: path aliases must not escape roots; discovery bounds apply before reads; SDK defaults must not reintroduce secret env; plugin failure must revoke registration handles; timeouts must abort requests without retries and clearly report uncertain effects.
