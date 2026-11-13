# Live ERNIE validation

Date: 2026-11-12. Model: baidu/ernie-5.5-flash-preview:free.

A deliberately broken add.mjs returned a-b. ERNIE read both source/test, edited only source to a+b, invoked node --test, and the engine independently repeated the acceptance command. Final status: succeeded.

Calls: 4; input tokens: 7088; completion tokens including reasoning: 236; reasoning subset: 28; active milliseconds: 10877.

Verification exit code: 0. Workspace SHA256: 946be0db6d787a215bc5f086d0b5d7e9baaaddcece92d83ce5d321a3568d5e6d. Goal revision: 1. Full sanitized trace: artifacts/validation/ernie-live-smoke.json (local artifact).

This confirms basic tool/edit/test streaming integration on Windows. It is not cross-harness benchmark evidence. Restart/recovery and remote trials are separate checks.


## 2026-11-13：原生模型、服务重启与继续对话

使用相同免费 Baidu 精确模型和 high 请求配置，共享远程 broker 的持久额度账本；未创建独立免费额度。文件工具限定工作目录，全部 Shell/验收命令经 Bubblewrap 隐藏宿主私有目录，运行前确认真实凭据路径不可见。该验证使用原生 OpenRouter transport，未注入模型响应。

第一阶段修复加法错误并执行验收：succeeded，4 次调用、7222 输入、220 输出 token。关闭服务，保留 SQLite 后重新创建服务；追加消息递增为修订 2，继续检查实现及测试，再次 succeeded。累计 7 次调用、14018 输入、421 输出 token，含 42 个推理 token 子集，累计活动时间 13199 ms。未重置预算或会话。

原生成功记录绑定 `baidu/ernie-5.5-flash-preview:free`、Baidu、high 和时间，供能力页面显示历史实测档位。报告：`artifacts/validation/live-continuation-20261113.json`；远程原件：`eval/live-continuation-20261113.json`。

这是受控关闭/重启与会话续接证据，不是进程崩溃、未知副作用恢复的真实模型实验，也不构成 SWE-bench 正式试验或跨 Harness 排名。故障注入测试另行作为离线执行语义证据报告。

后续完整性核查确认原始测试文件逐字未改，最终实现为 `return a+b`；报告 SHA256 绑定见 `artifacts/validation/live-continuation-integrity-20261113.json`。


## 三方接入状态

ERNIE Harness、Pi、DeepSeek Harness 均已有同一免费模型的文件编辑/测试成功记录。DSH 通过固定版本的构建 CLI 入口完成：agentExit 0、外部测试通过、有效加法补丁，broker 记录 6 次已完成调用。记录见 `artifacts/validation/dsh-live-smoke-20261113.json`。这修复了此前仅以 help 作为就绪依据的缺口；不改变基线规划或恢复逻辑。

开发集18次和正式集144次的状态单独记录，不由以上冒烟推导性能优势。


## 2026-11-13：真实持续目标与计划工具

另一个 supervised=true 目标通过原生 ERNIE 完成读取文件、调用内核 `update_plan` 和独立验收。累计3次调用、6495输入、389输出 token（含120推理 token子集），活动时间6021 ms。模型明确将测试检查点标为 pending，并说明尚未执行测试；随后 Harness 运行 node --test，验收退出码0，目标 succeeded。该记录验证模型计划声明与执行器验收证据保持分离。报告：`artifacts/validation/live-super-agent-20261113.json`。它不证明多工作进程、未知副作用崩溃恢复或长期自动执行的效果。

## 免费额度核对

统一远程额度账本补入了此前本地对话的3条独立请求记录，并保守预留1次早期手动探测未记账的额度；没有重置原额度或发出新的模型请求。`artifacts/validation/quota-reconciliation-20261113.json` 记录核对过程。此核对项是预算记账，不作为新增模型试验结果。


## 2026-11-13：本地 Web 实际上下文

通过运行中的真实本地服务创建普通会话，仅要求简短回复，不调用工具。实际免费Baidu完成1次请求，状态succeeded；输入1785、输出9 token。本次128000软窗口、1024回复预留下，provider usage对应剩余125191（约97.8%）。浏览器已实际显示该数字、high历史实测记录及1024000声明窗口，无页面错误。记录：`artifacts/validation/live-web-context-20261113.json`、`artifacts/visual/final-native-browser-checks.json`。该调用已从本地日志原样合并进远程共享额度账本，当前合计34、保守剩余16。

只读账户状态接口核验HTTP200、free tier；没有可可靠采用的免费剩余请求计数，继续按50/UTC日的保守策略运行。记录：`artifacts/validation/account-quota-status-20261113.json`。此GET不是模型生成调用。


## V2三方观测接入

在主实验仍为0次调用时，以统一“读取不存在文件（预期错误）→读取hello.txt→总结”任务验证轨迹。ERNIE 3、Pi 2、DSH 3，共8次实际共享请求；三方各2个读取完成事件、1个明确错误。请求/响应8/8完整，原生会话留存，48份记录的真实key/当前认证token扫描均无泄露。DSH首个启动失败发生在模型派发前（0次），修正原生CLI参数顺序后仅续跑DSH，未重跑已成功案例。原始失败回执保留。

同一个导出helper又对实际文件做离线重放，三方providerComplete、工具指标完整性均通过，均为2完成/1失败；新增模型调用0。记录：`eval/live-observability-v2-20261113-audit.json`、`eval/observation-index-v2-proof.json`。这些是非SWE观测接入证据，不是跨Harness性能样本。主实验单代理配置已用DSH原生dump-config和实际菜单核验。
