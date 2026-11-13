# 扩展 Harness

[English](extensions.md) · [架构](architecture.zh-CN.md)

本教程依据正在集成的 `src/extensions/types.ts` 契约和 `src/extensions/config.ts` 配置校验。部署前检查当前源码与集成测试。配置示例不能证明传输已连接或模型已成功使用工具。

## 可信插件

在可信工作区创建 `.mjs` 插件。下例注册纯工具，不读文件、不访问网络：

```js
export default {
  apiVersion: 1,
  id: 'hello',
  register(api) {
    api.registerTool({
      name: 'hello_project',
      description: 'Return a fixed greeting without reading project files.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      execute() {
        return {ok: true, output: 'Hello from the project extension.'};
      },
    });
  },
};
```

`HarnessPlugin` 要求 `apiVersion: 1`、`id` 与 `register(api)`。注册可返回清理函数；`PluginAPI` 还提供 `addContext`、`addValidator`、`onEvent`。这些钩子是可信进程内代码，超时机制不能把任意插件变成沙箱。

扩展配置采用下列结构。按当前加载器规则把插件路径解析在工作区内，通过服务配置入口提供。集成版本支持时，CLI 从运行时状态目录载入 `extensions.json`；具体入口应查看 `src/cli/main.ts`，不要猜测系统特定路径。

```json
{
  "enabled": true,
  "timeoutMs": 30000,
  "skillRoots": [".agents/skills"],
  "plugins": [
    {"id": "hello", "path": "extensions/hello.mjs", "enabled": true, "trusted": true}
  ],
  "mcpServers": []
}
```

只信任已审查的代码。工具注册要遵守保留名称与当前命名空间/冲突规则；加载后检查注册表，不假定模型可见名称就是示例中的未限定名称。

## 不内嵌凭据的 MCP

`StdioServerConfig` 使用可执行文件与参数数组，并用环境映射引用运行时变量名。`HttpServerConfig` 使用无凭据 URL 和可选的 `bearerTokenEnv`。配置校验要求远程 HTTP 服务显式允许且使用 HTTPS；回环地址可使用 HTTP。真实凭据不得放入 URL、配置、fixture 或日志。

```json
{
  "enabled": true,
  "mcpServers": [
    {
      "id": "local_docs",
      "transport": "stdio",
      "command": "node",
      "args": ["extensions/docs-server.mjs"],
      "envFrom": {"DOCS_TOKEN": "MY_RUNTIME_DOCS_TOKEN"},
      "timeoutMs": 10000
    }
  ]
}
```

`envFrom` 左侧是子进程变量名，右侧是父进程运行时变量名，不保存或提前解析真实值。示例服务器路径代表你自行实现的服务。`examples/extensions/mcp-fixture.mjs` 是离线 fixture，不是真实服务或能力结果。stdio 程序按当前用户执行；远程服务能接收你发送的请求。

## 技能与仓库指令

发现机制添加带来源的上下文与技能描述。上下文标记 `trust: 'untrusted'`，不能覆盖系统策略、工作区边界或固定模型列表。技能根目录应限制在目标范围，并查看缺失、超大、无效或拒绝内容的诊断。不能宣称所有第三方技能均兼容。

## 扩展内置工具

以只读 `project_summary` 为例：

1. 在 `src/contracts` 定义共享数据，不导入实现。
2. 在 `src/tools/schemas.ts` 增加严格 schema，由 `src/tools/index.ts` 的 `ProjectTools` 注册和分派。
3. 复用 `src/tools/files.ts` 的规范化工作区与文件辅助函数；拒绝越界、保护路径与取消，限制并脱敏输出。
4. 测试真实行为：正常输出、非法输入、路径/符号链接越界、取消和脱敏。纯工具不需要写日志；有副作用工具必须保存意图/结果并设计不确定结果核对。
5. 执行 `pnpm typecheck`、`pnpm test`、`pnpm build`。模型工具选择能力用另行授权的真实调用验证。

插件/MCP 还需检查禁用与不可信配置、名称冲突、超时、销毁、传输失败和凭据脱敏。验证器只为已定义检查提供证据；任意插件验证器不等于独立正式评测评分器。参见[成熟度门槛](../maturity.md)。
