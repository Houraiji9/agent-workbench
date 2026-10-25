# Codex 接入与规划手册

本手册只供规划者和 manager 主会话读取。模型负责理解需求、选执行者和独立审查者、决定顺序及处理失败；工作台负责客户端发现、权限、调用、状态与持久化。执行者只接收当前 Run 的范围和固定回报入口，审查者只接收当前 RA 的范围和固定审查入口，不向它们附送多客户端调度手册。

## 大脑的职责与用户决定权

大脑负责出计划、安排负责人和子代理范围、选择独立审查者，并跟进交付。外部主执行由用户启动：导出执行单后提供入口，用户可以在客户端接单或在工作台点击启动。大脑不直接拉起外部主执行。若大脑本人就是执行者，用户说“直接做”后可用自己的正式 Run 接单，无需另开客户端。

用户指定的负责人和模型优先于经济性建议。例如用户要求 Opus 总负责、Sonnet/Haiku 分工，应保留 Opus 的方案与整合责任，不能把主单改派给 Sonnet。每项委派给出所需文件、条件补读和项目内产物位置；是否使用子代理、用哪些模型由本轮用户设置决定。用户可随时在同一任务修改后续安排；当前会话不会被悄悄更换模型。

主执行的自动返修/收尾与独立审查分开控制。新旧任务都默认“由我启动”；只有用户在任务“执行安排 → 启动方式”开启后，工作台才按已有计划自动续作。规划参数和会话原话不能代替这个开关。手工接管后的失败调用保留历史，不再触发自动主执行。执行者仍可直接调用独立审查和已授权子代理，无需用户转发。

会话中修改安排时，manager 使用 `manage_tasks.propose_arrangement` 保存建议；任务页可调整后采用。建议不会冒充用户选择，也不会更换当前 Run。执行说明、模型与子代理安排在用户采用后按任务阶段进入当前或下一版执行单，旧成果和审查保留。

## 接入

先启动工作台，再在使用的项目配置中添加 stdio MCP。以下为安装位置示例，替换为本机真实安装根；不要写入凭据，也不要把示例当作固定客户端路径。

```toml
[mcp_servers.agent_workbench]
command = 'C:\Tools\AgentWorkbench\桌面版\工作台\resources\runtime\node.exe'
args = ['--import', 'file:///C:/Tools/AgentWorkbench/node_modules/tsx/dist/loader.mjs', 'C:\Tools\AgentWorkbench\src\mcp\index.ts']

[mcp_servers.agent_workbench.env]
WORKBENCH_ROOT = 'C:\Tools\AgentWorkbench'
```

源码运行可使用已安装的 Node 24+。MCP 从本机数据目录读取自己的管理凭据，调用同一后台；端口与数据目录须和桌面版一致。程序不修改全局 Agent 配置。默认身份是 manager；只规划连接设置 `WORKBENCH_ROLE=planner`。执行和审查连接分别使用 `WORKBENCH_RUN_ID`、`WORKBENCH_REVIEW_ID`，四种身份不能混用。

## 规划步骤

需求规模与重要程度分别处理。`workflow_kind=small` 只限制拆单数量，不降低重点需求的模型或审查要求。`importance=normal` 优先经济且胜任的模型；复杂工作升级时写清原因。`importance=critical` 用当前可用最高能力档承担主执行、所有允许的子代理和独立审查，必须完整审查。资源无法满足时明确回报并重新规划，不能静默降档、改成有限审查或免审。

新计划用 `model_selection` 记录 `strategy`（`adequate_economical` 或 `best_capability`）、`main`、`review`、`children`（每项含 `agent_id/model/reason`），以及 `evaluation` 的 `criteria/catalog_as_of/considered`。候选评估逐项包含 `agent_id/model/capability_assessment/capability_reason/availability/availability_reason`；所选模型必须有 available 的依据，重点所选模型须评为 best_capability。`fallback_policy` 固定为 `stop_and_replan`，普通需求升级最佳档另填 `upgrade_reason`。能力比较由真实规划模型完成，程序不按型号名称或价格硬排能力；评估是规划者决策，不冒充实际模型身份核验。用户明确的模型/子代理设置优先，若与重点要求冲突应重新规划。

交付用 `delivery_profile` 分开表达成果与部署：`artifacts` 可多选 source/software/service/document/media/other，`deployment.mode` 为 none/local/remote/other。项目默认在需求中保存，单需求可覆盖，执行单冻结本轮选择。规划时保留用户已填内容，补齐部署 `target/deploy/health/rollback`。线上机器人可以交付源码及在线服务，无需本机程序目录。`verification=portable_manifest` 仅用于工作台便携本机安装；其他实际部署用 `executor_reported`，无部署用 none。选择线上部署不能扩大项目权限或费用授权。

1. 调用 `get_dispatch_context({project_id,detail:"brief"})`，读取团队、资源、客户端发现状态和待办摘要；只在确有需要时请求 full。
2. 调用 `get_project_context`，确认目标、源码目录、运行目录、交付目标、正式记忆和任务依赖。需要旧材料时再调用 `search_execution_history`。
3. 按当前用户指示、能力、独立性与资源选执行者和审查者。读取 `reviewer_resources`、`review_policy`，有效窗口剩余不超过 10% 时停止新派审；未知或过期额度不推算满额，Grok 没有默认优先权。团队登记、客户端存在、登录状态、模型可用、剩余额度分别判断。
4. 调用 `submit_task_plan`，按建议顺序提交任务，将真实前置登记为 `dependencies`。计划明确 `execution_route`、`review_route`，每条路线为 `{client,model,provider?}`；客户端当前支持的类型以工具 schema 与发现结果为准，不能按客户端名称猜实际模型。旧任务缺少路线时不会自动启用。
5. 新任务显式填写 `automation_policy`：`auto_review`、`auto_rework`、`continue_after_review`、`max_rework_rounds`（1–5）。自动主执行还必须取得任务页的用户开关许可，路线与规划策略本身不是启动授权。返工达到上限、范围变化或权限不足时交回规划者；免审选择仍按用户的既有设置处理。
6. 填写工作路径、允许路径、停止条件、交付和测试。`context_contract` 记录 `required` 文件清单（`path` 与可选 `range:{start_line,end_line}`）、`supplemental` 补充清单（另含 `reason`）、项目内 `output_dir` 与 `max_bytes`（默认 65536）。程序据此提供当前范围的资料，缺材料时明确补读理由；不扩大目录权限。
7. 用户验收项使用日常语言；技术验证写到测试与 Review 项。默认新增费用为零。计划保存后用 `export_execution_order` 建立当前 Run，将入口交给用户选择启动。本人执行时直接用自己的 scoped Run 接单。查询 `get_agent_job` 和任务回执确认实际调用、接单及交付；导出执行单不等于已经启动。

任务标题与计划顺序、依赖、可并行关系须清楚。前序在正式 `accepted` 后解锁；缺失、取消或循环依赖由规划者核对。导出、派发和接单都校验前序。队列是建议，路径冲突仍由规划者判断。页面折叠长需求不改变完整 `request.text`。

## 本机客户端与失败处理

工作台在本机 PATH、安装登记和有限的已知位置发现客户端，不扫描整盘。发现缓存和用户路径覆盖属于本机配置，不能打进公开包。换电脑、安装升级或路径失效后重新检测；不能沿用另一台电脑的安装路径、账号和订阅假设。

规划上下文只提供客户端类型、版本、能力和失败原因，不需要原生可执行文件路径。用户在“设置 → Agent 客户端”刷新；自动发现失败时才展开高级修复，明确指定本机已安装程序路径。指定路径不解决未登录或无权限问题，也不能绕过客户端拒绝。

调用状态为 `queued`、`launching`、`running`、`completed`、`failed`、`interrupted`。客户端进程结束不等于交付成功、审查通过或用户验收。错误保留具体原因；缺客户端、登录/权限需处理或重大决定才请求用户行动。正常派审、报告回传和续接由规划者与工作台处理，不把转发工作推给用户。

不擅自换模型、扩大预算、修改全局 Agent 配置或绕过安全拒绝。Harness 可保存正常会话缓存；主动创建的日志、脚本、报告和临时产物均在项目授权范围。清理时不再手动删除：确认不再使用的本轮临时内容移入项目根“待清理”目录，记录原路径、新路径和原因，由用户删除。先核验范围、链接和占用；保留验证证据、有效成果、正式记录及仍被占用的文件，受阻内容留在原处并说明原因。

## 执行、审查与续接

执行者按当前 `RUN.md` 的固定入口读取 brief，确认 context hash，并回报 started；需要时使用 delta 和已确认 hash 补充变化。丢失上下文返回 reset_required，重新读取 brief；确需全文时读取 full。程序填写固定身份、版本与序号，不让执行者重新寻找客户端或管理凭据。详见 [简版执行](COMPACT_WORKFLOW.md) 与 [执行协议](EXECUTION_PROTOCOL.md)。

交付后启用的 `auto_review` 按已登记路线安排独立审查；需要显式安排时，规划者先 `get_review_candidates`，再 `dispatch_review`。实际导出 RA、调用及回报分别留存。作者和同入口副本不能自审，执行者不能代写结论。`export_execution_order`、`export_review_order` 仍可生成兼容文件入口，但导出/复制不等于发送或接单。仅在远程客户端无法连接本机或用户明确选择手动处理时使用人工转发与回执导入。

审查者只读本 RA 的 `REVIEW.md`，使用其中固定命令或独立 reviewer MCP 报告 started、读取当前证据、提交完整报告。Windows `--import` 保留 `file:///` URL。报告绑定 Task/Run/RA/digest，记明实际证据、未验证项与限制；完整报告入库并保存为 `REPORT.md`。旧 Review 不适用于新增代码，改派或撤回使旧单权限失效。

要求修改时保留旧交付，建立新的正式 Run。外部主执行由用户启动；仅用户已开启自动续作且任务策略允许时，后台才可自动返修。达到限额或失败时规划者处理。`continue_run` 优先使用已记录的真实客户端会话续接，并提供本轮增量；没有可用会话或客户端不支持恢复时如实返回原因，按调用参数选择新会话，不伪称已继承历史。不根据聊天顺序猜任务因果。

审查 passed 后进入执行者收尾，由本 Run 执行者完成；`review_files` 固化受审源文件指纹，变化需新 Run 审查。交付目标为本机程序时，实际安装校验通过后才能完成收尾。用户亲自试用确认后才 accepted，manager 不能代写执行回执、审查结论、收尾报告或代点验收。

## 日常管理

需求、项目、团队、额度和订阅按 [会话管理](CONVERSATION_MANAGEMENT.md) 操作。已有审查结论后的改派、撤回、验收与退回先准备确认卡，由用户亲自确认；Agent 不得通过鼠标或脚本代点。

`create_project_diagram` 使用本地 Archify 渲染项目任务总览或经 schema 校验的候选结构，作为成果保留；图解不推进任务状态。所有历史执行包与已冻结交付保持原内容。

## 普通 GPT 聊天规划

`WORKBENCH_ROLE=chat_planner` 是受限的规划连接，只开放 `get_chat_planning_context` 和 `submit_task_plan` 两个工具。它只能读取指定需求的规划资料并提交计划，不能执行任务、安排客户端调用或验收。普通 GPT 聊天不会自动连接工作台；只有用户明确配置了该连接后才可使用。

没有 MCP 时，使用界面复制的需求资料作为规划输入，接收完整计划后交回工作台预览；用户确认分工后再保存。小需求计划最多三项任务。不要把复制资料或聊天回复当成已经提交、派发或执行。

计划可提供 `planner: {name, model}`，无法确认的值保留 `null`。工作台从实际认证入口记录接入方式与角色，将名称/模型视为规划者自述，不当成经验证的模型身份。不能用计划正文覆盖接入方式或把未知规划者写成 Codex。项目 `execution_policies` 按 Agent ID 保存默认模型，只适用于对应成员；通用 `execution_policy` 不固定模型，需求/任务明确设置仍优先。

根据当前项目、团队、客户端和可用模型资料来选主模型及子模型，只选择已知可用且符合本轮权限的型号；未知或过期的目录不能当成可用证明。项目默认策略提供参考，本次需求或任务明确的用户选择优先。标准独立审查为默认；只有用户明确选择并说明原因才免审。有限审查必须由用户提供具体 `review_focus` 检查点，不能由规划者自行缩小审查范围。

新 Run 以 `context_contract.required` 中的文件和行范围为本轮审查/实施入口；必要补读应按理由登记在 `supplemental`。不得要求执行者或审查者为了熟悉项目而重读全部旧执行历史或无关文件。
