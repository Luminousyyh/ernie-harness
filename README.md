# ERNIE Harness

[项目网站](https://luminousyyh.github.io/ernie-harness/) · [MIT 许可证](LICENSE) · [设计与来源](docs/THIRD_PARTY.md)

面向 ERNIE 5.5 Flash Preview 的编程工作台：终端、Web 和后台目标共用同一执行内核。

独立研究与开发项目，与百度、DeepSeek、Pi 或 Anthropic 无隶属关系，也未获得其官方背书。上游参考来源和许可证见 [第三方说明](docs/THIRD_PARTY.md)。

## 启动

需要 Node.js 24.9+、pnpm 10.30.3。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm cli setup
pnpm cli open
```

`setup` 隐藏输入模型凭据，在 Windows 使用当前用户 DPAPI 保存；Linux 私有凭据文件为600权限。也可通过环境变量 OPENROUTER_API_KEY 提供。真实密钥不进入浏览器。

`pnpm cli open`（或双击 start-ernie.cmd）会启动或复用后台服务并打开已认证工作台；`pnpm cli serve --open` 用于前台运行服务。

本地服务默认仅监听127.0.0.1:4317。终端打印带本地服务令牌的启动地址；这不是模型密钥。启动地址仅限本机使用。

```powershell
pnpm cli tui -w D:\your-project
pnpm cli run "修复问题并保留现有行为" -w D:\your-project -c "pnpm test" --supervised
pnpm cli run "检查仓库并列出改进建议" -w D:\your-project --background
pnpm cli list
pnpm cli workspace list
pnpm cli workspace add "D:\your-project" --name "我的项目"
pnpm cli workspace select <工作区ID>
pnpm cli reply <目标ID> "继续完善错误处理"
pnpm cli show <目标ID>
pnpm cli pause <目标ID>
pnpm cli resume <目标ID>
pnpm cli cancel <目标ID>
pnpm cli doctor
```

工作台侧栏可以添加、选择、编辑工作区，并在每个目录内新建独立对话。工作区选择会跨重启保存；修改目录不会移动已有对话。没有显式指定 `-w` 的 CLI 新目标使用当前选中工作区。继续对话保留记录和累计执行预算，并递增目标版本。

关闭界面不会取消后台目标。服务退出会暂停工作；重新启动后先核对未完成工具记录，再恢复。结果无法确认的副作用需要在 Web 中说明核对结果，避免重复写入。

## 当前边界

只允许 `baidu/ernie-5.5-flash-preview:free`，固定 Baidu 提供商、high推理和零价路由，不自动切换模型或付费端点。免费额度不足时停止新请求并保留状态。标题等辅助调用如发生，同样占用预算。

本机 Shell 是可信本地执行，文件工具检查工作区边界，但不宣称隔离任意同用户代码。远程正式评测使用独立用户态运行环境和 Bubblewrap；沙箱不得访问真实密钥、隐藏测试和其他试验的产物。

默认目标累计上限：20模型请求、200万输入token、12.8万输出token（含推理）、30分钟活动时间；每次最多16384输出token。请求前持久化保守预留，异常或中断不会抹掉累计消耗。监督目标必须有明确验收命令。

## 验证与实验

```powershell
pnpm typecheck
pnpm test
pnpm build
```

真实模型验证见 docs/LIVE_VALIDATION.md。评测协议与环境记录见 docs/evaluation.md。144次正式比较只有外部验收证据齐全后才算完成；manifest、空队列和模拟测试不能作为模型表现。Web 实验页面显示实际运行状态。

## 设计来源

重点参考 DeepSeek Harness 的可替换服务、DSH Super-Agent 的持久状态机，以及 Pi 的终端与程序化交互。项目内核独立实现，参考版本、来源和限制见 docs/research。原始 ERNIE 标志由用户提供，界面使用依据其几何结构重绘的矢量资源，不表示官方产品。Super-Agent 状态与恢复说明见 docs/SUPER_AGENT.md。


远程实验状态可同步到 Web 的“实验”页：`python scripts/sync-evaluation.py` 获取一次快照，或加 `--watch` 每60秒读取现有队列。需要本地 Python 与 Paramiko；SSH 凭据通过隐藏输入或运行时环境变量提供，页面只接收允许公开的统计与逐项记录。该同步进程不创建试验、不调用模型，也不把 pending 记录计作完成。同步时间显示在页面中，SSH 断开期间保留最近成功快照。


## 仓库内容与运行数据

仓库包含内核、Web/终端界面、测试、部署和评测源码、设计文档及带许可证的上游研究参考。模型凭据、SSH/GitHub 凭据、会话数据库、依赖缓存、完整运行轨迹和部署压缩包仅保存在运行环境，不提交 Git。首次运行应按启动步骤配置自己的模型凭据。

[评测目录说明](eval/README.md) 区分可复现源码、经检查的进度摘要和运行时生成的证据；文档中的远程路径对应作者的实验环境，需要在自己的服务器上重新配置。正式比较仍在进行，已有冒烟或开发结果不代表三方性能结论。


## 开源协议与展示网站

项目原创代码采用 [MIT License](LICENSE)。第三方参考材料保留各自许可；MIT 不授予第三方商标、名称或标识的使用权。项目与百度、DeepSeek、Pi 或 Anthropic 无隶属关系。

展示站是 `docs/` 下的独立静态页面，由 GitHub Pages 从 `main:/docs` 发布，无模型调用或访客追踪。`pnpm site:preview` 本地预览；`pnpm site:qa` 检查浏览器交互并生成截图。预览界面使用标注的演示数据，评测结果引用带日期的快照。

网站浏览器检查会优先使用 Windows 上的 Edge；其他环境先运行 `pnpm exec playwright install chromium`，或通过 `ERNIE_BROWSER` 指定浏览器可执行文件。
