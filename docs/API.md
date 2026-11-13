# Shared service API v1
Loopback127.0.0.1:4317. Auth via HttpOnly SameSite=Strict session cookie after POST/api/auth {token}; launcher URL fragment contains local service token (not model key). CLI uses Bearer service token. GET/api/health public; other/api requireauth. UI handles401 with token form.
GET/api/state -> {goals:Goal[],provider:{model,configured,mode},stats:{calls,inputTokens,outputTokens},version,workspace}
POST/api/goals GoalInput ->Goal (created pending); POST/api/goals/:id/start|pause|cancel|resume ->Goal; PATCH/api/goals/:id {prompt?,title?,acceptanceCommands?} incrementsrevision; POST/api/goals/:id/reconcile {note} acknowledges manual reconciliation and sets paused.
GET/api/goals/:id -> {goal,messages,events}; GET/api/goals/:id/diff -> {diff}; GET/api/events?after=N SSE data HarnessEvent and id=seq; GET/api/benchmark -> {status,summary,trials} (empty honest state if not run).
Events: goal.created,goal.updated,run.started,run.completed,run.failed,model.delta {type,text},message {role,content,...},tool.started {id,name,args},tool.completed {id,name,result},usage,verification,context.compacted.
Goal types in src/contracts/index.ts. UI must not fabricate tasks/results or expose credentials. Prompt submit includes workspace and optional acceptanceCommands; start endpoint separate.

POST /api/goals/:id/children {prompt,title?,acceptanceCommands?,supervised?,budget?} -> Goal. Requires parent inactive and clean Git state. Workspace forced to new detached worktree; parentId forced to parent. At most two managed worktrees. No automatic merge/removal of changed worktrees.


## 工作区和连续对话（2026-11-13）

- `GET /api/state` 增加 `workspaces` 与 `activeWorkspaceId`；`workspace` 是选中目录。
- `POST /api/workspaces` 接收 `{path,name?}`；目录必须为现存可访问的绝对路径，规范化后重复添加返回既有记录。
- `PATCH /api/workspaces/:id` 接收 `{path?,name?}`，不改变历史目标绑定；与已有目录冲突返回409。
- `POST /api/workspaces/:id/select` 持久保存当前工作区；不存在返回404。
- `POST /api/goals/:id/messages` 接收 `{content,start?}`，追加会话并递增版本，清空旧完成证据，保留预算与记录。`start:true` 排队执行；默认保存为paused。运行、排队、限流等待、未核对操作或已取消时返回409。

CLI: `workspace list|add <path>|select <id>|edit <id> -w <path> --name <name>`；`reply <goal-id> <content>`。未指定 `-w` 的新目标使用服务选中的工作区。

`GET /api/model/capabilities` 返回可用性、模型窗口、显式公布档位、历史真实验证档位及当前配置。仅查询公开元数据；目录不可用不放行生成。`Goal.context` 展示当前请求计数、来源、回复预留、剩余比例、压缩记录及 `requestRevision`；不同于累计 `Goal.usage`。目标追加消息后保留上次请求快照并标注版本，下一次执行会刷新。

持续目标的 `update_plan` 由内核记录为 `plan.updated` 事件，包括模型提供的步骤与检查点；该内容不代替外部验收证据。子工作树创建与运行调度共享规范化目录的写入保留，避免与同目录其他目标重叠。

会话详情包含完整 `messages`、最近最多5000条 `events`（始终保留最近的 `plan.updated`，避免流式片段淹没持久计划） 和 `eventCursor`。客户端以该游标作为消息快照水位，再应用其后的 SSE 事件，避免长会话超过5000条事件后重复回放已包含的消息。全量事件仍可通过带游标的 `/api/events` 顺序读取。
