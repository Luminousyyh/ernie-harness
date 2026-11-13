# Workbench localization and maturation

Implemented only the assigned web, shared i18n, and web/i18n test files. The existing evidence test now uses React server rendering with the locale provider, retaining its original assertions.

## Files and behavior

- `src/i18n/index.ts`: exported `Locale`, `resolveLocale(value)`, `translate(locale,key,params?)`, `dictionaries`. No browser imports; CLI can reuse it. Supports named ICU interpolation, numbers, plural/select/selectordinal messages; unknown keys and missing parameters remain inspectable.
- `src/i18n/dictionaries.ts`, `src/i18n/maturation.ts`: Chinese/English copy with identical keys and placeholder names.
- `web/src/Locale.tsx`: stable provider, immediate switching, `ernie-locale` local preference, revision-safe GET preferences and serialized PATCH writes, explicit sync-failure status/retry. Default is zh-CN. Updates document language. Changing locale does not recreate the harness or SSE connection.
- Existing React surfaces: translated visible copy, ARIA, placeholders, tool/status labels, local notices, number/date formatting. Historic user/model messages, reasoning, commands, code, manifests and evidence payloads retain their original text. Main pages and inspector remain mounted across navigation; page scroll positions are restored. Reduced-motion transitions are respected.
- `web/src/MaturationViews.tsx`, `maturation.ts`: Experience and Improvement views, record status/evidence helpers, approvals, extensions, manifest/context inspection, checkpoints, DSH supervisor wake/assignment/assessment display and explicit assignment review. UI only presents records actually returned by the service. Applying a candidate requires eligible status, build success, verified isolation, and both comparison sets; the backend remains authoritative.
- `web/src/Composer.tsx`: workspace-scoped plan/standard/trusted permission mode. Manifest is inspected after service capture; the current backend creation schema does not accept a user-supplied manifest.
- `web/src/api.ts`: typed browser transport for the new endpoints. Existing authentication/cookie transport is preserved.

## API integration

- GET/PATCH `/api/preferences`, PATCH `{locale:'zh-CN'|'en'}`.
- GET `/api/memories?workspace=...`, PATCH `/api/memories/:id` `{text?,status?}`. Backend status values are `candidate`, `active`, `disabled`; editor max length is 1600. Text edits may invalidate evidence; the UI does not promise automatic activation.
- POST `/api/goals/:id/reflect`; initiated only by the explicit reflection button, with its model/budget implication shown.
- GET `/api/improvements`: supports `{runs,active}` and earlier array/jobs/improvements envelopes. Detail accepts direct job or `{job,candidates,attempts}`. Activation comes from explicit active/activation data, never from winnerId or job completion.
- POST `/api/improvements` `{workspace}`, GET `/:id`, POST `/:id/cancel`, POST `/:id/apply` `{candidateId}`, POST `/:id/rollback`. Apply/rollback require a concrete confirmation dialog; local state records the returned activation and refreshes authoritative records.
- GET `/api/extensions`: handles actual `{enabled,plugins,mcpServers,skills,agents,diagnostics}` inspection and generic `extensions` rows.
- GET `/api/approvals`, POST `/api/approvals/:id` `{decision:'allow'|'deny'}`. Shows exact saved goal/revision/tool binding and arguments.
- POST `/api/goals/:id/branch`, GET/POST `/:id/checkpoints`, GET `/:id/checkpoints/:checkpointId` preview, POST `/:id/checkpoints/:checkpointId/restore` `{confirm:true}`. Restore requires successful preview and explicit confirmation.
- GET `/api/supervisor`: `{reference,wakes,assignments,assessments,maxWorkers,active}`. POST `/api/assignments/:id/review` `{decision:'accept'|'reject',note}`. Review is labeled as separate from worktree integration; no automatic-merge claim.

## Verification

- `pnpm typecheck` passed.
- `pnpm build` passed.
- Seven web/i18n test files: 48 tests passed, including all previous web state/snapshot/workspace/evidence assertions.
- `node web/browser-maturation-qa.mjs` against Vite at `http://127.0.0.1:5197` passed 21 offline browser checks. Override with `ERNIE_QA_URL`. Uses only intercepted API fixtures and a synthetic stream; this is UI behavior evidence, not live-model evidence. No model requests were made.
- Browser checks include zh-CN default, live switching and reload, late GET races, failed sync, drafts/focus/selection, mounted-page preservation, historical content, conversation scroll, stream buffer and connection identity, memory editing, candidate eligibility/activation/rollback, approval POST, checkpoint preview/restore confirmation, explicit assignment review, actual extension inspection shape, dark theme, and mobile overflow.
- Browser outputs: `web/qa-maturation/report.json` and desktop/mobile PNGs (local ignored artifacts). Shared `scripts/browser-qa.mjs` was not edited.

The full repository suite should be read from the final command output because other workers are integrating concurrently. The earlier run exposed CLI checkpoint-restore and initial-user-message assertion mismatches outside this worker's ownership; those files were preserved.
Final full-suite run: 614 passed, 9 skipped, 3 failed (66 files). The remaining failures are outside Web/i18n ownership:

- `tests/cli-maturation.test.ts:81`: restore request expects `{}` while implementation sends the required `{confirm:true}`.
- `tests/server.test.ts:6`: expects no stored user messages, while goal creation stores the initial prompt.
- `tests/extensions-discovery.test.ts:160`: pending plugin registration fixture has `finish` undefined; it also produced a `Plugin manager is closed` unhandled rejection during cleanup.

All 48 Web/i18n checks passed in the final targeted run. `pnpm typecheck`, `pnpm build`, and the 21-check browser QA also passed. These unrelated suite failures were reported without editing the other workers' files.
