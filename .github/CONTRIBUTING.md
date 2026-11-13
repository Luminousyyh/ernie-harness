# Contributing / 参与贡献

ERNIE Harness is an independent MIT-licensed TypeScript project. Use Node.js 24.9+ and pnpm 10.30.3. Keep changes focused and coordinate shared contract changes; one writer owns a workspace, and parallel contributors must preserve each other's edits.

## Before proposing a change

- Describe the concrete problem and resulting behavior, then include relevant verification evidence.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build`. Do not describe a workflow definition as a passing CI run.
- For site changes, edit `docs/site-content/home.zh.html`, `en.json`, and `sections.json`, run `node scripts/site-build.mjs`, then `pnpm site:qa`. Both checked-in HTML pages must remain readable without JavaScript.
- For behavior changes, cover meaningful failure/recovery cases. Report Windows and Linux evidence separately if only one was run.
- Keep credentials runtime-only. Do not submit keys, service tokens, databases, full traces, SSH material, caches, or model payloads containing private data.
- Keep the model allowlist fixed to `baidu/ernie-5.5-flash-preview:free`; no paid or alternate-model fallback. Count auxiliary calls and retries.
- Report live model evidence separately from mocks, fixtures, offline checks and website demos. Do not run live requests merely to update documentation.

## Evidence and licensing

A performance claim needs a protocol, budget, baselines, sample definition, external acceptance evidence, failures, and uncertainty. Learning/reflection text does not establish success. Candidate changes need current validation and the applicable review before promotion.

Original contributions use the project's MIT license. Preserve upstream notices and do not copy incompatible implementation code or third-party marks. The pinned README layout inspiration and original assets are documented in `docs/user/sources.md`.

## 中文

请说明具体问题、修改后的行为和验证。提交前执行类型、测试、构建；网站修改还需重新生成两种语言并运行浏览器 QA。凭据仅在运行时，固定免费模型与累计预算不变。不要把模拟、历史冒烟、网站动画或未运行的 CI 配置当成真实结果。保持修改聚焦并协调并行工作，尊重来源许可证与标识权利。
