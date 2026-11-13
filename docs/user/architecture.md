# Architecture and ownership

[简体中文](architecture.zh-CN.md) · [Usage](guide.md)

ERNIE Harness is an independently implemented TypeScript harness. The system defaults to one writer per workspace. Contracts cannot import implementation modules, and browser code communicates through HTTP/SSE rather than handling model credentials.

| Owner | Responsibility | Boundary |
| --- | --- | --- |
| `src/contracts` | Shared goals, tools, events and evidence types | Data contracts; no implementation imports |
| `src/provider` | OpenRouter transport, route policy, credentials, quotas and usage | Only the designated free ERNIE model; credentials stay in the runtime |
| `src/tools` | Workspace files, search, edits, process execution and diffs | Path checks, bounded output and secret redaction; local shell remains trusted |
| `src/core` | Model/tool rounds, context, plans and completion handling | Evidence and budget checks before terminal transitions |
| `src/store` | SQLite state and event records | Persist intent before effects; preserve uncertain outcomes |
| `src/supervisor` | Durable scheduling, dependencies and isolated worktrees | Shared budgets and one writer per workspace |
| `src/server`, `src/cli`, `web` | Service, terminal and UI | HTTP/SSE projection; never model secrets in UI state |
| `src/learning` | Partitioned experience, evidence links and auxiliary attempts | Integration in progress; memory is untrusted advice |
| `src/extensions` | Skill context, MCP transports and trusted plugin contracts | Explicit configuration and attributed output; plugins are not sandboxed |
| `src/improvement` | Candidates, isolated validation, evaluations and archives | Candidate-specific acceptance, protection checks and reversible decisions |
| `src/runtime` | Permission/checkpoint policy under integration | The presence of a policy type is not a passed behavior gate |

## A task round

1. Load the goal revision, workspace, allowed tools, current permissions and cumulative budget.
2. Build context with attributed sources. Keep estimated request size separate from measured usage.
3. Reserve budget before a provider request, then persist the actual response and usage.
4. Journal tool intent before changing the workspace; record the result, including failures and uncertain effects.
5. Run independent acceptance for the current revision and workspace before marking supervised work complete.

A restart must reconcile a recorded intent whose outcome is uncertain. Repeating an interrupted mutation without checking the actual effect can corrupt state. Pause stops new scheduling and retains the journal. Acceptance evidence must not be inferred from a reflection, model-authored checkpoint, or historic result for another revision.

## Improvement around the task engine

The new learning/extension/improvement modules are being integrated in parallel. They surround the existing task engine rather than changing the allowed model, ownership, credential, or journal boundaries. The intended sequence is observation → candidate → bounded validation → explicit decision. Review the current implementations and [mechanism mapping](../research/harness-learning.md); no cross-task benefit or completed live campaign is claimed here.

## Deployment and evidence

The local application is a trusted-user tool, not a multi-tenant code sandbox. The formal benchmark has separate remote Linux/Bubblewrap and broker boundaries. The static website is independent of both: checked-in HTML/CSS/JS, no model access, no credential collection, no visitor tracking. Its browser tests establish presentation behavior, not agent capability.
