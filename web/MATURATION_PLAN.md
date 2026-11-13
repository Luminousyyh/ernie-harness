# Workbench maturation plan

Scope: `web/**`, `src/i18n/**`, `tests/i18n*.test.ts`, `tests/web-maturation*.test.ts` only. Preserve shared changes.

- [x] Establish shared zh-CN/en dictionaries with placeholder parity and locale resolution tests. Default to zh-CN for existing consumers.
- [x] Add a stable React locale provider, local persistence, race-safe GET/PATCH preference synchronization, locale-aware formatting, and a keyboard-accessible language switch.
- [x] Translate existing UI copy and accessible labels at render time. Keep user/model history and code untouched; preserve mounted pages, draft, focus, scroll, and streams.
- [x] Add Experience and Improvement views using real API data, including editing/reflection, run detail/evidence/candidates, cancel/apply/rollback, extensions, manifest/context inspection, and permission approvals.
- [x] Add goal permission modes and optional manifest to composer. Add checkpoint/branch controls when supported by the service.
- [x] Verify dictionary parity, English/Chinese rendering, APIs, failed persistence, and state preservation. Run typecheck, tests, build, and browser QA without live model calls or editing shared QA scripts.

API: preferences GET/PATCH `{locale}`; memories GET `?workspace=` / PATCH `/:id` `{text?,status?}`; goals POST `/:id/reflect`; improvements GET/POST `{workspace}`, GET `/:id`, POST `/:id/cancel`, `/apply` `{candidateId}`, `/rollback`; extensions GET; approvals GET, POST `/:id` `{decision:'allow'|'deny'}`. Handle response envelopes defensively; do not turn absent responses into success evidence.

Implementation and API details: `web/MATURATION.md`. Manifest capture is owned by the backend; the UI inspects its persisted result.
