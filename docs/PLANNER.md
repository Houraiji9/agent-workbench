# 规划 Agent 手册

工作台是桥梁和记录者。Codex、Claude 或用户选择的其他 Agent 均可担任大脑。大脑理解需求、给出方案；工作台保存方案与资料位置；执行者实施并交回成果；审查者检查本轮内容；执行者收尾，用户亲自试用确认。网页不调用模型，也不靠规则冒充规划。

流程顺序、资源快照、模型、阅读清单和预算是建议，不是工作许可。当前会话按用户指示推进，记录真实来源、变化和未验证项。客户端自己的授权、项目目录与凭据保护仍由各自机制处理。

## 规划与交接

1. 先取 `get_dispatch_context({project_id,detail:"brief"})` 和 `get_project_context({project_id,detail:"brief"})`。已有上下文时只核对变化，不遍历工程。
2. 仅当当前问题需要时，检索 `search_execution_history` 或 `get_project_memories`。默认结果是定位摘要，按具体引用补读；不把整个历史或经验库塞进新会话。
3. 根据用户要求、能力与当前客户端状态安排负责人和独立审查。用户选择优先，具体型号由 Agent 自主决定；不强制自报或证明型号。
4. 用 `submit_task_plan` 保存真实模型写的计划。小需求通常一项任务，确有独立交付再拆；真实依赖填 `dependencies`，顺序是建议。
5. 写清目标、方案、成果地址和完成条件。方案可用 `scope`、`context_contract.plan.content` 或已有方案的 `plan.path` 保存。首读资料、条件补读、各角色入口及审查重点按需附上，不强制凑不相关字段。结构示例见 [方案交接](TASK-HANDOFF.md)，不要求执行者再读本手册。
6. 导出执行单。外部主执行由用户启动；大脑本人执行且用户说直接做时，自接 scoped Run。导出或复制不等于已启动。

模型目录和额度只供参考，实际安装、登录及调用状态由工作台发现与记录，不要求大脑重复搜安装路径。普通需求优先经济且胜任；用户明确选的负责人不擅自换人。审查成员可按要求增删或替换，人数不限于两个。

## 交付与实际操作

`delivery_profile` 分开记录成果类型与部署：源码、软件、服务、文档、媒体等；部署可为本机、线上或无部署。保留用户明确选择；继承设置供参考，用户选“由大脑安排”时按需求决定完整交付。填写实际目标、部署、健康检查与回滚办法。

工作台便携本机安装使用 `verification=portable_manifest`；其他部署使用 `executor_reported` 如实记录。安装验证、审查结论与用户验收分开，不把未做的事情记为通过。

新的外部主执行由用户启动。当前执行者可直接派审、等待、返修和收尾，不让用户重复转单。任务“启动方式”的自动续作开关只控制工作台是否另起/恢复主执行客户端；当前会话继续处理不需要再次授权。子代理按实际需要调用并登记结果，模型设置是建议。

## 变更、审查与续接

用户口述调整由当前会话直接保存。项目资料用 `manage_projects`；任务方案与资料用 `manage_tasks.amend`；执行安排用 `set_arrangement`；审查成员用 `manage_reviews`。保留原值和来源，不为 reviewer/model 变化造空任务。详细参数以当前 MCP schema 为准。

执行者通过 Run 固定入口报告 started、submitted 和收尾。已有上下文不重新通读执行单；需要单项资料时用 `get_run_context(section=plan|files|requirements|history)`。同会话传已知 hash 取 delta；未知 hash 返回当前简版。文件清单是导航，可以因实际关联补读，并记录原因。

审查者先看本轮差异、方案和指定证据，围绕改动及直接影响选择验证；发现风险再补读，不默认遍历工程或全量测试。同会话复审只给新变化和未解决问题。审查结果可直接返回 `verdict/findings/limitations/evidence/report_markdown` 的 JSON，工作台绑定当前单据并保存。型号未知照实保留，原生报告不因缺少接单回执或额度快照而拒收。独立报告必须来自实际审查者。

当前 Run 可继续补交新产物，旧版本报告和交付保留；报告只对应实际检查的版本。收尾可记录尚未验证事项，不能因此声称已通过。最终用户验收只由本人完成。

## 接入与普通聊天

本机支持 MCP 的客户端可使用同一 stdio 服务；以下是配置字段示例，实际路径由本机工作台发现，不固定品牌或安装路径：

```toml
[mcp_servers.agent_workbench]
command = "<workbench-discovered-node>"
args = ["--import", "<workbench-resolved-tsx-file-url>", "<workbench-root>/src/mcp/index.ts"]
[mcp_servers.agent_workbench.env]
WORKBENCH_ROOT = "<workbench-root>"
```

默认连接是 manager；只规划可用 `WORKBENCH_ROLE=planner`。执行和审查用各自单据的固定入口，凭据不写入提示或公开文档。无 npm/PATH 时执行单自带 Node 与 file URL，无需重新寻找客户端。

普通聊天可以接收工作台复制的精简资料，返回 JSON 计划交给工作台预览保存。配置了 `chat_planner` MCP 的聊天可用 `get_chat_planning_context` 和 `submit_task_plan`。未披露规划者/model 时保留未知，不预填 Codex。聊天模板是结构示例，不能当作已完成方案。

更多日常管理入口见 [会话管理](CONVERSATION_MANAGEMENT.md)。执行者和审查者不必每次重读规划手册。项目经验仅用于相关的决定、已知问题、失败尝试与交接点，按需查询。
