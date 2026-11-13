# Web UI / branding continuation handoff — 2026-11-13

Implemented directly in the shared checkout; no commits or new dependencies.

## Behavior

- Persistent workspace picker, add/edit absolute directories, per-project new conversations. Inactive-workspace editing preserves the active composer directory. Historical goal paths remain visible after a registration path changes.
- New-conversation drafts are retained separately per path during navigation and workspace switching. Follow-up drafts are retained per goal while switching conversations or pages. Continuation explicitly posts `start:true`; rejected writes are not retried automatically and unsent content remains available.
- Existing goal cancellation, busy states and uncertain operations block continuation with Chinese explanations. Server responses remain authoritative for races and validation.
- Theme preferences persist; mobile navigation, keyboard shortcuts, focus restoration, reduced-motion transitions, and transparent SVG branding are present. Vector assets include the mark, light/dark wordmarks and SVG favicon.
- Capabilities distinguish configured high, advertised levels and native historical verification. Empty `verified` does not imply successful native validation. The UI explains service-provided capability provenance in Chinese.
- Current-request context uses `effectiveLimit`, `requestInputTokens`, reply reserve and `remainingTokens`; estimates are labeled. Revision-mismatched snapshots are withheld. Cumulative budget usage remains separately labeled.
- Super-Agent panel shows real parent/dependency/child relationships; creates children using the existing worktree endpoint; starts/pauses children; shows recorded execution checkpoints and model-provided plans. Model plan/checkpoint claims are explicitly separate from independent acceptance evidence.
- Settings identify the dated ERNIE file-edit/test smoke documented in `docs/LIVE_VALIDATION.md`, and Pi success as reported by main. Context-size comparisons and the 144 formal trials remain pending with no optimal-compatibility claim.

## Source paths

Modified: `web/index.html`, `web/src/App.tsx`, `web/src/Composer.tsx`, `web/src/Workbench.tsx`, `web/src/Inspector.tsx`, `web/src/Views.tsx`, `web/src/api.ts`, `web/src/useHarness.ts`, `web/src/styles.css`.

Added: `web/src/WorkspaceControls.tsx`, `web/src/workspaces.ts`, `web/src/useDraft.ts`, `web/src/FollowUp.tsx`, `web/src/ModelContext.tsx`, `web/src/SuperAgent.tsx`, `web/public/ernie-mark.svg`, `web/public/ernie-wordmark.svg`, `web/public/ernie-wordmark-dark.svg`, `tests/web-workspaces.test.ts`, `tests/web-evidence.test.ts`.

QA: `scripts/browser-qa.mjs`. Documentation: this file. Generated browser reports/screenshots and isolated SQLite/worktree runtime directories live under ignored `web/qa-artifacts/`.

## Verification observed

- `pnpm typecheck`: passed.
- `pnpm build`: passed, including the web-specific TypeScript check and Vite production build.
- `pnpm exec vitest run tests/web-state.test.ts tests/web-workspaces.test.ts tests/web-evidence.test.ts`: 23/23 passed.
- `node scripts/browser-qa.mjs --isolated`: 16/16 checks passed with Microsoft Edge. Uses the actual compiled Fastify service, SQLite database and real Git child worktree in a separate runtime directory, with injected offline transport and no model network requests. This is offline behavior evidence only.
- `node scripts/browser-qa.mjs`: 6/6 read-only UI checks against main's existing local service passed; no browser page errors and no model generation. Local auth is exchanged as a cookie without putting the service token in a navigation URL or report.
- The most recent full-suite run observed before the final web-only additions passed 225/226; the remaining failure was `tests/benchmark-python.test.ts:26`, an editable Python path assertion outside this worker's ownership. Earlier capability/context integration failures were resolved by their owners.

## Browser QA modes

`--isolated` runs mutation checks against a real isolated service/data directory with injected transport. Default mode authenticates to the existing service and only navigates/inspects/screenshots. `--fixture` retains an explicitly synthetic API-fixture mode for fast UI debugging. None of these modes performs a live model call. Runtime credentials are not written into reports.

Reports: `web/qa-artifacts/isolated/browser-checks.json` and `web/qa-artifacts/service/browser-checks.json`.

Completion marker: WEB_UI_BRANDING_COMPLETE

## Independent review fixes and ordinary-chat default — 2026-11-13

This follow-up supersedes the earlier verification counts above.

- GoalDetails is keyed by goal ID, so reconciliation text never carries from uncertain goal A to B.
- HTTP state/detail and mutation results merge against per-goal SSE watermarks captured at request start. State HTTP requests also have ordering guards; older revisions/timestamps cannot regress a newer goal. Newly created goals received by SSE survive an older state response.
- Follow-up completion clears only the submitted content for its original goal. Text edited while the request is pending and drafts for other goals remain intact.
- A closed mobile sidebar uses `inert` and `aria-hidden`; resize updates restore desktop interactivity. The open drawer's keyboard trap includes its workspace select.
- New conversations default to `supervised:false`. Mode labels are `普通对话` and `Super-Agent 持续目标`; mode/page changes preserve the draft. Super-Agent's acceptance requirement remains in effect.
- Main's ModelContext Chinese/Pi wording and missing-context message were preserved.

Changed source paths in this follow-up: `web/src/App.tsx`, `web/src/Composer.tsx`, `web/src/FollowUp.tsx`, `web/src/Inspector.tsx`, `web/src/useHarness.ts`, new `web/src/snapshots.ts`, new `tests/web-snapshots.test.ts`, and `scripts/browser-qa.mjs`.

Verification: `pnpm typecheck` and `pnpm build` passed. Full `pnpm test`: **240/240 tests, 29/29 files passed**. Web tests: **28/28 passed**. Edge `node scripts/browser-qa.mjs --isolated`: **22/22 checks passed**, including actual HTTP/SSE races, A→B reconciliation, pending-submit edits across goals, ordinary/Super-Agent semantics, 30 closed-drawer Tab steps, open drawer interaction and desktop resizing. This run used a separate service/data directory and offline injected transport; no live model calls occurred. No commits were created.

Completion marker: WEB_REVIEW_FIXES_COMPLETE

## HTTP mutation / old-state race follow-up — 2026-11-13

- `mergeServiceSnapshot` now retains every previously observed goal omitted from an incoming response. The current API has no delete/archive operation, so an omitted row is not deletion evidence.
- `useHarness` tracks a separate local mutation generation and per-goal HTTP mutation watermarks. State/detail requests capture the local generation at dispatch; responses cannot overwrite goals updated by a successful HTTP mutation after that request began. These generations remain separate from SSE sequence numbers.
- The actual-hook Edge regression holds SSE and a pre-create `/api/state` response, completes conversation create/start/detail through real HTTP endpoints, then releases the old response and checks that the selected conversation and sidebar row remain. A second case checks child create/detail under the same ordering.
- Unit regressions also cover equal-revision/equal-timestamp local updates and fresh/unrelated responses.
- Main's ModelEvidence and all visual UI files were left unchanged in this follow-up.

Changed: `web/src/snapshots.ts`, `web/src/useHarness.ts`, `tests/web-snapshots.test.ts`, `scripts/browser-qa.mjs`, and this handoff note.

Verification: `pnpm typecheck` and `pnpm build` passed; web tests **31/31** passed; full repository tests **246/246** across **29 files** passed; isolated Edge QA **24/24** passed. All browser mutations used isolated service/data and offline injected transport; no live model calls or commits.

Completion marker: WEB_HTTP_SNAPSHOT_RACE_FIXED

## Long-session detail cursor — 2026-11-13

Added optional `GoalDetail.eventCursor`. `hydrateThread` now sets its watermark to `max(eventCursor ?? 0, parsed.lastSeq)` before replaying buffered events. Backend responses without the field retain the previous fallback. The global SSE loop was not changed.

New regressions cover a 5000-event tail (1001–6000), authoritative cursor 6001, full persisted message history, ignoring buffered messages at/below the cursor, replaying later messages, retaining recent tool/plan events, and refusing to regress to an older supplied cursor. The duplicate-message tests were observed failing before the change.

Changed source/tests: `web/src/api.ts`, `web/src/state.ts`, `tests/web-state.test.ts`. Verification: web tests **34/34**; full suite **250/250**, **29 files**; typecheck and production build passed. No live calls or commits.

Completion marker: WEB_DETAIL_CURSOR_COMPLETE
