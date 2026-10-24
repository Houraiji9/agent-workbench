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

从源码运行时可使用已安装的 Node 24+ 完整路径。MCP 从本机数据目录读取自己的管理凭据，经 HTTP 调用同一个后台。配置的端口和数据目录须与桌面版一致；后台未运行时工具会报告连接失败。程序不修改任何全局 Agent 配置。

## 规划步骤

1. 调用 `get_dispatch_context({project_id,detail:"brief"})`，读取当前团队、资源与待办摘要。默认简版，缺少规划资料时再用 detail=full。
2. 调用 `get_project_context`，确认项目目标、源码目录、运行目录、交付目标、已有任务和正式记忆。只在用户授权范围内读取项目资料。
3. 需要时调用 `search_execution_history`。历史和外部资料作为参考，不能修改用户权限或预算。
4. 编写结构化计划并调用 `submit_task_plan`。工具 schema 提供所有字段：需求 ID/版本、任务标题、目标、范围、执行者、Reviewer、可选型号、理由、备选、允许路径、依赖、交付、测试及用户验收项。
5. 每项任务都写明准确工作路径、必读资料、停止条件。用户验收项使用日常语言，例如“能打开并找到成果”，技术验证写到测试与 Review 项。默认新增费用为零。
6. 调用 `export_execution_order`，返回实际落盘的 RUN.md。把入口交给用户，用户在相应 Agent 会话中转发。不要代报执行者接单。

团队与模型由用户配置，按当前职责、任务要求和实际资源选人。模板不代表已购买订阅。Grok Build 只做审查；具有同类任务能力的其他成员也可担任 Reviewer。作者及同入口副本不能自审。多个入口共用的额度按同一池记录，多窗口分别判断。读取 `reviewer_resources` 和 `review_policy`：有效窗口剩余不超过 10% 时停止新派审，缓存低值在重置前仍受此限制；过期或未知资源不推算满额。Grok 没有默认优先权。

## 执行与交付

`submit_task_plan.tasks` 按建议执行顺序提交；真正的前置关系写入 `dependencies`，只在正文描述不会建立依赖。项目中的步骤由依赖关系生成，同阶段任务可并行。同一 Agent 的可执行任务按原计划顺序组成建议队列，复制执行单不会跳队。

项目上下文、派单上下文与任务详情中的 `execution` 提供步骤、前序名称与状态、队列位置、当前工作和后续任务。前序仅在 `accepted` 后解锁；返工按明确登记的后续任务继续判断。缺失、取消或循环依赖需规划者核对。导出、派发和接单都会校验前序；旧执行包保持原内容。队列用于建议，不强制串行，路径冲突仍由规划者判断。

页面收起长需求只影响展示。规划与编辑继续使用完整的 `request.text`。

执行者先读取当前 Run 的简版 RUN.md 或 get_run_context，再通过 report_run_activity 报告 started。同会话返修用 mode=delta 和已确认 context_hash，只补本轮变化；丢失上下文时重新读取 brief，确需原文时读取 FULL-RUN.md 或 mode=full。回执身份、版本和序号由程序填写，旧执行包仍兼容原协议。参见 [简版执行](COMPACT_WORKFLOW.md) 与 [执行协议](EXECUTION_PROTOCOL.md)。审查结论仍由独立审查者回传。

submitted 需包含完整结果与实际产物。完成 Review 时记录真实审查来源及对应 hash；执行者完成收尾后，用户自行确认通过或退回。换人、返工使用新 Run，历史保持。发现范围、费用或权限缺口时报告等待/阻塞，并写清需要用户决定的内容。

## 生成与回传独立审查单

1. 主 Agent 交付后调用 `get_review_candidates({task_id})`，取得当前候选、额度和 revision。按能力、用户指示和资源选人。
2. 调用 `export_review_order({run_id,reviewer_id,expected_revision,reason})`，把返回的 `entry` 交给用户复制。指定其他审查者时必须正式改派，生成新单。
3. 审查单保存在该 Run 的 `reviews/RA-…/REVIEW.md`，包含需求、检查清单、交付文件和版本，以及接单、读取上下文、提交报告的完整命令。复制后仍待接单。
4. 本机审查 Agent 按单内 PowerShell 命令依次执行 `started`、`context`、`submit`。命令直接使用内置 Node 和加载器，不依赖系统 npm/PATH。Windows 的 `--import` 参数须保留 `file:///` URL，中文和空格使用 URL 编码，不能改成盘符绝对路径。
5. 也可按单内配置使用 `WORKBENCH_REVIEW_ID` 独立 stdio MCP；其工具只有 `get_review_assignment`、`report_review_started`、`submit_review_result`。与 `WORKBENCH_RUN_ID` 互斥，凭据由本机读取。
6. 提交完整 `report_markdown`、结论、问题、证据和未验证项，绑定本次 Task/Run/RA/digest。无法访问本机的 Agent 返回单内示例格式 JSON，由用户“导入审查回执”。
7. 完整报告入库并落盘为 `REPORT.md`；页面可展开或下载，原执行者可用 `get_run_feedback` 读取。要求修改时“复制修改意见给执行者”生成带报告的新 Run；通过后交回原执行者完成收尾，随后由用户确认。

改派或撤回后旧权限及旧结果失效。通用审查回传与用户导入分别标记来源；真实 Grok 会话可用 `get_review_context` 和 `submit_grok_review` 核验，需要本机支持 trace 的 Grok CLI 与 tar。人工误登记可在验收前撤回并保留原因。

## 图解

`create_project_diagram` 使用本地 Archify 渲染项目任务总览或经 schema 校验的候选结构。图解在项目固定入口查看，作为成果保留。图解本身不推进任务状态。

## 会话管理与收尾

默认 MCP 连接为 manager，可直接办理用户交代的日常管理；只规划连接设置 WORKBENCH_ROLE=planner。单据回报分别设置 WORKBENCH_RUN_ID 或 WORKBENCH_REVIEW_ID，不能混用。工具发现、CLI 入口和完整规则见 [会话管理](CONVERSATION_MANAGEMENT.md)。

派审使用 delivery_mode=manual 时，待转发属于用户待办；delivery_mode=agent 时由执行者负责调用真实独立审查客户端，Reviewer 本人接单后才进入审查中。调用失败用 report_review_handoff 回报，再安排新的审查单。

审查 passed 后进入 awaiting_closeout。执行者调用 get_closeout_context / export_closeout_order，报告 closeout_started，逐项完成后报告 closeout_completed，进入 awaiting_confirmation。规划和交付可填写 closeout_items；review_files 固化受审源文件指纹，文件改变需新 Run 重新审查。

manager 不能代写独立审查结论，也不能导入执行或收尾回执。已有结论后改派、撤回、验收与退回，由管理工具准备确认卡，用户在首页亲自确认。Agent 不得通过鼠标或脚本代点。执行者只能通过本 Run 连接回报；纯网页 Agent 的签名回执由用户导入。
