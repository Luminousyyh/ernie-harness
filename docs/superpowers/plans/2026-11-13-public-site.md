# ERNIE Harness public site implementation plan

**Goal:** Publish the repository under MIT and deploy a polished static Chinese product website to GitHub Pages.
**Approach:** Execute inline. User has authorized public visibility and publication. Use main:/docs Pages deployment; do not change frozen remote experiment execution.

1. License and publication metadata: create LICENSE, set package.json license, explain upstream/branding exceptions in README and THIRD_PARTY. Recheck committed data/credentials before visibility change.
2. Static website: docs/index.html semantic sections with relative local assets; docs/site.css responsive dark design/reduced motion; docs/site.js accessible tab/panel, mobile menu, copy and flow interactions. Include model/provider constraints and dated evaluation snapshot without performance ranking.
3. Validation: add a bounded browser QA entry point for real page behavior, screenshot desktop/mobile, inspect visual output, run pnpm check. Record meaningful failures and fix them before publication.
4. Publish: commit/push reviewed files, set repository public, configure Pages source main:/docs and repository homepage. Verify public repo/MIT, Pages build and HTTP/asset accessibility. Report URLs and limits.

Review focus: project-path relative URLs, keyboard tab semantics, no-JS content visibility, clipboard failure, mobile menu closure, honest demo/benchmark claims, third-party notices.

Ruling: Keep existing checkout because only static docs/metadata change and no uncommitted edits exist. Preserve remote experimental source/freeze. No new model calls are needed.
