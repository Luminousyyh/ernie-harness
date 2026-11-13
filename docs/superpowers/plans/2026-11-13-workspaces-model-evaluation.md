# ERNIE Harness continuation implementation plan

> **For agentic workers:** Use subagent-driven-development; preserve concurrent changes.

**Goal:** Deliver persistent workspaces and conversations, honest model/context controls, refined UI and resumable fair evaluation.
**Architecture:** SQLite-backed workspace/session service; existing serial supervisor and event journal; browser consumes HTTP/SSE. Separate evaluation worker shares the single remote quota ledger.
**Tech Stack:** Node 24, TypeScript, SQLite WAL, Fastify, React/Vite, pnpm.
**Spec:** User-approved continuation plan, 2026-11-13.

## Global constraints
Only baidu/ernie-5.5-flash-preview:free through free Baidu; no credential exposure; one writer per workspace; no uncertain-effect replay; count all retries and auxiliary calls. Existing uncommitted project is the authorized work area; do not move or discard it.

## Review focus
Existing databases migrate without loss; paths must be absolute existing directories; changing selected workspace cannot rebind historical goals; reasoning choices reflect verified route support; context remaining uses current request rather than cumulative usage; evaluator never exposes oracle tests or secrets.

## Tasks
- [x] Workspace/session backend (main): add Workspace persistence and selected workspace, POST /workspaces, PATCH /workspaces/:id, POST /workspaces/:id/select; GET /state extends existing fields. Validate/canonicalize paths; create and continue multiple goals per workspace. POST /goals/:id/messages appends user input and invalidates old completion evidence; immutable cancelled goals. CLI workspace operations call same endpoints. Test persistence, path validation, busy-state rejection and continuation.
- [x] Model/context (worker): optional reasoningEffort=high in ModelRequest/GoalInput/Goal, capability inspection, truthful current context estimate/last usage and compaction status via Goal.context. Current route only high until additional explicitly advertised and live-validated levels exist. Keep benchmark high. Tests for context accounting and route failures.
- [x] Web/branding (worker): use workspace APIs and optional state extensions; add per-project new conversation, workspace picker/edit, continuation; model capability and context displays; Super-Agent dependencies/children/checkpoints UI; SVG branding and smooth state-preserving navigation. Browser checks for mobile/theme/keyboard/reduced motion.
- [ ] Evaluation (worker): repair pinned DSH build and smoke; complete >=30 eligible and freeze paired split; safe Python mounts and evaluator paths/resource locks; real resumable development context selection then 144 formal trials. Preserve quota and evidence; never invent tuning or outcomes. Tests and remote status.
- [ ] Integration: typecheck, behavioral tests, production build; remote Linux test suite; browser inspection and actual free-model continuation/recovery where quota permits. Independent review, fix findings, publish evidence and pending experiment counts.


## Review ledger
- Main workspace/session tests cover canonical paths, duplicate registration, independent goals, persisted selection, continuation, immutable cancelled state and busy/uncertain rejection.
- Review finding fixed: cancellation/revision interleaving is terminal; atomic revision commits transcript/outbox/evidence together; child snapshots share canonical workspace ownership with scheduler and continuation. Failure-injection and overlapping-control regression tests passed.
- Ruling: preserve this existing uncommitted workspace instead of creating a checkout that would omit all source files; changes remain directly reviewable here.

- Model review fixes: retain all authoritative user messages across repeated compaction; track input/output/reasoning estimation separately. Native restart/continuation succeeded using7 shared calls,14,018input,421completion tokens; test fixture remained unchanged.

- Integration validated: Windows277pass+1Linux-onlyskip, Linux278pass; actualmodelrestart7calls, supervisedplan3calls, nativeWebcontext1call. Execution3,711files frozen; pairedexperiment workerreleased andwaitingquota (16remaining<20required),18development+144formal stillincomplete. Code/durableorchestration delivered; full empirical objective remains pending externalquota/time.
