# Live maturation validation — 2026-11-13

This is bounded Linux integration evidence for the independent ERNIE Harness maturation revision. It does not establish benchmark quality, successful self-improvement, DSH superiority, or production deployment.

## Remote revision and constraints

- Source root: `/home/home_new/yaoyh/ernie-harness/versions/maturation-20261113`.
- Node: `/home/home_new/yaoyh/ernie-harness/runtimes/node-v24.13.1-linux-x64/bin/node` (24.13.1).
- pnpm: `/home/home_new/yaoyh/ernie-harness/runtimes/pnpm-tool/node_modules/pnpm/bin/pnpm.cjs` (10.30.3).
- Source snapshot and file hashes: `artifacts/maturation/source-manifest.json`; archive hash: `artifacts/maturation/archive.json` in the local checkout.
- Validation processes use eight available CPU cores, a systemd user scope with `MemoryMax=16G` and `MemorySwapMax=0`, and no GPU.
- The existing frozen root source/build/evaluation queue was not edited or restarted.
- Model: `baidu/ernie-5.5-flash-preview:free`, provider Baidu only, high reasoning; native `OpenRouterTransport`, no alternate model or mocked completion.
- Authoritative shared quota: `/home/home_new/yaoyh/ernie-harness/eval/private/broker/broker-quota.json`; never reset or replaced.
- Runtime credential is loaded only in the service process from the existing private credential file. It is absent from command arguments, fixtures, source, reports and the tool namespace.

## Observed live result

The live repair, one reflection, and a separate-process restart continuation passed. Exact live snapshot hash: `e268a704fdc20fa90eb6405d1d0493562dfc5ed5688e7560bca3989de1c38974`.

Evidence directory: `artifacts/maturation/live-2ff93846-c4af-45a2-b0d7-6ed5c339f2ff` under the remote revision and the local shared worktree. `report.json` contains the initial/continued goal states, manifests, evidence, usage, native model attestation and reflection events. The directory also contains filtered events, transcript messages without private reasoning fields, the unchanged acceptance fixture, quota snapshots and the separate process log.

The task initially failed a real `node --test` check because `add(a,b)` returned `a-b`. ERNIE used the normal file tools to change it to addition. The acceptance tests check positive, negative and zero operands. The test file's SHA-256 remained unchanged. Shell/test commands ran inside Bubblewrap; file tools remained bound to the authorized task workspace.

The service then completed exactly one model reflection using the goal's remaining explicitly extended budget, closed its SQLite-backed service, and spawned a new Node process. That process reopened the same state, loaded the persisted conversation and project memory preparation, continued the goal to the next revision, and obtained fresh passing acceptance evidence. This is a graceful process restart, not a crash/kill recovery test. The reflection created one active evidence-linked memory. The restarted process loaded that entry and prepared 648 bytes of memory context at revision 1. After continuation advanced the same goal to revision 2, revalidation removed the old revision-specific evidence from the actual continuation preparation. The continuation therefore proves persisted transcript recovery and conservative memory revalidation, not reuse of that memory in the revision-2 model request.

**The successful original proof used six requests (40 → 46). A later validation-driver launch error consumed four additional requests (46 → 50). Total actual usage by this worker is ten requests; zero shared requests remain.** This exceeded the eight-request cap and violated the requirement to preserve two requests. The ledger was not reset or refunded. No model-proposed source improvement was completed.

The coordinating worker subsequently authorized up to two additional requests for one actual proposal. While preparing that mode, a local patch failed because the command lacked the shared working directory. The command chain continued and launched the old remote driver with the unsupported `--proposal` argument. The old driver accepted unknown arguments and fell through to another ordinary repair smoke. It used four requests, repaired the simple fixture again, then stopped at the next allowance check. That accidental run is retained under `artifacts/maturation/live-9ea1bdb3-f20c-496e-a10b-9d3b3acedd92`; its overall `passed` flag is false. It provides no improvement-proposal or evaluation evidence.

The driver now rejects empty/unknown mode arguments before loading the credential or reserving quota. A new repair requires explicit `--repair-smoke` and a worst-case six-request envelope below the shared usage ceiling of 48. `--proposal` was exercised after this guard change and exited 1 without changing the ledger. No further real model request was made after quota reached 50.

## Actual isolation proof

Both the product `LinuxCandidateSandbox.verify()` probe and the ordinary shell namespace probe passed in the live report. The ordinary shell probe recorded a different network namespace from the host, a mounted `/workspace`, an environment without credential names, and invisibility of the credential, quota ledger, service state and frozen root `src`, `dist` and `eval` paths.

The pnpm install contains hardlinks and an external workspace link (`.pnpm/node_modules/ernie-workbench`). The candidate dependency verifier rejected that original tree. A separate `.ernie/maturation/dependencies` copy uses ordinary copied files and preserves only internal links; the external workspace link is omitted. `artifacts/maturation/dependency-copy.json` records this preparation. The smoke did not weaken the product verifier.

## Linux commands and evidence

Run `python scripts/linux-maturation-qa.py snapshot` in the shared checkout to build the allowlisted archive. It includes the current source, package/lock/workspace configuration, tests, documentation, and four public `eval` helpers/fixtures referenced by the tests. It excludes runtime state, credentials, queues, node_modules, generated builds and QA media.

On the authorized Linux revision, `python3 scripts/linux-maturation-qa.py linux` runs `pnpm install --frozen-lockfile` followed by `pnpm check`. Inspect `artifacts/maturation/linux-qa.json`, `install.log` and `check.log` for the latest exact source hash and exit codes. The standalone build used for the live proof is also recorded in `standalone-build.log`.

Earlier failures remain evidence: the first driver used a virtual-address cap, which prevented WebAssembly reservation before tests; it was replaced by the cgroup memory cap. Another snapshot omitted public Python helpers and a sanitized DSH event fixture; the source allowlist was corrected. Before the final source delta, two tests still expected the old pending-message/checkpoint-confirmation contracts. These are recorded in the archived logs and are separate from live model evidence.

Offline/scripted tests and the sanitized DSH sample are never counted as actual model requests or proof of DSH execution in this validation.

## Final offline result

The first synchronized full Linux check passed on source hash `cc25662741257306ef9524598ab128ede6f7383cd0f78f780ebcea89cbf983d6`: frozen-lockfile install exit 0; `pnpm check` exit 0; **625 tests passed and one skipped**; production build passed. That report is preserved locally as `artifacts/maturation/linux-qa-first-pass.json` and remotely in `artifacts/maturation/first-passing-check/`.

The latest full check used source hash `b509cec7084490db6d010e00920473cb79c4d751c8c6436ef2a856774bb8ea36`: install and typecheck passed; **624 tests passed, one failed, one skipped**, so `pnpm check` exited 1 and its build phase did not run. The failure is `tests/extensions-plugins.test.ts:109`, “revokes late registration handles and still disposes cleanup returned after a timeout”: the remote fixture timeout was raised to 1000 ms while the test registration delay remained 160 ms, so it resolved rather than rejecting. A focused rerun also failed (10 passed, one failed), recorded in `plugin-timeout-recheck.log`. The current local fixture has returned to 100 ms, but that local correction was not resynchronized or retested by this worker after the coordinator requested immediate closeout. `artifacts/maturation/linux-qa.json` and `check.log` reflect the latest failing run. Main owns the final source sync/check.

The validation argument guard was verified independently: unsupported `--proposal` exited 1, its rejection message matched, and the quota ledger SHA-256 was identical before and after with 50 requests used (`unknown-mode-proof.json`). No model request, queue restart or additional validation driver was scheduled after closeout instructions.


### Final source rerun

The final synchronized source `b0458fe2f0dd0786450ec2b03104301049864fc197cc9b472d8574a420ebabc2` passed frozen-lockfile installation, typecheck, **626 tests / 1 skipped**, and production build. Evidence: `artifacts/maturation/linux-qa-final.json` and `check-final.log`. This supersedes the transient timeout-fixture failure in the intermediate snapshot; the unsuccessful intermediate records remain archived. No additional live calls were made for this rerun.
