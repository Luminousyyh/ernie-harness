# Implementation plan and ledger
- [x] Approve design; create repository and shared interfaces.
- [ ] Provider worker: free-only stream transport, reasoning, quota, credentials, tests.
- [ ] Tools worker: confined file operations, shell/process tree, cancellation, tests.
- [ ] Main: SQLite journal, agent loop, supervisor, HTTP/SSE, CLI, integration.
- [ ] Web worker: Chinese workbench, accessibility, streaming and controls.
- [ ] Eval worker: remote runtimes, sandbox, baseline configs, qualification, queue.
- [ ] Main/reviewer: real-model smoke, UI visual QA, full tests, review.
- [ ] Freeze and run144trials within free quota; preserve/report pending state.
Ruling: empty project is already isolated; initialize standalone Git, no extra worktree.
Ruling: native node:sqlite avoids native builds and provides transactions/WAL.
Ruling: userland remote setup only, no sudo/system packages and zero GPU for API evaluation.
