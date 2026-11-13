# ERNIE Harness maturation implementation — 2026-11-13

Approved scope: independent core, full coding/permissions/session recovery, Skills/MCP/plugin SDK, embedded ACE/Reflexion/Meta-Harness/MESH/SICA/Hyperagents, bilingual CLI/Web/docs/site and real verification.

## Work ownership and checklist
- [ ] Core integration: manifest, migrations, hierarchical budgets, permissions, message boundary, branching/checkpoints, HTTP APIs (main).
- [ ] Evidence-linked learning + one-call reflection (learning worker).
- [ ] Skills/MCP + independent extension SDK (extensions worker).
- [ ] Durable isolated improvement + module search and promotion (improvement worker).
- [ ] Full Web localization + experience/improvement/approvals views (Web worker).
- [ ] README/docs/static bilingual website + CI (site worker).
- [ ] CLI/TUI + installation QA (terminal worker).
- [ ] Integrated tests, live ERNIE, Linux/browser QA, review and publication.

## Invariants
Only baidu/ernie-5.5-flash-preview:free and free Baidu route; runtime secrets only. Existing frozen evaluation source/queues untouched. All model calls and retries share persistent allowance. Uncertain effects never replay blindly. One writer per canonical workspace. New work uses separate revision/batch and data partitions. Stable activation is explicit. Missing isolation prevents candidate execution.

## Execution notes
Working checkout: managed ernie-maturation worktree on codex/ernie-maturation. Parent checkout retained. Six workers have disjoint write sets; main alone owns contracts, server, core, store and package metadata.
