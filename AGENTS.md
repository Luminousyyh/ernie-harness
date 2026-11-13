# ERNIE Harness
Independent TypeScript coding harness. Node 24, pnpm. Default UI Chinese.
## Map
src/contracts: shared types. provider: OpenRouter. tools: project operations.
store/core/supervisor: SQLite, execution, durable goals. server/cli: service/terminal.
web: React UI. eval/scripts: remote evaluation. tests: behavior checks.
## Boundaries
Contracts cannot import implementations. UI uses HTTP/SSE, never model secrets.
Only baidu/ernie-5.5-flash-preview:free. No paid or alternate-model fallback.
Count auxiliary calls/retries. Never report mocks as live evidence.
Journal uncertain effects; never blindly replay writes. One writer per workspace.
Workers own disjoint modules; preserve others' edits. Coordinate contract changes.
Credentials runtime-only, never in source, logs, reports or fixtures.
## Validation
pnpm typecheck; pnpm test; pnpm build. Live model validation reported separately.
