# Harness learning: mechanisms and evidence

Updated November 13, 2026. [中文概览](#中文概览) · [Maturity gates](../maturity.md)

## Current status

The repository now contains learning, extension, runtime, and improvement modules under active parallel integration. Their presence establishes an implementation surface, not a passing integrated system or measured improvement. This document is deliberately conservative until the owning implementation, offline checks, and separately authorized live evaluation are reviewed together. No live call was made to author or test this documentation.

## Mechanism map

| Inspiration | Mechanism used in this harness | Inspect the owning source | Still needs evidence |
| --- | --- | --- | --- |
| ACE | Attributed experience entries; scope/partition boundaries; candidate vs active status; retrieval and curation | `src/learning/types.ts`, `database.ts`, `safety.ts` and current learning service | Correct selection/curation on independent live tasks, ablation and held-out benefit |
| Reflexion | A structured reflection document with deltas linked to observed failure evidence; auxiliary-attempt state and budget reservations | `ReflectionDocument`, `LearningAttempt`, `BudgetMarker` and learning integration tests | Reflection quality, actual attempt accounting, no self-assessment promoted as independent success |
| Meta / MESH | Separate task state from improvement state; search over candidates; archive evidence and explicit decisions | `src/improvement/search.ts`, `evaluation.ts`, `archive.ts`, `types.ts` | Reproducible search budget, candidate identity, independent acceptance and no contamination |
| SICA | Candidate coding changes in an isolated repository with inspectable patch and validation | `src/improvement/repository.ts` and current service/security tests | Protected paths, truthful test results, cancellation/restart behavior and authorized promotion |
| Hyperagents | Make the improvement procedure inspectable; preserve procedure/candidate versions and rollback rather than unjournaled self-modification | Improvement candidate/search/archive contracts and repository controls | Evidence that any allowed procedure change obeys the same protections and improves held-out behavior |

These labels describe mechanism-level inspiration, not full reproductions or product endorsements. Primary-source HTML titles and mechanisms were checked on 2026-11-13: Meta-Harness: End-to-End Optimization of Model Harnesses (arXiv:2603.28052v1), MESH-Harness: Self-Improving Agent Harnesses via Bandit-Guided Compositional Evolution (arXiv:2610.05300v1), and HyperAgents (arXiv:2603.19461v1). Mechanism adoption is an independent implementation; no numerical reproduction is claimed.

## Verified primary-source identifiers

- **Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models**, arXiv:2510.04618 — https://arxiv.org/abs/2510.04618. Context evolution motivates candidate extraction and curation; it does not establish a result for this implementation.
- **Reflexion: Language Agents with Verbal Reinforcement Learning**, arXiv:2303.11366 — https://arxiv.org/abs/2303.11366. Verbal feedback can inform later attempts; it is not a substitute for an external acceptance check.
- **A Self-Improving Coding Agent**, arXiv:2504.15228 — https://arxiv.org/abs/2504.15228. Candidate code modification and evaluation motivate isolated improvement; the paper's results are not inherited by this harness.

The identifiers and titles above were checked against the corresponding arXiv abstract records on November 13, 2026. This is a design-source list, not a systematic literature review. Detailed numerical claims require reading and citing the relevant primary passages separately.

## Required invariants

1. Every entry or reflection links to its source task, revision, partition and evidence; untrusted advice cannot override higher-priority instructions.
2. Reserve and record every auxiliary provider attempt before dispatch, including retries and uncertain outcomes. Reflection/curation/improvement calls use the designated model and applicable cumulative budgets.
3. Development, production and formal partitions cannot leak held-out answers, hidden graders or previous formal solutions into task context.
4. Candidate and active status remain distinct. Model-written success text cannot establish acceptance or promotion.
5. A patch candidate is tied to a base revision, isolated workspace, patch identity, current tests and an explicit decision. One writer owns each workspace.
6. Candidate application/rollback must journal effects and reconcile uncertain interruptions. A failed gate retains a candidate or rejects it rather than silently applying it.

## Evidence to collect

Offline behavior tests should cover retrieval scope, deduplication, attribution, edits/disable, malformed reflections, secret redaction, persistent reservations, interrupted dispatch, protected paths, stale candidate evidence, validation failure, apply and rollback. Existing tests are inspectable evidence only after their current run passes.

Live evaluation must separately establish: provider/tool interoperability; budget and usage accounting; failure-to-reflection-to-retrieval behavior on independent tasks; candidate execution in isolation; an acceptance decision linked to the right revision; and an improvement comparison with fixed budgets and contamination checks. Report all failures, auxiliary calls, retries, incomplete cases and uncertainty. No such completed live campaign is claimed here.

## 中文概览

ACE 对应带来源的经验候选、分区、检索与整理；Reflexion 对应失败证据关联的文字反思与辅助调用账本；Meta / MESH 对应任务执行和改进搜索分离、候选归档；SICA / Hyperagents 对应隔离候选补丁、改进过程版本与回滚机制。这些模块正在集成，不能把类型、文件存在或模拟测试当作真实学习收益。2026-11-13 已核对 Meta-Harness（2603.28052v1）、MESH-Harness（2610.05300v1）与 HyperAgents（2603.19461v1）的原始 HTML 标题和方法；本项目独立实现相关机制，不声称复现论文数值结果。真实模型验收与正式比较仍待完成。


## Verified primary-source index / 已核对原始资料

| Paper | Version | Mechanism used | Primary source |
| --- | --- | --- | --- |
| SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering | 2405.15793v3 | File/search/edit feedback and error recovery | https://arxiv.org/html/2405.15793v3 |
| Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models | 2510.04618v1 | Generator / Reflector / Curator, incremental deltas | https://arxiv.org/html/2510.04618v1 |
| Reflexion: an autonomous agent with dynamic memory and self-reflection | 2303.11366v1 | Evidence-linked text reflection | https://arxiv.org/html/2303.11366v1 |
| Meta-Harness: End-to-End Optimization of Model Harnesses | 2603.28052v1 | Source, scores and full candidate trajectory archive | https://arxiv.org/html/2603.28052v1 |
| MESH-Harness: Self-Improving Agent Harnesses via Bandit-Guided Compositional Evolution | 2610.05300v1 | Role-specific modules, full-covariance LinUCB and coordinate search | https://arxiv.org/html/2610.05300v1 |
| A Self-Improving Coding Agent | 2504.15228v1 | Agent-generated own-source patches evaluated externally | https://arxiv.org/html/2504.15228v1 |
| HyperAgents | 2603.19461v1 | Editable proposal strategy and separate improvement-quality evaluation | https://arxiv.org/html/2603.19461v1 |

Retrieval date: November 13, 2026. Bounded title/section/keyword retrieval; this is an implementation-oriented source selection, not an exhaustive systematic review. Implemented mechanisms, offline tests, live integration and measured quality gains are distinct evidence categories.
