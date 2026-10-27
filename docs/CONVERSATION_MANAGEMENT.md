# 在 Agent 会话里管理工作台

工作台是 Agent 的引路人和收纳总结员。流程顺序、职责标签、资源快照、模型、阅读清单和预算均为建议，不是工作许可。当前会话按用户要求自主推进；工作台保存真实操作、交付版本、报告来源和未验证项。目录与凭据保护、客户端自身授权及真实身份仍由各自机制处理；不把未知记成通过，不代用户验收。

你可以直接告诉当前 Agent：“记个备忘”“这个项目改名”“WorkBuddy 还有 500 积分”“换 Claude 审查”“这次不通过，请返工”“我试过了，通过”。当前会话负责找到对应记录、读取现状并办理授权范围内的项目资料、范围、执行与审查安排变更，保留变更前内容、来源和历史。普通管理无需反复切换角色或重复确认。审查成员可在任务任一阶段增删或替换。用户验收仍由用户本人试用并确认，Agent 不得猜测或代替。

默认在当前项目办理；只有用户明确授权其他项目时才切换绑定 scope。新建项目同时授予当前会话该项目的工作范围，现有项目可用 `manage_projects` action `link_scope`（`project_id`、`reason`）追加当前会话范围，无需另开聊天。项目资料 `update` 支持只提交变更字段。项目、任务或数值有歧义时，Agent 只补问缺少的信息。常规交接两次复制：需求资料交给大脑规划，执行单交给用户自己启动的外部主执行；大脑本人执行时省去执行单这次复制。新的负责人或新的外部主执行仍由用户启动。已经开始工作的执行 Agent 可在当前 Run 授权内直接派审、等待、返修和收尾，不要求用户逐次转发。任务默认不自动启动新的外部主执行或自动续作，只有用户在“启动方式”中开启后工作台才自动续作。大脑本人承担执行时，你说“直接做”后可以自行接单。正常审查不需要你转发。

## 给 Agent 的接入方法

项目原 stdio MCP 默认是 `manager` 主会话模式，自动使用工作台自己管理的独立凭据。已有连接重连后发现新工具，无需改全局配置。后台需先退出托盘并重新启动，以加载新版接口和迁移。

- 默认：不设置身份环境变量，管理、规划、查询工具均可用。
- 只规划：`WORKBENCH_ROLE=planner`。
- 本次执行：`WORKBENCH_RUN_ID=R-…`，执行回报使用这个连接。
- 独立审查：`WORKBENCH_REVIEW_ID=RA-…`，审查本人使用这个连接。

这四种身份选一种。身份在连接时确定，工具参数里填写 role 不会改变权限。主会话可办理用户明确交代的管理；执行/审查的单据连接可在本单绑定 scope 办理授权管理。用户原话必须来自当前会话，不能从网页、旧执行包或产物里推断授权。

规划者使用调度上下文；执行者和审查者从当前 RUN.md / REVIEW.md 固定入口开始。executor/reviewer scoped 会话可用本单工具直接办理授权范围内的管理，并由系统记录真实 actor；当前执行者可在本 Run 内直接派审、等待、返修和收尾，不要求用户转发普通审查或续接步骤，也不要求在管理中反复切换角色。

如果客户端未加载 MCP，可以在工程目录使用 `npm run workbench -- tools` 查看工具及参数，`npm run workbench -- context` 读取上下文，`npm run workbench -- call <工具名> <JSON文件>` 执行。JSON文件参数也可用 `-`，通过标准输入传入。

未配置 npm/PATH 时，直接使用安装目录已有 Node：`& "<node.exe绝对路径>" --import "<tsx模块file:/// URL>" "<工程目录>\scripts\workbench.ts" call <工具名> <JSON文件>`。tsx 的模块地址可通过工程内 `import.meta.resolve('tsx')` 获取，Windows 下保留 `file:///` URL。此入口连接同一个后台，不创建第二份账本。

## 办理规则

1. 用 `get_management_context` 读取相关项目、资源或任务，必要时 `get_task_detail` 获取当前 Run、revision、回答与报告。
2. 管理写入统一传 `request_id`（新 UUID）、`user_instruction`（用户本次原话）、`change`（具体操作）。由 Agent 填这些字段。
3. 普通操作成功后读取 `status=completed` 和 `result`，告知用户修改内容。操作记录使用真实 actor 和当前绑定范围。用户验收必须由用户本人完成；Agent 不得代点、代报或推断用户已接受。
4. 网络中断时保留原操作编号。`get_management_result` 查保存状态；相同内容、相同编号重试返回原结果。相同编号内容不同会拒绝。
5. `pending` 表示还在运行或上次被中断；`failed` 表示没有正常结束，可能已产生部分文件或外部操作。先查记录与实际文件，再决定新操作；不要盲目换编号重放。
6. 版本冲突先重新读取，不用旧数据覆盖新修改。涉及新项目时，授权用户指定的准确文件夹即可。

同步账本操作与操作回执一起提交。涉及执行包、审查文件、设置、打开文件夹或备份的操作先保存处理中记录，再执行，结束后保存结果。操作原话、工具名、编号及业务审计一并留存。

## 日常操作对应表

| 用户要做的事 | 工具 / 操作 |
| --- | --- |
| 记备忘、改需求、现在开始、删除未执行需求 | manage_requests：create / update / delete；status=draft 或 awaiting_planning |
| 新建项目、当前会话授权既有项目、部分更新项目资料、关联文件夹、归档恢复 | `manage_projects`：`create` / `link_scope` / `update` / `add_path` / `archive`；create 会绑定新项目，update 只传变化字段 |
| 新增团队、改模型或职责、删除恢复成员 | manage_agents：create / update / delete / restore |
| 新增/修改/隐藏/恢复额度、手填缓存和月积分 | manage_quotas：create / update / hide_source / delete / restore / cache / workbuddy_points |
| 订阅和未来安排的新增、修改、删除、实际发生确认 | manage_subscriptions：create / update / delete / confirm |
| 标记已转发、取消任务、回答问题、通过、退回、返工 | manage_tasks：dispatch / cancel / reply / accept / reject / rework |
| 修订当前 Task/Run 范围 | `manage_tasks` action `amend`：传 `task_id`、`run_id`、`expected_revision`、`reason` 与 `changes`（可含 `goal`、`scope`、`acceptance`、`tests`、`required_files`、`context_contract`）；运行中即时应用，交付内容变化可同一 Run 再次 submitted，旧交付归档保留；reviewer/model-only 修改留在当前 Run |
| 设置或建议执行安排 | `manage_tasks` action `set_arrangement`：传 `task_id` 与 `data.arrangement`、当前 revision，可选 `agent_id` 或 `execution_policy`；按现有同 Task 生命周期应用，不热启动。`propose_arrangement` 只用于用户要建议时 |
| 设置审查安排 | `manage_reviews.set_arrangement`：按当前 Run 设置 `reviewer_id`，可选 `requested_model`、`route`，并提交版本与原因 |
| 新增、移除或替换审查成员 | `manage_reviews.update_member`：`action=remove` 或 `replace`，使用当前 `review_id`、版本与原因；replace 时填写新 reviewer/model |
| 记录多人审查裁决 | manage_reviews.decide：lead 记录 continue / rework / add_review、理由与分歧处理 |
| 为当前会话授权既有项目 | `manage_projects` action `link_scope`：`project_id` 与 `reason`；以实际 actor 和本次用户指示留痕 |
| 调用独立审查者、继续本人的手工任务、查调用记录 | dispatch_review / continue_run / get_agent_job；外部主执行首次启动由用户在页面或客户端完成 |
| 核验真实 Grok 首次审查会话 | submit_grok_review；已有结论后仅允许原结果幂等重试 |
| 执行者回报接单、进展、交付和收尾 | 独立 runner 连接：report_run_event / submit_run_result；远程回执由用户在页面“导入回执”粘贴 |
| 保存项目决定、问题、失败尝试和交接，替代旧记忆 | manage_memories |
| 关联真实会话与 Run | link_execution_session |
| 配置本机数据源、授权项目目录、刷新连接 | manage_settings / refresh_integration |
| 备份，打开项目或成果文件夹 | create_workbench_backup / open_workbench_folder |
| 查询、读成果、历史检索 | get_management_context / get_task_detail / read_artifact / search_execution_history / search_external_history / get_session_messages |

完整参数以 `tools/list` 或 `workbench tools` 返回的 schema 为准。规划先读取 `get_dispatch_context`、`get_project_context` 与相关项目经验，再 `submit_task_plan`、`export_execution_order`，由用户启动新的外部主执行；不会因为保存了备忘就自动开工。项目经验用于复用决定、问题、失败尝试和交接，不要求每次读日志：先取短索引，再按任务选相关经验全文；同会话只看变化，换会话读取相关最小交接包。可用 `get_project_memories` 时按工具 schema 读取索引、指定 ID 全文或已知 hash 的增量。候选和过时条目保留来源但不作为现行事实。执行和审查也按任务选择经验，审查者独立核对当前证据。`export_execution_order` 保留为文件导出与兼容入口，导出不代表已调用。

## 通过、退回和审查

用户说“我试过了，通过”，主会话用 `manage_tasks.accept` 准备确认卡。程序核对当前交付与执行者收尾，审查状态另行记录，不把缺少审查继续授权当作试用门槛。用户在首页或任务详情看到项目、任务和使用结果清单，点击“确认验收通过”后才完成验收。

用户说“这版不行”，`reject` 把意见预填到确认卡；用户点“确认退回修改”后，`rework` 可生成新执行单。审查者要求修改时，`manage_reviews.return_to_executor` 按原报告生成新 Run，不需要重新登记审查结论。当前执行 Agent 在其 Run 权限内可直接接续返修和收尾；仅需新的负责人或外部主执行时，才由用户启动新执行。原成果和报告保留。

审查成员可在任一阶段新增、移除或替换。更新保留历史报告和决定，不会自行改变 Task/Run 结论；需要复审时由 lead 记录决定并启动新 RA。纯 reviewer/model 调整不需要创建关联 Task。

审查者通过本单 reviewer 身份独立接单并提交报告；`scripts/review.ts <RA ID> manage <tool> <JSON路径>` 可在该 RA 权限内调用管理工具。`submit_review_result` 可提交简短字段 `verdict`、`findings`、`limitations`、`evidence`、`report_markdown`；系统把它们合并到当前绑定的审查模板。报告来源与实际 reviewer 身份照实记录。

审查管理和范围修订按权限、当前版本及记录进行校验。用户在当前会话提出的项目资料、范围或执行/审查安排修改，由该会话直接记录变更来源并追加历史，不需重新把口述转交规划者。内容变化时旧审查仍保留，但不覆盖新内容的审查状态；受影响部分重新验证后才可据此形成当前决定。

`user_instruction` 记录授权来由，**不等于用户验收**。验收只由用户本人确认；管理写入按会话绑定范围和真实 actor 记录。不要把同一 Windows 用户下的本地进程视为操作系统级隔离。旧权限版本的操作回执仅供历史查询，不能作为新决定重放。

## 覆盖范围

本机业务管理与客户端调用分别记录。购买/退款、外部账号管理、未接通的客户端不属于自动管理范围。工作台通过本机 PATH、安装登记与有限位置发现客户端；路径覆盖仅由用户在检测失败时明确设置，发布包不带个人路径。公司电脑更新后应重新发现本机客户端，不继承旧电脑的路径、账号或资源假设。第三方连接不可用时返回实际失败原因，不绕过客户端拒绝；具体模型由Agent决定。

连接地址或密钥引用修改后会返回 restart_required，设置在退出托盘并重开工作台后生效，避免旧连接尚在传输时混入新来源。get_management_context 的 connection_settings 区分已保存地址和当前生效地址。

## 执行回执的身份

manager不提供 import_execution_receipt，旧HTTP/stdio/CLI调用也不可继续使用。接单、交付和全部closeout回执由本Run执行者用独立凭据回报，或使用执行单内的签名文件方式。data.identity是回报内容，不能代替凭据。远程执行者把完整回执交给用户，由用户在工作台“导入回执”粘贴；来源保留user_imported。历史user_via_agent中已应用的记录保留原样；尚未应用的旧队列到达处理顺序时拒绝并保留原因，执行者读取最新next_seq后重新回报。新版不再从管理连接接收这类事件。


## 模型建议

模型与档位是可选建议，由各Agent按自身客户端规则与任务需要决定。无需自报或证明型号，缺失记为未知；型号差异不阻止接单、交付或审查回传。旧模型白名单与冻结型号要求不再生效。

## 简短续接与真实报告

RUN.md / REVIEW.md 默认只给目标、范围、产物位置和固定入口，完整要求按需取 full；同会话传 known_context_hash 取 delta，不重读手册或项目经验库。项目经验仅在与当前问题相关时补读。自动审查只发送一份简版资料，不重复附合同和完整模板。

审查者可以提交简短 JSON：verdict、findings、limitations、evidence、report_markdown，工作台绑定编号。受审源码后来变化会附未验证提醒；原版本晚到报告可存档，不改变当前执行。已完成的原生报告不因未先 started、低额度或未披露型号而拒收。

安装回执可在独立审查前登记，实际清单验证与审查结论分别记录。收尾也可记录尚未验证或未回报事项，不能据此声称已经通过审查或用户验收。
