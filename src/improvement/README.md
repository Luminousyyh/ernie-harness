# Embedded durable improvement service

`src/improvement/index.ts` exports `ImprovementService`, `createImprovementBroker`, the integration types, and the paired comparator. This module owns a separate SQLite database and does not change core/store/contracts/server/package code.

```ts
import {ImprovementService, createImprovementBroker} from './improvement/index.js';

const service = new ImprovementService({
  stateDir: '/private/ernie/improvement',
  sourceRoot: '/opt/ernie-source', // existing Git checkout; current working files are archived
  model: sharedModelTransport,
  budget: sharedPersistentBudget,
  // Omit on Windows: proposals still call model and are archived as awaiting-environment.
  environment: {
    development: {root: '/evaluation/development-v1', manifestHash, evaluatorHash},
    validation: {root: '/evaluation/sealed-v1', manifestHash: sealedManifestHash, evaluatorHash: sealedEvaluatorHash},
    dependenciesDir: '/opt/ernie-source/node_modules',
    broker: createImprovementBroker({
      stateDir: '/private/ernie/improvement-broker',
      quotaPath: sharedQuotaPath, apiKey: runtimeOnlyApiKey,
    }),
  },
});
const job = service.start({workspace, maxCandidates: 2, maxCalls: 400,
  selection: {mode: 'search'}});
await service.wait(job.id); // optional; start returns immediately
const view = service.get(job.id); // job + candidates + durable attempts
// service.list(); service.cancel(job.id);
// await service.apply(candidateId); // explicit stable activation, only after sealed success
// await service.rollback({expectedCandidateId: candidateId});
// await service.close();
```

The constructor settings, evaluator directories, executable arrays, broker adapter, and shared budget implementation are trusted operator configuration. Do not accept them as arbitrary HTTP request fields. `start()` accepts workspace, bounded cycle limits, fixed/search module selection, and explicitly pinned development traces. It does not accept scores, evaluation functions, shell strings, alternate models, validation traces, or bypass flags.

`list()`/`get(id)` are synchronous snapshots; `cancel(id)` aborts all owned model/process work and returns the durable job. `apply(candidateId)` and `rollback({expectedCandidateId?})` return an `Activation` with `candidateId`, source hash, materialized path, and parent ID. `active()` and `lineage()` expose the installed version and its history. `close()` aborts and drains owned work before releasing the database/owner lock. Interrupted jobs become `needs-reconciliation`; cancel a reconciled interrupted job explicitly before beginning another cycle for that workspace. There is no automatic replay of a model request, worktree operation, task, validation seal, or uncertain write.

Activation is an atomic SQLite source-version pointer. It does not overwrite the running checkout or import candidate JavaScript into the server process. Main integration calls `runActive(...)` for subsequent isolated harness launches; the method resolves and verifies the activated materialization itself. The exported pointer is not a request to execute untrusted candidate code on the host. The initial parent is retained as a rollback target. Activation rejects changed baseline source, modified candidate source/build artifact archives, manifest drift, missing isolation, missing build/test evidence, unpaired scores, or ties.

The owning application should also hold its ordinary workspace lease while scheduling an improvement cycle, so user goals and improvement work use the same global workspace policy. Within this service, a canonical workspace has one active writer, a state directory has one live process owner, and budget/activation mutations use SQLite immediate transactions.

## Shared allowance contract

`SharedImprovementBudget.reserve({jobId,attemptId,kind,maxCalls,inputTokens,outputTokens}, signal)` must durably debit the same global allowance used by ordinary model calls **before dispatch**. `settle({jobId,attemptId,usage,uncertain})` must settle that reservation once. No retry is performed if a callback's effect is uncertain. Failed/unsettled local attempts retain their full reservation, including across restart; confirmed actual overages are retained, not clipped. Proposal calls reserve one call. Each tested task reserves 20 calls, 2,000,000 input tokens and 128,000 output tokens before its scoped broker is created. The cycle cannot reserve more than 400 calls or archive more than two candidates. Global/free-route availability can impose a lower allowance.

`model` is the application's existing `ModelTransport`; no alternate provider or paid fallback exists here. It is called directly for every proposal. Any transport-level auxiliary generation/retry must already be accounted for by the same supplied global allowance. This service does not introduce hidden proposal retries. Candidate traffic uses the existing fixed-model broker through a private Unix socket and loopback relay. `createImprovementBroker` creates a separate registered trial per task, shares the supplied quota path, shuts the scoped broker down once, and reads its authoritative final ledger. Its `finish()` is idempotent and reports uncertain requests; candidate-reported usage is never accepted.

## Evaluator configuration

Each independently frozen suite is a directory with `manifest.json`, trusted graders and `fixtures/<task>/` subdirectories. Pin `manifestHash = sha256(raw manifest bytes)` and `evaluatorHash = await hashTree(root)` (exported in `archive.ts`). Freeze fixture hashes before writing the manifest; the directory hash includes the finished manifest. All files must be regular and free of linked ancestors, symlinks, hardlinks, Git metadata, stable databases and credential files. Development and validation roots must be separate, non-overlapping directories outside the archived source trees. Their task IDs and fixture hashes must be disjoint.

```json
{
  "schemaVersion": 1,
  "version": "development-v1",
  "partition": "development",
  "tasks": [{
    "id": "dev-example",
    "fixture": "fixtures/example",
    "fixtureHash": "<64 lowercase hex digits>",
    "prompt": "Implement the task and verify it.",
    "grade": ["/runtime/node", "/evaluator/grade.mjs", "example"]
  }]
}
```

Use `partition: "sealed-validation"` and a different frozen manifest for validation. A suite has 1–8 tasks. Graders must assert meaningful behavior and return nonzero on failure; merely trusting the candidate's final message is not grading. The host starts the grader in a fresh namespace after the candidate exits. Grading has the task workspace and a read-only evaluator mount, with no candidate source, broker, upstream credential, stable database or host HOME. The agent sees its single task prompt/workspace and read-only built candidate source/dependencies; it does not receive the evaluator directory or other tasks. Fixture copying and grader execution are real operations.

The Linux probe actually launches Bubblewrap with separate PID/network/user namespaces, empty environment and dropped capabilities, checks its network namespace differs from the host, and checks private mounts/secret environment variables are absent. A missing or failing probe produces `awaiting-environment`, never a score or promotion. Node 24, Bubblewrap, system Python 3 and a preinstalled read-only dependency tree are required. Prepare a curated tree with TypeScript/Vitest and their dependencies; private-file names, nonregular files and package links escaping that tree fail the probe. Package-distributed credential/certificate fixtures must be omitted from that curated runtime. The code never runs package install scripts on the host.

Both parent and candidate run mandatory `tsc -p tsconfig.json` and the frozen tools/context/engine/improvement unit suites through `vitest run` inside Bubblewrap. `MANDATORY_CANDIDATE_TESTS` records the exact immutable list. The formal benchmark replay and publication/site suites require artifacts deliberately absent from candidate mounts; the integration owner runs those full project checks outside this development task protocol. Optional `buildCommands` are **additional** trusted executable argument arrays; they cannot remove these checks. The sandbox mounts a materialized source snapshot without the Git worktree's `.git` pointer. Candidate task execution uses the compiled `candidate-runner.js`, which runs the actual `AgentEngine` and tools with the editable prompt/reflection modules. Tasks have a 20-call broker limit and a 30-minute agent/grade wall limit (a conservative bound on active time). Cancellation uses `killProcessTree`, not a parent-only kill. Logs are bounded and sanitized; scoped-token files and task workspaces are removed after the task.

## Search, evidence and promotion

* Each proposal reads the frozen parent source, allowlisted selected files with exact base hashes, bounded development traces and paired development outcomes. The supplied model must produce structured complete-file edits. Paths, selected modules, duplicate names, file limits, links, base hashes and proposer-strategy bounds are checked before a patch is archived. A detached Git worktree records provenance; the archive contains the parent/candidate source hashes, structured edits, an applicable unified patch, proposal, build evidence and task trace hashes.
* Development-only sanitized traces are persisted in SQLite and retrieved by frozen manifest hash for subsequent proposals. Sealed prompts, grader output and task traces never enter this retrieval path. Validation exposes only paired score metadata/log hashes in the candidate record.
* Fixed selection uses the exact requested module combination. Search uses a 16-dimensional feature vector: intercept, five module indicators and all ten pair interactions. LinUCB stores the full positive-definite covariance matrix and reward vector. Coordinate ascent toggles one module at a time from multiple starts; used optima fall back to coordinate neighbors and then remaining combinations. Only actual development outcomes update the bandit, grouped by frozen development/evaluator hashes.
* The target modules are `tools` (`files.ts`, `search.ts`, `schemas.ts`), `context` (`core/context.ts`), `prompt`, `reflection`, and `proposer`. Process termination, provider routes, persistence, isolation, graders, budgets and contracts are not editable targets.
* `proposer-strategy.json` is a real editable candidate target. Its validated instructions, evidence window, file limit, source ordering and reflection switch are read from the activated parent snapshot for the next cycle. No candidate strategy code is imported on the host. Prompt/reflection source changes affect actual candidate task model requests, rather than being inert labels.
* A score contains schema version, partition, manifest/evaluator/source hashes, and per-task ID, fixture/prompt hashes, resolved flag, authoritative broker input tokens/calls and active time. The comparator requires a paired partition/task/hash set, then compares total resolved tasks, lower input tokens, lower calls, and finally retains the parent on an exact tie. Build failures and uncertain evaluations have no invented score.
* Only the best development winner consumes validation. The validation manifest's seal is inserted **before** either paired validation run. The seal is unique across jobs and restarts; errors/cancellation do not release it. Validation must independently prefer the candidate before it becomes `eligible`. There is no validation-driven bandit update or extra proposal after validation. A new validation dataset requires an independently frozen new manifest.

These implement the requested archive/propose/test loop, joint module search, self-editable source and self-editable proposer mechanisms associated with the plan's Meta-Harness (2603.28052), MESH (2610.05300), SICA (2504.15228), and Hyperagents (2603.19461) references. This is an independent bounded implementation, not an empirical reproduction of their reported results.

## Verification and current limits

`tests/improvement*.test.ts` uses mocked model responses for offline behavioral verification. It covers hostile paths/links, stale hashes, patch applicability, reservations/recovery, fixed/search selection, covariance, partitions, seals, ties, manifests/versions, rollback lineage, actual strategy proposals, owner locks, cancellation and missing-isolation gating. No mock score is used as a live evaluation claim. This Windows worker does not validate real Linux Bubblewrap execution or make live model calls. Linux evaluation and any ERNIE quality claim must be separately recorded by the integration owner.


## Active source execution from CLI/HTTP

`runActive(input): Promise<ActiveRunResult>` is the path for an ordinary authorized coding task after activation. It does not start an improvement cycle or use the proposer. `input` is `{id?, workspace, prompt, expectedSourceHash?, expectedCandidateId?, maxCalls?, maxActiveMs?, signal?}`. Pass the **goal-pinned** source hash and candidate ID when the goal manifest was created; a changed activation returns `ACTIVE_VERSION_MISMATCH` before any budget reservation or model request. A subsequent activation does not change the already verified copy used by an in-flight launch. Existing native goal manifests should continue their native path; only a goal explicitly assigned an active version should call this method.

The method verifies the active source hash and a separate materialization hash covering **source and `dist` build outputs**, checks the runtime Linux probe, stages a bounded workspace snapshot, copies the pinned active source/build, reserves the shared allowance, and invokes `LinuxCandidateSandbox.runAgent`. The candidate source is a read-only `/candidate` mount. Its compiled `candidate-runner.js` runs the actual agent through a scoped broker. User launches have **no evaluator, development/validation manifest, other task, formal benchmark, stable database, shared Git metadata, host credentials or public network mount**. They use `partition: 'user-task'` only in the broker registration metadata and never update module search, trace retrieval or promotion scores.

```ts
const pinned = improvements.active();
if (!pinned) throw new Error('No active harness version');
const controller = new AbortController();
const result = await improvements.runActive({
  id: goal.id, workspace: goal.workspace, prompt: goal.prompt,
  expectedSourceHash: goal.manifest.sourceHash,
  expectedCandidateId: goal.manifest.candidateId,
  maxCalls: Math.min(goal.remainingCalls, 20),
  maxActiveMs: Math.min(goal.remainingActiveMs, 1_800_000),
  signal: controller.signal,
});
// result.usage is confirmed broker usage, never model/candidate self-reporting.
// result.patch is computed by the host from the staged before/after files.
// Apply under the application's existing workspace lease and journaled write intent,
// check every beforeSha256 against the actual workspace first, then run trusted
// user acceptance commands. Never treat process exit 0 alone as accepted correctness.
```

For HTTP, authenticate and resolve the authorized goal/workspace server-side; accept only prompt/bounded launch settings, and bind cancellation to the existing goal controller. For CLI, use the same goal/runtime path and forward SIGINT/SIGTERM to that controller. Do not expose environment config, materialization path, raw executable arrays, callback objects or broker keys as client-controlled fields. The existing supervisor lease and its journal own actual source writes and acceptance commands. `runActive` does not mutate the original workspace: it returns a reviewable patch with `baseHash`, `resultHash`, a patch hash, per-file before/after SHA256 values, complete replacement content (null for deletions), and applicable `unified` diff text. Added files have a null `beforeSha256`.

Supported user workspaces are bounded regular UTF-8 text trees (16 MiB, 4096 files, 1 MiB per file). Git metadata, node_modules, build output, credential files, runtime databases and evaluator/formal directories are excluded; escaping symlinks/hardlinks, binary files or exceeded bounds reject before model dispatch. This is a staging contract; callers must not silently assume excluded files were tested. Native user dependency installation or broader filesystem access is not granted by this API.

`ActiveRunResult.status` is `completed` only when the isolated agent exits 0; it is `failed` with `failureCode: 'AGENT_EXIT_NONZERO'` when the process exits nonzero. **A nonzero exit due to exhausted model calls still returns its valid observed patch and confirmed usage**, if the broker closes cleanly. This permits main to retain partial work and report the goal budget state accurately. It does not mean acceptance passed. Caller-specified trusted user acceptance may run through `baseTools` after patch application under the same goal cancellation; **no separate evaluator manifest is required for ordinary user acceptance**. Improvement promotion still requires its pinned paired evaluators.

All unsafe/incomplete execution paths reject with exported `ActiveRunError`, which includes `runId`, `code`, `status`, and optional broker-confirmed `usage`; it never includes a patch. Charge `error.usage` when present even though no patch is returned. Otherwise use the persistent reservation and reconcile its uncertain effects; do not replay or restore allowance merely because the Promise rejected.

| Code | Meaning | Durable status when a launch record exists |
| --- | --- | --- |
| `INVALID_INPUT` | Invalid/reused ID, prompt or bounds | No launch created |
| `ENVIRONMENT_UNAVAILABLE` | No verified Linux Bubblewrap environment | No launch created |
| `ACTIVE_VERSION_UNAVAILABLE` | No active version with a build pin | No launch created |
| `ACTIVE_VERSION_MISMATCH` | Current activation differs from goal pin | No launch created |
| `ACTIVE_INTEGRITY_FAILED` | Active source/artifact/candidate pin changed | No launch created |
| `PRIVATE_WORKSPACE` | Requested workspace overlaps private state/evaluator | No launch created |
| `WORKSPACE_BUSY` | Another active launch or improvement owns the workspace | No launch created |
| `BUDGET_EXCEEDED` | Confirmed broker usage exceeds requested task bounds | `failed`, confirmed actual usage retained |
| `CANCELLED` | Input signal, `cancel(id)` or service close aborted execution | `cancelled`, with completed or uncertain reservation |
| `NEEDS_RECONCILIATION` | Reserve, broker finish or settlement effects uncertain | `needs-reconciliation`, full reservation retained |
| `EXECUTION_FAILED` | Process, staging, capture, or other runtime failure | `failed` (or no record for an early failure) |

`getActiveRun(id)` and `listActiveRuns()` read durable records with provenance, status, reservation, and completed result. `cancel(id)` covers active launches as well as improvement jobs; using the caller's AbortSignal works from preflight onward. `close()` aborts/drains both kinds. Interrupted preparing/running records recover as `needs-reconciliation`, with unresolved reservations retained and no automatic launch replay. Active tasks own the canonical workspace within the service, in addition to the application's shared supervisor lease.

The shared budget adapter receives `kind: 'active-run'`, `jobId: input.id`, the unique reservation `attemptId`, and the requested call allowance (1–20). This lets main map a pre-reserved native goal allowance to the active launch without double charging. Each active launch uses one shared reservation and one broker trial; both settlement and `finish()` are called at most once. The broker's `maxCalls`/`maxActiveMs` now accept lower task bounds, so a 3-call smoke cannot consume 20 calls.

## Trusted environment factory

`createImprovementEnvironment(config)` constructs the same `LinuxEvaluationEnvironment` accepted by the service constructor and main's `ServiceOptions.improvementEnvironment`. It creates the broker adapter lazily; it does not make a model request or put the runtime key into serializable environment fields.

```ts
const improvementEnvironment = createImprovementEnvironment({
  dependenciesDir: '/opt/ernie-runtime/dependencies',
  development: frozenDevelopmentSuite,
  validation: frozenSealedSuite,
  nodeExecutable: '/opt/node/bin/node',
  bwrapExecutable: '/usr/bin/bwrap',
  broker: {
    stateDir: '/private/ernie/improvement-broker',
    quotaPath: sharedQuotaPath,
    apiKey: runtimeOnlyApiKey,
    socketDirectory: '/tmp/ernie-improvement-sockets',
  },
});
// new ImprovementService({...sharedOptions, environment: improvementEnvironment});
// createService({...serviceOptions, improvementEnvironment});
```

Keep this config on the trusted server/CLI side. Main may instead build it from its trusted `improvement-environment.json` loader and runtime key/shared quota. No core/server edits are needed inside this module.

## Candidate-runner smoke within a ten-call remainder

**Yes: the actual compiled candidate runner can be validated with a tiny real fixture evaluator, without SWE tasks.** `createImprovementSmokeSuite(newDirectory)` creates one task (`answer.txt` starts as `0`, the agent must write `42`) and a real grader which fails before that change and passes after it. The offline configuration test runs the actual grader against both states, without a model request. The suite is for integration smoke only and is never evidence of benchmark quality or grounds for promotion.

On the authorized Linux host, choose at most **3 calls** and **120000 ms** for a single smoke, leaving the rest of the ten-call remainder for main's separately budgeted validation. Do not use `start()` for this smoke: a full paired improvement cycle reserves 20 calls per evaluated task. `LinuxCandidateSandbox.task` accepts explicit smaller bounds and reuses exactly the same `runAgent`, scoped relay, task config and compiled `candidate-runner.js` as `runActive`.

```ts
const suite = await createImprovementSmokeSuite('/private/ernie/tiny-smoke-v1');
const manifest = await loadSuite(suite, 'development'); // exported from evaluation.ts
const sandbox = new LinuxCandidateSandbox(improvementEnvironment);
const proof = await sandbox.verify(signal);
if (!proof.verified) throw new Error('Verified Linux isolation required');
// Pin/verify the previously built materialized candidate before using it here.
// Reserve 3 calls in the same global ledger BEFORE openTrial; never reserve anew
// if the reservation or finish outcome is uncertain.
const trial = await improvementEnvironment.broker.openTrial({
  id: sharedReservation.attemptId,
  maxCalls: 3, maxActiveMs: 120000,
  partition: 'development', signal,
});
try {
  const result = await sandbox.task({
    candidate: verifiedMaterialization,
    suite, manifest, task: manifest.tasks[0],
    stateDir: '/private/ernie/smoke-runs', signal, trial,
    maxCalls: 3, maxActiveMs: 120000,
  });
  // result.resolved is the host-run grader AND agent exit result.
} finally {
  const final = await trial.finish();
  // Settle sharedReservation once with final.usage and final.uncertain.
  // Never report a live pass when final.uncertain, cancellation or a check failed.
}
```

The grader/evaluator is mounted read-only only in the separate grading namespace; the agent sees just its single prompt/workspace and the pinned candidate. A missing probe rejects. This worker has made **zero live calls** and has not claimed that the Linux smoke passed.
