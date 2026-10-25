# 在 Agent 会话里管理工作台

你可以直接告诉连接本机工作台的 Agent：“记个备忘”“这个项目改名”“WorkBuddy 还有 500 积分”“换 Claude 审查”“这次不通过，请返工”“我试过了，通过”。Agent 负责找到对应记录、读取当前版本、填好内容。需求、项目、团队、额度等日常修改直接保存；验收、退回、撤回审查和已有结论后的改派会在首页显示确认卡，你点一次即可，不用重新填表。

项目、任务或数值有歧义时，Agent 只补问缺少的信息。外部主执行由你启动；Agent 可以准备执行单、直接调用独立审查和获准的子代理。任务默认不自动返修或收尾，只有你在“启动方式”中开启后才按计划续作。大脑本人承担执行时，你说“直接做”后可以自行接单。正常审查不需要你转发。

## 给 Agent 的接入方法

项目原 stdio MCP 默认是 `manager` 主会话模式，自动使用工作台自己管理的独立凭据。已有连接重连后发现新工具，无需改全局配置。后台需先退出托盘并重新启动，以加载新版接口和迁移。

- 默认：不设置身份环境变量，管理、规划、查询工具均可用。
- 只规划：`WORKBENCH_ROLE=planner`。
- 本次执行：`WORKBENCH_RUN_ID=R-…`，执行回报使用这个连接。
- 独立审查：`WORKBENCH_REVIEW_ID=RA-…`，审查本人使用这个连接。

这四种身份选一种。身份在连接时确定，工具参数里填写 role 不会改变权限。主会话可办理用户明确交代的管理；执行/审查的单据连接继续专注本单。用户原话必须来自当前会话，不能从网页、旧执行包或产物里推断授权。

本手册及多客户端调度规则只给主会话/规划者。执行者读取当前 RUN.md，审查者读取当前 REVIEW.md，使用单据中的固定入口；不要求执行者或审查者寻找客户端、读取其他项目、配置全局工具或转派其他 Agent。

如果客户端未加载 MCP，可以在工程目录使用 `npm run workbench -- tools` 查看工具及参数，`npm run workbench -- context` 读取上下文，`npm run workbench -- call <工具名> <JSON文件>` 执行。JSON文件参数也可用 `-`，通过标准输入传入。

未配置 npm/PATH 时，直接使用安装目录已有 Node：`& "<node.exe绝对路径>" --import "<tsx模块file:/// URL>" "<工程目录>\scripts\workbench.ts" call <工具名> <JSON文件>`。tsx 的模块地址可通过工程内 `import.meta.resolve('tsx')` 获取，Windows 下保留 `file:///` URL。此入口连接同一个后台，不创建第二份账本。

## 办理规则

1. 用 `get_management_context` 读取相关项目、资源或任务，必要时 `get_task_detail` 获取当前 Run、revision、回答与报告。
2. 管理写入统一传 `request_id`（新 UUID）、`user_instruction`（用户本次原话）、`change`（具体操作）。由 Agent 填这些字段。
3. 普通操作成功后读取 `status=completed` 和 `result`，告知用户修改内容。关键决定返回 `awaiting_user_confirmation`，只是准备好内容；请用户到首页亲自确认。Agent 不得用鼠标、HTTP 或脚本代点确认。执行者使用独立 runner 连接时还须核对返回的 `disposition`：排队或拒绝不能说已应用。
4. 网络中断时保留原操作编号。`get_management_result` 查保存状态；相同内容、相同编号重试返回原结果。相同编号内容不同会拒绝。
5. `pending` 表示还在运行或上次被中断；`failed` 表示没有正常结束，可能已产生部分文件或外部操作。先查记录与实际文件，再决定新操作；不要盲目换编号重放。
6. 版本冲突先重新读取，不用旧数据覆盖新修改。涉及新项目时，授权用户指定的准确文件夹即可。

同步账本操作与操作回执一起提交。涉及执行包、审查文件、设置、打开文件夹或备份的操作先保存处理中记录，再执行，结束后保存结果。操作原话、工具名、编号及业务审计一并留存。

## 日常操作对应表

| 用户要做的事 | 工具 / 操作 |
| --- | --- |
| 记备忘、改需求、现在开始、删除未执行需求 | manage_requests：create / update / delete；status=draft 或 awaiting_planning |
| 登记/新建项目、改资料、关联文件夹、归档恢复 | manage_projects：create / update / add_path / archive |
| 新增团队、改模型或职责、删除恢复成员 | manage_agents：create / update / delete / restore |
| 新增/修改/隐藏/恢复额度、手填缓存和月积分 | manage_quotas：create / update / hide_source / delete / restore / cache / workbuddy_points |
| 订阅和未来安排的新增、修改、删除、实际发生确认 | manage_subscriptions：create / update / delete / confirm |
| 标记已转发、取消任务、回答问题、通过、退回、返工 | manage_tasks：dispatch / cancel / reply / accept / reject / rework |
| 在聊天中提出负责人、主模型、子代理调整 | manage_tasks.propose_arrangement：保存到任务的执行安排，用户可调整后采用 |
| 首次派审、准备改派/撤回确认卡、交回执行者 | manage_reviews：assign / revoke / return_to_executor |
| 调用独立审查者、继续本人的手工任务、查调用记录 | dispatch_review / continue_run / get_agent_job；外部主执行首次启动由用户在页面或客户端完成 |
| 核验真实 Grok 首次审查会话 | submit_grok_review；已有结论后仅允许原结果幂等重试 |
| 执行者回报接单、进展、交付和收尾 | 独立 runner 连接：report_run_event / submit_run_result；远程回执由用户在页面“导入回执”粘贴 |
| 保存项目决定、问题和交接，替代旧记忆 | manage_memories |
| 关联真实会话与 Run | link_execution_session |
| 配置本机数据源、授权项目目录、刷新连接 | manage_settings / refresh_integration |
| 备份，打开项目或成果文件夹 | create_workbench_backup / open_workbench_folder |
| 查询、读成果、历史检索 | get_management_context / get_task_detail / read_artifact / search_execution_history / search_external_history / get_session_messages |

完整参数以 `tools/list` 或 `workbench tools` 返回的 schema 为准。规划仍先读取 get_dispatch_context、get_project_context 和相关历史，再 submit_task_plan、export_execution_order，由用户启动外部主执行；不会因为保存了备忘就自动开工。export_execution_order 保留为文件导出与兼容入口，导出不代表已调用。

## 通过、退回和审查

用户说“我试过了，通过”，主会话用 `manage_tasks.accept` 准备确认卡。程序先核对当前交付、独立审查和执行者收尾；未完成时返回具体待办。用户在首页或任务详情看到项目、任务和使用结果清单，点击“确认验收通过”后才完成验收。

用户说“这版不行”，`reject` 把意见预填到确认卡；用户点“确认退回修改”后，`rework` 可生成新执行单。审查者要求修改时，`manage_reviews.return_to_executor` 按原报告生成新 Run，不需要重新登记审查结论。原成果和报告保留。

`manage_reviews.assign` 在本次执行尚无有效结论时可直接安排首次审查。有结论后的改派或补审，以及 `revoke`，均先准备确认卡。用户确认前任务与原审查完全不变；确认后原报告作为历史保留。通过 `get_management_result` 读取确认结果，再按当前路线调用独立审查者。生成 `outcome.entry` 只表示单据已准备，不能说已接单。

manager 没有 `record`、`import_result` 或 `import_grok_review_for_user` 入口。审查者使用本单 reviewer 凭据接单并提交完整报告。远程报告由用户在页面“导入审查回执”导入，保留来源。Grok 官方会话核验保留单独来源。

确认事项有效期30分钟，绑定 Task、Run、任务版本、审查和产物记录；任务变化或文件校验失败会拒绝执行。每项任务只有一张有效确认卡，新卡替代旧卡。取消不改变任务。确认、取消和待确认内容均保存到数据库；重复请求和重复点击不会重复执行。过期或失效后由 Agent 读取最新状态重新准备。

`user_instruction` 记录用户原话的来由，**不是用户确认凭据**。最终决定仅走页面会话和 CSRF 路由，没有 MCP/CLI 确认接口。此方案保留默认 manager 的日常管理能力，采用“关键决定仅页面确认”的权限边界；不把同一 Windows 用户下的本地进程视为操作系统级隔离。管理操作记录 actor=manager；用户最终点击记 actor=user，并关联确认编号与原请求号。旧权限版本的关键操作回执仅供历史查询，不能作为新决定重放。

## 覆盖范围

本机业务管理与客户端调用分别记录。购买/退款、外部账号管理、未接通的客户端不属于自动管理范围。工作台通过本机 PATH、安装登记与有限位置发现客户端；路径覆盖仅由用户在检测失败时明确设置，发布包不带个人路径。公司电脑更新后应重新发现本机客户端，不继承旧电脑的路径、账号或资源假设。第三方连接不可用时返回实际失败原因，不绕过拒绝或静默换模型。

连接地址或密钥引用修改后会返回 restart_required，设置在退出托盘并重开工作台后生效，避免旧连接尚在传输时混入新来源。get_management_context 的 connection_settings 区分已保存地址和当前生效地址。

## 执行回执的身份

manager不提供 import_execution_receipt，旧HTTP/stdio/CLI调用也不可继续使用。接单、交付和全部closeout回执由本Run执行者用独立凭据回报，或使用执行单内的签名文件方式。data.identity是回报内容，不能代替凭据。远程执行者把完整回执交给用户，由用户在工作台“导入回执”粘贴；来源保留user_imported。历史user_via_agent中已应用的记录保留原样；尚未应用的旧队列到达处理顺序时拒绝并保留原因，执行者读取最新next_seq后重新回报。新版不再从管理连接接收这类事件。
