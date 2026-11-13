# Maturity gates / 成熟度门槛

Status as of November 13, 2026: **integration and validation; not declared mature**. / **集成与验证中，尚未宣称成熟。**

This is a gate definition and honest status ledger. A checkbox is not a result. Attach current commit, command, environment, timestamp, exit status, and evidence before marking a gate passed. Historical runs apply only to their original revision.

| Gate | Required evidence | Current publication status |
| --- | --- | --- |
| Core integrity | Current typecheck, behavior tests and build; fixed model policy; counted auxiliary/retry calls; journal and writer invariants | Must inspect the current revision's verification record |
| Windows + Linux | CI or equivalent native runs, including cancellation, recovery and process behavior | Workflow configured; execution results must be inspected |
| Learning | Scope/partition, attribution, candidate promotion, retrieval and persistent budget tests; independent live task evidence | Modules in integration; live benefit pending |
| Extensions | AGENTS/skills discovery, plugin trust/collisions/disposal, MCP failures/timeouts/redaction; live interoperability separately | Modules in integration; live interoperability pending |
| Improvement | Isolated candidates, current patch/base identity, protected paths, validation, apply/rollback and interruption recovery | Modules in integration; live end-to-end acceptance pending |
| Product surface | Real CLI/Web tasks, permissions, branches/checkpoints, localization and recovery checks | Integration in progress; actual workflow recording pending review |
| Documentation/site | Real zh/en HTML, reciprocal metadata/anchors, responsive/no-JS reading, accessible controls, attribution and package checks | Check local report and CI for the current commit; website QA is not model evidence |
| Live model | Designated free route only; requests, retries, auxiliary calls and usage recorded; successful tool/task acceptance | New maturity validation pending; old smoke notes do not satisfy this gate |
| Formal comparison | Fixed protocol, external acceptance, independent trials, contamination checks, complete accounting and failures | 144-trial formal comparison not completed; no performance ranking |

## Publishing rules

The site and READMEs must say “integration/validation” until the relevant gates pass. A model self-report, fixture, simulated response, manifest, queue-empty observation, interface animation or historic result cannot close a live gate. Never report a test workflow definition as a passing CI run. Public screenshots must disclose demo data; only actual recordings may be called product recordings.

The website retains a specifically dated November 13, 2026, 13:19 CST (UTC+8) evaluation snapshot linked to its source. It is neither live nor evidence for the new mechanisms. Do not extrapolate its development trial counts to formal completion.

## 中文说明

成熟度需要对应版本的类型、行为、构建、Windows/Linux、学习、扩展、改进、产品界面、文档和真实模型证据。离线通过不等于真实收益，历史冒烟不等于新版本验收，正式比较必须有独立外部验收。当前没有“已成熟”“性能领先”或“正式比较完成”的结论。实际运行结果由后续审查记录补齐，不能用预期结果填表。


## Verified delivery snapshot / 已核验交付快照

November 13, 2026: Windows `pnpm check` passed **618 tests / 9 skipped**, typecheck and production build; Linux snapshot `b0458fe2f0dd0786450ec2b03104301049864fc197cc9b472d8574a420ebabc2` passed **626 tests / 1 skipped**, typecheck and build. Product browser regression passed 24 checks; bilingual feature browser QA passed 21 fixture checks; bilingual static-site QA passed 65 checks. Package archive and fresh-directory, network-blocked bilingual CLI help checks passed. Defined GitHub Actions jobs are not reported as executed CI.

Real ERNIE repair, unchanged acceptance tests, one reflection and a separate-process restart continuation passed on the recorded live snapshot; see [live evidence](LIVE_MATURATION.md). Learning benefit, a fully scored self-improvement candidate, and the 144 formal comparisons remain incomplete. A quota-gated, at-most-one-call proposal is independently queued; its result will be a proposal, not a ranking or promotion. The source/compiled version and all model usage remain traceable.
