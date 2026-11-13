# Evaluation model broker

`src/broker/index.ts` exports `createModelBroker({apiKey,stateDir,socketPath,quotaPath?})`.
The returned object exposes `app` (Fastify), `registerTrial({id,token,budget?})`,
`listen()`, `close()`, `snapshot()`, and trusted-only
`recordInfrastructureRestart(id)`. Registration and snapshots are JavaScript
interfaces; there are no HTTP administration routes. Awaiting registration is
supported although registration itself persists synchronously.

The only socket route is `POST /v1/chat/completions`, authenticated by the fake
per-trial `Authorization: Bearer ...` token. In the sandbox the HTTP relay uses
`http://127.0.0.1:18080/v1`; relay traffic goes through the bound Unix socket.
Keep broker state, registry, process environment, real credentials, and socket
parent directory outside task mounts. Unix socket mode is 0600. The broker
refuses an existing socket path; trusted launch code must remove a stale socket
only after establishing that its former owner has stopped. There is one durable
state writer; known dead-process state locks are recovered, ambiguous ownership
fails closed.

Start with `pnpm exec tsx src/broker/main.ts` or the compiled
`node dist/broker/main.js`. Supply these trusted process environment variables:

- `ERNIE_BROKER_STATE_DIR`: private durable broker state directory.
- `ERNIE_BROKER_SOCKET_PATH`: absolute Unix socket path outside sandboxes.
- `ERNIE_BROKER_REGISTRY_FILE`: private JSON regular file, format
  `{"trials":[{"id":"trial-1","token":"fake-trial-token","budget":{"maxCalls":20}}]}`.

- `ERNIE_BROKER_QUOTA_PATH`: optional absolute path for the shared durable global provider quota. When omitted, quota stays at `broker-state-dir/broker-quota.json`. Set this to the single trusted `.../broker/broker-quota.json` path for runner workers with separate per-worker budget state directories. Do not initialize, delete, or reset this shared quota when launching a worker; `SerialQuota` enforces the existing 50-call UTC-day fallback and 10 RPM cap across processes sharing this path.

The executable loads the real key with the existing `loadApiKey` vault/env
interface. Never pass the key in command arguments. Registry tokens are fake
credentials but the registry must remain trusted. State retains SHA-256 token
hashes, counters, and call metadata, without prompts, completions, or real keys.
Re-registering the same ID and token is idempotent within one broker instance;
registration after a broker restart records one infrastructure restart. Two
restarts are allowed. Trusted trial-runner restarts without a broker restart
must call `recordInfrastructureRestart` explicitly. Changed tokens or budgets
for an existing ID are rejected. No restart resets cumulative allowance.

Every authenticated completion request consumes a call, including invalid
policies, malformed/oversized JSON, preflight failures, and upstream failures.
After the call cap, further rejected requests increment `rejectedRequests`.
Limits default to 20 calls, 2M input tokens, 128K output tokens including
reasoning, 30 active minutes, and 16,384 output tokens per call. Registration can
only lower these limits. Input reservation is the UTF-8 serialized request byte
count plus 4096 and 64 per message. Output allowance is reserved before dispatch.
Remote images/audio are unsupported: content arrays accept text parts only.
Successful final usage replaces reservations; `completion_tokens` includes
reasoning, which is recorded separately without adding it a second time.
Missing usage retains input/output reservations; a complete response still
settles elapsed active time. Aborted or uncertain upstream calls retain all
reserved tokens and remaining active time. They are not automatically retried
or replayed; trusted reconciliation is required before further useful work.

`SerialQuota` serializes upstream execution and enforces the durable 10 RPM /
50 per UTC-day quota. A separate persisted dispatch timestamp enforces at least
6000 ms between upstream dispatches. Gate waiting is recorded separately from
active request time. Active time measures broker-controlled upstream execution;
trial-runner tool execution and wall-clock limits still need runner enforcement.
Every dispatch rechecks the public catalog for an exact, zero-price Baidu route.
The outgoing model is the exact free ERNIE model and provider policy pins Baidu,
zero prompt/completion prices, required parameters, and no fallback. Catalog
requests carry no model key. There are no automatic retries or alternate routes.

Native text messages, tool definitions and calls, `tool_choice`,
`parallel_tool_calls`, `response_format`, sampling options, native reasoning history,
and other compatible request fields are forwarded, with model/provider and
stream-usage policy pinned. Reasoning effort is always `high` with `exclude:false`, including when omitted by a baseline. Explicit non-high `reasoning.effort` or `reasoning_effort` and disabled reasoning are rejected before upstream dispatch. Explicit route/fallback overrides are rejected.
JSON responses are preserved. SSE events are parsed with the provider's bounded
UTF-8/SSE parser and re-encoded with tool-call and reasoning fields intact.
For this bounded implementation, SSE is buffered until validated completion
and accounting finish, then delivered as valid SSE; it does not progressively
flush tokens. Provider first-token latency is unavailable through this broker and must be reported as unavailable, never as a model latency measurement. End-to-end request latency remains measurable and includes buffering and validation. Missing final finish reason fails closed. JSON returned to a
stream request is converted to a valid completion chunk and `[DONE]`.
Client disconnect aborts catalog/upstream work and retains uncertain reservation.
Errors omit upstream response bodies and credential-bearing exception text.

Trusted tests may inject `fetch`, `now`, and a smaller
`minimumDispatchIntervalMs`; production disallows reducing spacing.
`listen({host:'127.0.0.1',port:0})` is available only with an injected fetcher.
Run `pnpm exec vitest run tests/broker.test.ts`. These HTTP fixtures are offline
behavior evidence, not live provider, baseline, or Linux-isolation validation.

The comparison broker fixes `temperature: 0` and `top_p: 1` for all requests, including omitted baseline defaults. It removes caller overrides for top_k, min_p, seed, frequency/presence/repetition penalties and logit_bias; these are unsupported or left at identical provider defaults. Native prompts, tool organization, tool choices and structured-output requests remain intact. The current route advertises temperature and top_p; route-parameter drift stops the frozen experiment epoch.

Request reasoning is canonicalized to exactly `{effort: "high", exclude: false}`. Caller-specific reasoning token-budget overrides are removed; assistant `reasoning_details` in message history and responses remain untouched.
