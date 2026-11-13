# ERNIE 5.5 Flash Preview 模型适配与证据边界

核对日期：2026-11-13。适配目标固定为 `baidu/ernie-5.5-flash-preview:free`，经 OpenRouter 的 Baidu 路由访问。本说明区分官方公开事实、当前代码实现和待验证假设；不将模型论文中的训练或推理结果当作本 harness 的实测结果。

## 官方事实及其适用范围

| 来源 | 可支持的事实 | 对本项目的含义与边界 |
| --- | --- | --- |
| [Flash Preview 发布说明](https://ernie.baidu.com/release/ernie-5-5-flash-preview/) | 2026-11-11 发布；建立在 Flash Base 上的后训练模型；官方披露 280B 总参数、14B 活跃参数和 1M token 上下文，展示代码、知识工作及工具驱动任务。 | 是模型选择背景。官方演示不能代替本项目对修复成功率、长任务可靠性和成本的评测。1M 是官方规格；实际调用还受路由目录、请求体上限和本地预算约束。 |
| [Flash Base 发布说明](https://ernie.baidu.com/release/ernie-5-5-flash-base/) | 披露模型架构、Multi-Router latent MoE、VHA 相关混合结构及 **single-step ECHO** 预训练。 | 据此讨论架构背景；不假定远端服务暴露内部控制旋钮，也不把 base 模型评测直接转移到 preview。 |
| [Virtual Head Attention，arXiv:2610.17959](https://arxiv.org/abs/2610.17959) | 论文介绍 Q Premix 与 Linear Postmix，以及注意力表达、KV 缓存和计算量之间的研究取舍。 | 不把论文某一实验配置的 KV 缓存缩减倍数或速度推广为该 OpenRouter 端点的实测值。Harness 无法设置远端注意力头或缓存内核。 |
| [Multi-View Latent MoE，arXiv:2610.40577](https://arxiv.org/abs/2610.40577) | 论文分别研究 Multi-Router 和 Multi-View Mixing；Multi-Router 是其中可单独分析的部分。 | 本项目仅据 Base 发布说明采纳 **Multi-Router** 这一已披露的模型背景；不声称该发布模型采用了论文中完整的 Multi-View Mixing，也没有在 harness 中实现专家路由。 |
| [ECHO，arXiv:2610.24766](https://arxiv.org/abs/2610.24766) | 论文研究复用骨干末层进行未来 token 预测及自递归草拟；Base 说明明确其训练采用单步 ECHO。 | 不将论文更深训练配置套用到发布模型；不假定 API 开启某个推测解码配置，更不承诺其加速率。 |

当前唯一允许的推理强度是 `high`；`GoalInput`、`Goal` 和 `ModelRequest` 的可选 `reasoningEffort` 只接受该值，其他值在生成前拒绝。`selected: high` 表示配置选择，不等同于目录明确公布或真实调用已验证。目录中的通用 `reasoning` / `reasoning_effort` 参数不能推导出各档位列表；`advertised` 仅来自显式列表，`verified` 仅来自调用方核验过的精确模型、Baidu 路由和推理强度绑定的真实成功记录。其他档位需明确公布且真实验证后才能开放。高推理强度的任务收益、输出 token 消耗和时延仍需独立测量。

## 传输实现

入口为 `src/provider/index.ts`，导出 `OpenRouterTransport implements ModelTransport`。

```ts
new OpenRouterTransport({
  apiKey,
  baseUrl: 'https://openrouter.ai/api/v1', // 可省略；也允许环回 broker URL
  fetch: globalThis.fetch,               // 可省略，便于离线测试或本地集成
  quota: new SerialQuota({ path: quotaPath }), // 可省略，使用默认持久化配额
  responseMode: 'stream',                // 默认；支持验证后可显式选择 'json'
});
```

`complete(request, onDelta?, signal?)` 严格遵循共享契约。`snapshot()` 返回模型、运行期目录请求数、生成尝试数、响应模式和最近路由快照，不包含凭据。计数是当前 transport 实例的诊断数据；跨重启的调用额度由配额文件保存。

每个生成轮次在取得串行执行权后，先无认证访问官方公开端点目录：

`GET https://openrouter.ai/api/v1/models/baidu/ernie-5.5-flash-preview:free/endpoints`

目录须同时满足精确模型 ID、`provider_name = Baidu`、`tag = baidu`、可用状态、prompt/completion 价格为零，且其他列出的计费维度也为零。`discount` 作为折扣字段单独排除。缺失价格、未知价格格式、非零价格、错误模型或提供商均拒绝生成；目录不可达也不放行。检查 reasoning 与 reasoning_effort 支持，工具请求另检查 tools。每轮重新校验，不使用长期缓存兜底。

生成请求固定模型、`provider.only = ["baidu"]`、`allow_fallbacks = false`、`require_parameters = true`、prompt/completion 的 `max_price = 0`，并传递 `reasoning = { effort: "high", exclude: false }`。不开放替代模型参数。环回 broker 只改变生成请求目的地；公开目录仍来自 OpenRouter，且绝不携带 API key。重定向被拒绝，避免转发认证头。

SSE 解析处理跨字节 UTF-8、CR/LF/CRLF、注释心跳、多行 data、多个工具索引交错、名称和参数分片、reasoning 文本/加密块/签名分片、结束事件与单独的 usage 事件。工具参数必须完整解析为 JSON 对象，工具 ID 必须唯一；残缺参数和未完成响应不会交给工具执行器。错误事件也会终止响应。

JSON 模式仅在调用方已确认该路由支持非流式调用后显式选用。若原始流式请求直接返回成功 JSON completion，传输可以解析这个响应；不会隐式重发第二次调用。HTTP 失败、断流或解析失败均不会触发自动重试、模式切换或付费回退。主任务负责能力探测与需要重试时的调度、计数和预算。

所有下一轮消息都按值复制；assistant 的 `reasoning_details`、tool calls、tool call ID 和失败工具结果继续传给提供商。JSON 响应的 reasoning_details 原样保存；流式响应按索引组装，保留不透明字段。调用方进行历史压缩时仍必须保留未闭合的 assistant/tool 轮次及其 reasoning_details。

`Usage.outputTokens` 是提供商的 completion_tokens，**包含**其中的 reasoning token；reasoningTokens 仅作子集统计，不重复加到输出总额。缺失必要用量数据时以 UTF-8 长度近似估计，并设置 `estimated: true`。`inputEstimated`、`outputEstimated`、`reasoningEstimated` 分别记录各项来源；只有推理细分估算时，服务端已报告的 prompt 计数仍作为当前请求的精确输入。旧传输未区分来源时保守采用聚合标志。该估计不是 tokenizer 的精确计数，也不是硬额度证明。服务返回的负数或不一致计数会被拒绝；报告非零 cost 的响应触发错误并要求核查。

`Goal.usage` 是跨请求累计预算账本；`Goal.context` 描述最近一次准备或发送的请求，两者不可混用。`contextLimit` 是本地目标配置，默认 128000；`modelContextLength` 是最近已知的路由目录声明，`effectiveLimit` 取二者较小值。本地默认 128K 不代表模型只有 128K。`requestInputTokens` 的来源由 `source` 与 `estimated` 标明；`estimatedInputTokens` 使用含系统消息、工具 schema、工具轮次及 reasoning_details 的 JSON UTF-8 字节启发式，并非精确 tokenizer 计数。`responseReserve` 为回复预留空间，取单次输出预算、剩余累计输出预算和有效窗口 20% 的较小值；`remainingTokens = max(0, effectiveLimit - requestInputTokens - responseReserve)`，`remainingRatio` 再除以有效窗口。估计请求加回复预留达到 80% 时执行本地有损压缩，保留原始目标、全部追加用户消息、系统规则及完整最近工具轮次，记录 `compressionCount`、`lastCompressedAt`、`retainedSummaryOutline` 和 `context.compacted`；压缩不调用模型。无法容纳的不可分输入在生成前明确失败。`requestRevision`、`updatedAt` 标识快照所属请求；目标继续或修订后，旧版本快照只能显示为上次请求。

边界：单请求序列化内容不超过 16 MiB；响应累计不超过 16 MiB；目录响应不超过 4 MiB；单 SSE 事件/行缓冲不超过 1 Mi 字符。目录超时 30 秒，整个 completion 含等待时间为 10 分钟。支持排队取消、网络取消和流读取取消；已经发生的不确定调用仍计入额度。

`ApiError` 提供 `status`、`retryAfterMs`、`retryable`、`code`。Retry-After 支持秒数和 HTTP 日期。错误正文、远端异常详情、认证头和 cause 不进入对外错误对象；因此不能从原始错误字符串泄露密钥。网络失败的 `retryable` 表示可由上层策略考虑再次调用，不等同于远端一定未执行。429、408、5xx 会标记重试可能性，传输本身不自动重试。

## 持久化额度、预算和凭据

`SerialQuota({ path?, now? })` 默认保守限制为 **10 次/滚动分钟、50 次/UTC 日**。这两个数字是本项目的回退策略，并非对所有 OpenRouter 账户实际配额的断言。

- `run(operation, signal?, prepare?)`：同路径实例共享串行队列，跨进程通过排他锁拒绝竞争 writer；可选 prepare 在持锁后、消费调用额度前执行。
- `reserve(signal?)`：先落盘再返回预留 ID。直接使用它时，调用方自行保证执行串行；transport 已使用 run。
- `snapshot()`：返回已用/剩余分钟和日额度及 UTC 日重置时间。
- 调用失败、取消或进程中止后不自动退还已落盘预留。重新启动沿用记录；损坏文件、时钟倒退和已有锁均拒绝重置额度。
- 预留使用临时文件、fsync 和 rename。崩溃留下的 `.lock` 需要在确认原 writer 已终止、对不确定操作完成核查后人工移除；本模块不会盲目清理活跃锁或重放写入。
- 所有实际调用，包括能力验证、辅助摘要及上层重试，均应走同一 quota 路径。绕过本模块的探测不会被自动追溯计数；主任务须在其调用前使用同一额度预留机制。

`BudgetReservations({maxCalls,maxInputTokens,maxOutputTokens})` 提供同步原子预留。`reserve({inputTokens,outputTokens})` 返回一次性 `commit(usage)`；尚未结算的调用持续占据全部预留，实际超额仍如实计入，阻止后续预留。此工具为单进程、内存中的 token 预算原语；跨重启预算应以 core/store 中的持久化账本为准。

默认本地状态目录是 `ERNIE_HARNESS_HOME` 或用户主目录下 `.ernie-harness`。凭据 API：

```ts
const key = await loadApiKey({ path: optionalVaultPath });
await storeApiKey(keyFromHiddenPrompt, {
  path: optionalVaultPath,
  explicitSetup: true,
});
```

`loadApiKey` 优先读取 `OPENROUTER_API_KEY`，否则读取平台保护文件；读取不会创建或写入密钥。Windows 使用 CurrentUser DPAPI；固定 PowerShell 脚本通过管道传入/取回内容，密钥不出现在命令参数中。Linux/其他 POSIX 系统要求私有普通文件、权限严格为 0600 且属于当前用户。`storeApiKey` 仅接受显式 CLI setup 标志；UI 不应调用它或拿到模型凭据。调用方须使用隐藏输入，避免 shell 历史。`readApiKey`/`saveApiKey` 是相同函数的别名。

## 能力探测与评测边界

`probeCapabilities(apiKey, {fetch?, signal?})` **只查询公开目录**，不校验 API key、不读取其他凭据、不调用生成模型，也不执行工具。返回 `liveVerified: false`、`source: "public-catalog"`、目录支持参数和 `streaming: "unverified"`。传入 apiKey 仅为稳定的调用接口；函数不会发送它。

面向服务端的 `inspectModelCapabilities({fetch?, signal?, verifiedReasoning?})` 从 `src/provider/catalog.ts` 及 `src/provider/index.ts` 导出，可用于 `GET /api/model/capabilities`。它只查询公开目录，返回安全的 `{status, model, contextLength?, reasoning:{advertised, verified, selected, reason}, checkedAt?}`。`verifiedReasoning` 必须由服务端从真实成功记录核验后提供；缺省为空。离线 mock、公开目录响应和旧记录中未绑定模型、路由及请求强度的成功均不会自动提升验证状态。不可用时返回固定错误说明，不返回上游正文或凭据；历史验证与当前路由可用性分别表达。

`docs/LIVE_VALIDATION.md` 与 `artifacts/validation/ernie-live-smoke.json` 记录了 2026-11-12 在 Windows 上完成的四次调用工具闭环：读取代码与测试、修复加法、执行测试，并由引擎重复验收，最终状态 `succeeded`、验收退出码 0。该记录支持已报告的基础工具/编辑/测试流程，不构成跨 harness 基准、长上下文、其他传输模式、恢复能力或长期可靠性的证据。旧 trace 未逐请求绑定模型 ID、Baidu 路由和 reasoning effort，因此不能单独用于把 `high` 标为已真实验证。合成 SSE、模拟 HTTP 和本地凭据回环也不构成真实模型验证。

最小真实验证应由主任务在同一额度账本下完成两个生成轮次：第一轮请求一个无副作用、严格 JSON 参数的工具；保存 assistant reasoning_details 并填入工具结果；第二轮检查模型能消费该结果。每轮记录 route、model、工具结构、finish reason、usage、estimated 标志、cost 和错误类别，避免保存 key。流式与非流式分别报告；不能由一种模式的成功推断另一种模式已成功。

待验证假设包括：保留 reasoning_details 是否提高多轮工具成功率、高推理强度的成本收益、固定免费路由的长期可用性、长上下文下的正确率和时延。应以相同任务、预算、种子/重复和外部可检验结果比较；不能由 VHA、MoE 或 ECHO 论文数字推出本 harness 的速度、可靠性或任务成功率提升。

## API 参考

- [OpenRouter streaming](https://openrouter.ai/docs/api/reference/streaming)
- [OpenRouter reasoning tokens / reasoning_details](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenRouter provider routing and price limits](https://openrouter.ai/docs/guides/routing/provider-selection)
- [精确模型公开端点目录](https://openrouter.ai/api/v1/models/baidu/ernie-5.5-flash-preview:free/endpoints)

自动化测试位于 `tests/provider.test.ts` 和 `tests/provider-state.test.ts`。测试证据应以当次执行输出为准。Linux 文件权限分支尚需在 Linux 主机实测；Windows 当前验证覆盖测试用 DPAPI 加解密。目录和提供商行为可能变化，因此每次生成仍执行免费路由预检。
