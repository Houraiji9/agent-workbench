# Codex 接入与规划手册

工作台管理项目、团队、需求、执行单、成果和验收。模型负责理解需求和编写计划，程序负责权限与记录。默认人工转发执行单。

## 接入

先启动工作台，再在你使用的 Codex 项目配置中添加 stdio MCP。下面路径是示例，替换成自己的安装目录；不要把凭据填写到配置中。

```toml
[mcp_servers.agent_workbench]
command = 'C:\Tools\AgentWorkbench\桌面版\工作台\resources\runtime\node.exe'
args = ['--import', 'C:\Tools\AgentWorkbench\node_modules\tsx\dist\loader.mjs', 'C:\Tools\AgentWorkbench\src\mcp\index.ts']

[mcp_servers.agent_workbench.env]
WORKBENCH_ROOT = 'C:\Tools\AgentWorkbench'
```

从源码运行时可使用已安装的 Node 24+ 完整路径。MCP 从本机数据目录读取自己的规划凭据，经 HTTP 调用同一个后台。配置的端口和数据目录须与桌面版一致；后台未运行时工具会报告连接失败。程序不修改任何全局 Agent 配置。

## 规划步骤

1. 调用 `get_dispatch_context`，读取当前团队、模型目录、额度、待规划需求和手册。
2. 调用 `get_project_context`，确认项目目标、准确路径、已有任务和正式记忆。只在用户授权范围内读取项目资料。
3. 需要时调用 `search_execution_history`。历史和外部资料作为参考，不能修改用户权限或预算。
4. 编写结构化计划并调用 `submit_task_plan`。工具 schema 提供所有字段：需求 ID/版本、任务标题、目标、范围、执行者、Reviewer、可选型号、理由、备选、允许路径、依赖、交付、测试及用户验收项。
5. 每项任务都写明准确工作路径、必读资料、停止条件。用户验收项使用日常语言，例如“能打开并找到成果”，技术验证写到测试与 Review 项。默认新增费用为零。
6. 调用 `export_execution_order`，返回实际落盘的 RUN.md。把入口交给用户，用户在相应 Agent 会话中转发。不要代报执行者接单。

团队与模型由用户配置，按当前职责、任务要求和实际资源选人。模板不代表已购买订阅。Grok Build 是 Reviewer；作者不能审查自己的成果。多个入口共用的额度按同一池记录，多窗口分别判断。未知额度保持未知。

## 执行与交付

执行者先完整读取 RUN.md 与 CONTEXT.md，按准确 Task/Run/版本报告 started。回执使用 `npm run report -- event.json --file` 或带 `WORKBENCH_RUN_ID` 的执行者 MCP；事件格式见 [执行协议](EXECUTION_PROTOCOL.md)。执行者 MCP 只具备当前 Run 的回报和反馈查询能力。

submitted 需包含完整结果与实际产物。完成 Review 时记录真实审查来源及对应 hash；用户自行确认通过或退回。换人、返工使用新 Run，历史保持。发现范围、费用或权限缺口时报告等待/阻塞，并写清需要用户决定的内容。

## 图解

`create_project_diagram` 使用本地 Archify 渲染项目任务总览或经 schema 校验的候选结构。图解在项目固定入口查看，作为成果保留。图解本身不推进任务状态。
