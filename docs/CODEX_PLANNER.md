# Codex 接入与规划手册

工作台管理项目、团队、需求、执行单、成果和验收。模型负责理解需求和编写计划，程序负责权限与记录。默认人工转发执行单。

## 接入

先启动工作台，再在你使用的 Codex 项目配置中添加 stdio MCP。下面路径是示例，替换成自己的安装目录；不要把凭据填写到配置中。

```toml
[mcp_servers.agent_workbench]
command = 'C:\Tools\AgentWorkbench\桌面版\工作台\resources\runtime\node.exe'
args = ['--import', 'file:///C:/Tools/AgentWorkbench/node_modules/tsx/dist/loader.mjs', 'C:\Tools\AgentWorkbench\src\mcp\index.ts']

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

团队与模型由用户配置，按当前职责、任务要求和实际资源选人。模板不代表已购买订阅。Grok Build 只做审查；具有同类任务能力的其他成员也可担任 Reviewer。作者及同入口副本不能自审。多个入口共用的额度按同一池记录，多窗口分别判断。读取 `reviewer_resources` 和 `review_policy`：有效窗口剩余不超过 10% 时停止新派审，缓存低值在重置前仍受此限制；过期或未知资源不推算满额。Grok 没有默认优先权。

## 执行与交付

`submit_task_plan.tasks` 按建议执行顺序提交；真正的前置关系写入 `dependencies`，只在正文描述不会建立依赖。项目中的步骤由依赖关系生成，同阶段任务可并行。同一 Agent 的可执行任务按原计划顺序组成建议队列，复制执行单不会跳队。

项目上下文、派单上下文与任务详情中的 `execution` 提供步骤、前序名称与状态、队列位置、当前工作和后续任务。前序仅在 `accepted` 后解锁；返工按明确登记的后续任务继续判断。缺失、取消或循环依赖需规划者核对。导出、派发和接单都会校验前序；旧执行包保持原内容。队列用于建议，不强制串行，路径冲突仍由规划者判断。

页面收起长需求只影响展示。规划与编辑继续使用完整的 `request.text`。

执行者先完整读取 RUN.md 与 CONTEXT.md，按准确 Task/Run/版本报告 started。回执使用 `npm run report -- event.json --file` 或带 `WORKBENCH_RUN_ID` 的执行者 MCP；事件格式见 [执行协议](EXECUTION_PROTOCOL.md)。执行者 MCP 提供当前 Run 的回报、反馈查询及安排独立审查；审查结论由独立审查者回传。

submitted 需包含完整结果与实际产物。完成 Review 时记录真实审查来源及对应 hash；用户自行确认通过或退回。换人、返工使用新 Run，历史保持。发现范围、费用或权限缺口时报告等待/阻塞，并写清需要用户决定的内容。

## 生成与回传独立审查单

1. 主 Agent 交付后调用 `get_review_candidates({task_id})`，取得当前候选、额度和 revision。按能力、用户指示和资源选人。
2. 调用 `export_review_order({run_id,reviewer_id,expected_revision,reason})`，把返回的 `entry` 交给用户复制。指定其他审查者时必须正式改派，生成新单。
3. 审查单保存在该 Run 的 `reviews/RA-…/REVIEW.md`，包含需求、检查清单、交付文件和版本，以及接单、读取上下文、提交报告的完整命令。复制后仍待接单。
4. 本机审查 Agent 按单内 PowerShell 命令依次执行 `started`、`context`、`submit`。命令直接使用内置 Node 和加载器，不依赖系统 npm/PATH。Windows 的 `--import` 参数须保留 `file:///` URL，中文和空格使用 URL 编码，不能改成盘符绝对路径。
5. 也可按单内配置使用 `WORKBENCH_REVIEW_ID` 独立 stdio MCP；其工具只有 `get_review_assignment`、`report_review_started`、`submit_review_result`。与 `WORKBENCH_RUN_ID` 互斥，凭据由本机读取。
6. 提交完整 `report_markdown`、结论、问题、证据和未验证项，绑定本次 Task/Run/RA/digest。无法访问本机的 Agent 返回单内示例格式 JSON，由用户“导入审查回执”。
7. 完整报告入库并落盘为 `REPORT.md`；页面可展开或下载，原执行者可用 `get_run_feedback` 读取。要求修改时“复制修改意见给执行者”生成带报告的新 Run；通过后由用户确认。

改派或撤回后旧权限及旧结果失效。通用审查回传与用户导入分别标记来源；真实 Grok 会话可用 `get_review_context` 和 `submit_grok_review` 核验，需要本机支持 trace 的 Grok CLI 与 tar。人工误登记可在验收前撤回并保留原因。

## 图解

`create_project_diagram` 使用本地 Archify 渲染项目任务总览或经 schema 校验的候选结构。图解在项目固定入口查看，作为成果保留。图解本身不推进任务状态。
