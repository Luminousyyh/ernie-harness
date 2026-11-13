# 使用 ERNIE Harness

[English](guide.md) · [网站](https://luminousyyh.github.io/ernie-harness/#usage) · [README](../../README.zh-CN.md)

需要 Node.js 24.9+、pnpm 10.30.3。执行 `pnpm install --frozen-lockfile`、`pnpm build` 后，运行 `pnpm cli setup` 和 `pnpm cli open`。Linux 请把下方 Windows 路径替换为自己的绝对路径。模型执行需要自己的 `baidu/ernie-5.5-flash-preview:free` 运行时凭据；网站本身不需要凭据。

## 第一个任务

```sh
pnpm cli workspace add "D:/projects/my-app" --name "my-app"
pnpm cli workspace list
pnpm cli workspace select <workspace-id>
pnpm cli run "修复空输入并增加回归测试" -w "D:/projects/my-app" -c "pnpm test" --supervised
pnpm cli list
pnpm cli show <goal-id>
```

验收命令应适合实际项目，示例不意味着所有项目都使用 pnpm。监督目标必须有明确验收命令；完成证据必须对应当前目标版本与工作区。模型口头表示测试通过，不是独立测试记录。

`pnpm cli open` 打开 Web，`pnpm cli tui -w "D:/projects/my-app"` 打开终端。添加并选择工作区，新建对话，查看工具调用、结果和验收记录。工作区选择跨服务重启保留；更改工作区目录不移动旧对话。应用默认中文；语言命令与英文界面正在本版本并行集成。

## 继续、暂停与恢复

```sh
pnpm cli reply <goal-id> "补充错误处理"
pnpm cli pause <goal-id>
pnpm cli resume <goal-id>
pnpm cli cancel <goal-id>
pnpm cli doctor
```

继续对话保留历史与累计预算，并递增目标版本。关闭页面不取消后台目标；退出服务会暂停工作。重启后恢复先核对未完成工具记录。如果写入可能已发生但结果未保存，应检查实际工作区和日志，再通过恢复界面解决不确定副作用。不能因缺少结果就直接重放写入。

经验、改进、审批、对话分支和检查点命令正在 `src/cli/commands.ts` 集成。用于自动化之前，先检查当前 `pnpm cli --help` 和对应测试。检查点恢复会修改工作区，必须遵守当前审批与副作用核对策略。

## 预算与模型

仅允许 `baidu/ernie-5.5-flash-preview:free`，通过配置的 Baidu 零价路由执行，不允许其他模型或付费回退。默认累计上限为 20 请求、200 万输入 token、12.8 万输出 token（含推理）、30 分钟活动时间；每次最多输出 16384 token。请求前持久化预留。重试、标题、反思与改进不属于额外免费调用。

额度不足时保留状态、停止新请求。请求估算、配置档位、声明能力与真实验证能力是不同事实；应据此理解静态截图与历史冒烟记录。

## 凭据与本地执行

`setup` 隐藏输入。Windows 使用当前用户 DPAPI；Linux 使用私有凭据文件。也支持运行时 `OPENROUTER_API_KEY`。服务默认监听 `127.0.0.1:4317`；认证启动令牌不是模型密钥，启动地址不要分享。

本机 Shell 使用当前用户权限。文件边界检查不构成通用沙箱。正式远程评测采用独立的 Linux/Bubblewrap 方案。详见[架构](architecture.zh-CN.md)、[扩展信任边界](extensions.zh-CN.md)、[成熟度门槛](../maturity.md)。

## 离线预览文档

```sh
node scripts/site-build.mjs
pnpm site:preview
pnpm site:qa
```

预览提供 `/ernie-harness/` 与 `/ernie-harness/en/`，两者均为完整 HTML，无 JavaScript 也可阅读。启用 JavaScript 时，语言切换保留当前章节锚点。浏览器检查前可执行 `pnpm exec playwright install chromium`，或使用 `ERNIE_BROWSER`；Windows 支持已安装的 Edge。网站 QA 不调用模型。
