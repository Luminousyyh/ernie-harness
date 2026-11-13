# ERNIE Workbench implementation plan

**Goal:** A usable Chinese workbench for the existing local harness API.
**Architecture:** Typed HTTP client; per-goal event reducer; React layout with project navigation, chat, and inspector. Snapshot hydration reconciles live events without replaying messages. Original logo and restrained white/navy/blue styling, responsive drawers, persistent theme.
**Tech stack:** React, Vite, TypeScript, lucide-react, CSS.
**Spec:** Approved task and ../docs/API.md; ../src/contracts/index.ts.

## Constraints
Own web/** and tests/web* only. Do not modify shared contracts or manifests. Use only the configured ERNIE model; no fabricated activity, statistics, experiment results or credentials. No raw HTML markdown rendering. Preserve other workers' files.

## Review focus
- Interleaved goals and replayed SSE events must not mix text or duplicate messages.
- A snapshot arriving during streaming must preserve newer events.
- Partial create/start failure must preserve the already created goal.
- Auth fragment must be removed and never persisted; 401 must be recoverable.
- Offline, empty, mobile, dark and missing-provider states must be useful.

## Tasks
- [ ] Add behavior tests for event hydration, cursor duplication, safe links and goal input normalization; observe failures, implement reducer and client.
- [ ] Build sidebar, welcome/composer/chat, inspector, goal management, experiments, settings and authentication. Configure web-only type checking in Vite build.
- [ ] Run web tests and TypeScript/build checks. Check real contracts as other modules arrive. Report local evidence separately from live model validation.

UI design is already approved by the task; no additional style decision is required.
