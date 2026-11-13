# Local extension examples

Read `src/extensions/README.md` for the integration contract and full config. Main owns reading `stateDir/extensions.json`; this directory does not install or enable anything automatically.

- `extensions.example.json`: disabled configuration template. Copy to the application's state directory only when desired; enable the host and individual entries explicitly. A plugin also needs `trusted: true`.
- `example-plugin.mjs`: independent SDK v1 plugin with a Chinese word-count tool, context/validator/event contributions and cleanup. It runs trusted in the host process.
- `mcp-fixture.mjs`: real local official-SDK stdio server used by lifecycle tests. It implements echo, cancellation, counters and synthetic environment inspection. It makes no external calls.

For a temporary local test, pass an enabled object directly to `new ExtensionHost(config, baseRegistry)` and call `start(workspace)`. Tool names are `plugin_example__word_count` and `mcp_local-fixture__echo`. Keep the existing engine permission and intent-journal flow around `host.registry.execute`. Call `dispose()` at shutdown.

Skill roots contain skill directories with `SKILL.md`; the standard workspace location is `.agents/skills/<name>/SKILL.md`. Invocation is explicit through `invoke_skill` with the source-qualified discovered ID. A skill body is guidance, not executable configuration.
