# Super-Agent 与会话执行

本工程的 Super-Agent 是围绕项目目标的持久执行器。SQLite 保存目标版本、依赖、预算、工具意图、结果、验收证据和待执行队列。CLI 与 Web 调用同一个服务；关闭页面不等于取消后台目标。

## 执行与恢复

目标从 pending 进入 running，完成工具往返后执行验收命令。只有当前目标版本、工作区指纹和验收结果一致时才记录 verified 完成。普通对话没有验收命令时可以结束回答；持续模式缺少验收命令会停在 waiting-input，不宣称项目通过验收。

每个工具先记录意图，再执行，再保存结果。服务异常中断后，不能确认的操作进入 needs-reconciliation；使用者先查看目录与进程，提交核对说明，再继续。已取消目标不可恢复。暂停会取消所属模型请求和进程，保留目录与记录。三次工作区没有变化的验收失败后停止自动重试。

同一服务串行执行目标，等待前一个目标和进程清理完成后才开始下一个。子目标通过独立 Git worktree 隔离，最多两个；创建需要父目录干净且父目标已暂停。依赖未完成时保持队列等待，依赖失败会停下来要求处理。当前不会自动合并子目标变更；由使用者检查差异后决定合并。

新消息继续原会话，保留 transcript 和累计预算，递增目标版本并清空旧完成证据。修改目标定义会另行刷新上下文；两种操作的含义不同。切换工作区只影响后续新会话，不移动已有任务文件，也不改变运行目标的目录绑定。

## 设计来源和边界

DeepSeek Harness 的可替换服务与会话事件组织、DSH Super-Agent 的持久状态与事务队列，以及 Pi 的轻量交互和模型配置，分别用于本工程的模块边界、恢复语义和交互设计。固定参考版本见 THIRD_PARTY.md；内核保持独立实现。

应用层子目标/工作树与 ERNIE 模型内部专家机制没有一一对应关系。VHA、Multi-Router、ECHO 的公开背景不构成客户端控制能力，也不能证明此 Harness 最优。实际可用性以免费端点的工具闭环、上下文诊断和同模型比较为证据。

## 验证证据

自动化故障场景使用注入的模型/工具，证明调度器的状态语义，不代表线上模型效果。真实模型记录、Linux 验证与正式任务结果分别报告；冒烟任务通过不能替代24任务、3 Harness、2重复的正式比较。

## DSH Super-Agent mechanism mapping (2026-11-13)

The primary Super-Agent reference is `dsh-superagent`, inspected in the local source checkout at commit `6337fc823ce20251c8de8085948165c81aaa701e` (local changes are not claimed as that upstream commit). The original experiment reference remains `deepseek-ai/dsh-superagent-prototype@8c32a9dc5d72c033816c6a8110b37f40cf94fba4`.

| DSH concept | ERNIE implementation |
| --- | --- |
| Mandate | Explicit start grants a revision-bound mandate; user pause/cancel withdraws automatic inputs. |
| Trigger / durable effect | Queued messages, dependency readiness and quota wakes are persisted before dispatch. |
| Post-commit dispatcher | `DshCoordinator.dispatch` atomically settles a wake and queues the goal; a timer only wakes the dispatcher. |
| Assessment | Each worker completion records status, goal revision and independent evidence count. Model claims remain separate. |
| Assignment | Child goals retain parent, isolated workspace and review state; acceptance never silently merges source changes. |
| Recovery / stopping | Pending tool effects require reconciliation; paused/cancelled/failed mandates do not receive automatic retries. |

`GET /api/supervisor` exposes wakes, assessments, assignments and active workers. `POST /api/assignments/:id/review` records explicit acceptance/rejection with a note. Default concurrency remains one; the scheduler supports two disjoint canonical workspaces when explicitly configured. Both share model allowance. No social connector or autonomous messaging to third parties is enabled by these mechanisms.
