# 执行包与回执协议 v1

本文件是协议参考，不是每个执行/审查会话的必读调度手册。执行者从当前 Run 的 RUN.md 开始，审查者从当前 RA 的 REVIEW.md 开始，按其中固定入口读取本轮范围并回报。多客户端路由、发现和自动策略只给规划者，见 CODEX_PLANNER.md。

## 客户端调用与业务回执

执行单固定本轮 `importance`、`model_selection`、`delivery_profile`。重点需求主执行、子代理与独审均遵守规划者已明确选择的最佳能力模型，资源不足或实际型号偏离时回报并重新规划，不静默换用默认型号。缺失真实模型身份时保留 unknown，不推测实际使用了指定型号。

通用部署（远程服务、其他本机软件等）交付时在 submitted 的 data 填 `delivery_version`。审查通过或用户明确免审后，执行者调用 `get_deployment_context` 取得本 Run、目标档案指纹、版本、完整产物集合与审查绑定；实际部署后用 `report_deployment_evidence` 提交 `deployment_evidence/health_evidence/rollback_evidence`。CLI 对应 `agent.ts <Run> deployment-context` 与 `deployment-evidence <JSON文件>`。这类回执明确标注“执行者报告，服务端未验证实际部署”；不能冒充工作台已连接服务器。收尾与用户验收重新核对绑定。工作台便携安装继续使用 `report_runtime_deployment` 的清单、全部受管文件、版本和目录核验。

同项目连续合法更新可在收尾/验收记录后继版本依据：仅接受时间后继、独立审查通过且具有有效部署证据的版本，包括用户已经验收的后继版本。便携版本以当前安装清单和全部受管文件为依据；该版本所属任务后来返工，不会仅因 current_run_id 改变就抹去仍有效的已审部署事实。旧 Run 仍须保留提交状态、有效独审、匹配的归档产物及部署回执，源码当前哈希也必须有受审记录覆盖。后继版本的审查者须同时独立于当前 Run 和后继 Run 的执行者。收尾、部署与后继证据统一按创建时间及数据库插入顺序选择最新审查；时间相同时以后插入记录为准，最新记录撤回或不通过都不能回退到更早的通过结论。通用部署没有本机安装清单作为依据，仍要求当前 Run，并核对相同目标、冻结档案、版本、产物与审查绑定，继续标为执行者报告，不等于服务端验证线上运行。未知漂移仍拒绝。旧 Review、部署回执与历史执行包不改写，后继证据不等于旧任务已被用户验收或退回意见已经解决。

计划可记录 execution_route、review_route、automation_policy 与 context_contract。审查池支持多个并行或分阶段 RA；成员可在执行、审查及收尾任一阶段新增、移除或替换。`manage_reviews.set_arrangement` 设置当前 Run 的 reviewer/model/route；`manage_reviews.update_member` 的 `action=remove|replace` 更新成员；`manage_reviews.decide` 由指定 lead 针对当前 Run 记录 `continue`、`rework` 或 `add_review` 及理由。报告彼此独立，意见不一致时 lead 明确裁决并记录分歧，不要求全员通过。调用记录显示实际客户端、会话、模型和失败原因；进程完成不等于交付或审查通过。

新的外部主执行由用户在页面或客户端启动；当前已工作的执行 Agent 可在自身 Run 权限内直接管理审查安排、成员与获准子代理，并处理派审、等待、返修和收尾，不需要用户逐次转交。纯 reviewer/model 调整无需新建仅供关联的 Task，保持同一 Run，包括已交付成果的 reviewer 替换。执行安排通过 `manage_tasks` action `set_arrangement` 提交 `task_id`、`data.arrangement` 和 revision，可选 `agent_id` / `execution_policy`，沿现有同 Task 生命周期应用且不热启动新的外部主执行。范围修订通过 `manage_tasks` 的 `action="amend"` 追加：传 `task_id`、`run_id`、`expected_revision`、`reason` 与 `changes`（可含 `goal`、`scope`、`acceptance`、`tests`、`required_files`）。运行中的范围修订即时应用；若已交付内容受影响，通过 `continue` 在同一 Task 新建 Run 并保留历史。执行者可调用独立审查并由审查者提交报告；作者不得提交 review 结论。同会话续接只能使用真实记录的会话编号；无编号或无法恢复必须如实说明。自动审查按计划处理；自动启动新的主执行/返修和收尾另需用户在页面开启相应许可，新旧任务默认不自动启动外部主执行，不重写冻结执行包或历史报告。context_contract 限定本轮必读与按理由补读的文件/行范围、项目内输出目录和内容大小；资料规则不能扩大 allowed_paths。

Harness 正常会话缓存按客户端机制保存；主动产物、报告、脚本、截图与临时文件只写项目授权范围。客户端拒绝、权限不足或安全限制不得绕过。清理不再手动删除：确认不再使用的本轮临时内容移入项目根“待清理”目录，记录原路径、新路径和原因，由用户删除。移动前核验范围、链接和占用；验证证据、有效成果、正式记录及仍被占用的文件保留原处，移动受阻时说明原因。

## 子代理委派登记与回报

主执行由用户启动；已经由用户启动的执行者可按本 Run 的授权直接安排独立审查和白名单子代理。只用 RUN.md 提供的固定 MCP 或 CLI 入口，不要求执行者查找所有客户端。`agent.ts <Run ID> start` 是当前会话接单回执，不是启动主执行程序；独立审查使用当前 Run 的 `review` 入口，由实际审查者按 RA 回传，执行者不能代写结论。

执行者只能为当前正在运行的 Run 使用 `register_delegation` 登记委派。提交前确认用户允许子代理、模型在本 Run 的子模型名单内，并遵守并发、层数、次数、上下文预算、必读文件、授权路径和输出目录限制。每项委派需有独立请求编号、具体目标和有限材料范围。

当前 Run 的便捷命令为 `scripts/agent.ts <Run ID> register-delegation <JSON文件>` 与 `scripts/agent.ts <Run ID> report-delegation <JSON文件>`，沿用 RUN.md 指定的 Node/tsx 和 WORKBENCH_ROOT。帮助用 `--help`，无需读取执行凭据。JSON 不需填写 `run_id`；CLI 固定使用命令行 Run，不允许输入改换身份。CLI 只负责文件读取、固定 Run 与登记请求编号，模型、范围、预算、状态及额外字段由现有后端 schema 和权限规则校验。

- 登记 JSON 必填 `model`、`goal`、`required_files`、`allowed_paths`、`output_dir`、`context_bytes`；可选 `parent_id`、UUID 格式的 `request_id`。未传请求编号时，CLI 按当前 Run 和内容生成稳定 UUID；相同内容重试仍指向同一委派，JSON 排版和字段顺序不影响编号。创建内容相同的新委派时显式给新 UUID；已指定的编号及内容冲突仍由后端拒绝。
- 回报 JSON 必填 `delegation_id`、`status`（`running`、`completed`、`failed`、`cancelled`）；可选 `session_id`、`actual_model`、`summary`、`artifacts`。此接口没有 `request_id`，重复相同回报沿用后端内容摘要幂等。无法确认的会话和实际模型省略，不借用主会话编号，也不将请求模型当作实际模型。

登记只会创建一条授权与审计记录，不会启动子代理或客户端。客户端内部的原生子代理只能接收指令约束；工作台目前不能强制拦截其模型、权限或执行范围，也不能保证完整观测。不要声称工作台已自动启动或强制控制这些子代理。

实际执行后调用 `report_delegation`，据实报告状态、真实会话编号、实际模型、简要结果和实际产物路径。不要虚构会话、模型、产物或完成状态。记录会标明来源为执行者报告，不能当成独立核验或审查结论；产物仍受本 Run 的允许路径检查。

Token 预算仅为软提醒，不保证对客户端内部消耗硬性封顶。项目用量只归入明确关联的项目/任务/Run；没有可靠关联或来源指标缺失时保留未知与缺失，不按零推算。

## 审查结论后的权限（2026-10-23 返工）

`export_review_order` 使用后台认证的角色，不接受请求体指定角色。审查池成员可在任一阶段调整并保留原报告和决定。变更 reviewer 或模型不会自行改变 Task/Run 结论；需复审时创建新 RA 并绑定当前内容。

审查结论按独立 RA 与实际来源保存；同一报告重试应幂等。内容修改后旧结论保留为历史，lead 决定是否追加审查或进入返工。

Task ID、Run ID 使用带前缀 UUID，不以路径为身份。Task.version 是计划版本，revision 是页面并发版本。每次重试独立 Run；原 Run 与产物长期保留。数据库是正式账本，文件只是输入与导出。

执行包路径：`<项目>/.agent-workbench/tasks/T-.../`。Task 级保留 `task.json` 当前投影与 `EXECUTION.md` 当前入口；每次执行在 `runs/R-.../` 独立保存 `RUN.md`、`task.json`、`CONTEXT.md`、`events/`、`RESULT.md` 和 `artifacts/`。2026-10-21 起新包的上下文固定在本 Run 内；旧包原样保留。

EXECUTION.md 指向最新 RUN.md；历史 RUN.md 不覆盖。复制按钮只生成/复制执行包，不标 running。手动转发可登记 dispatched；自动调用另有调用记录，有效 started 才表示执行者已接单。

导出先提交数据库 Run 与 Task，package_status=pending 时不接收回执/派发。文件全部写完后才标 ready 并返回准确入口；写盘失败可重复导出修复同一个 Run，不制造第二份任务。task.json 投影使用提交后的 current_run_id/revision/status，文件不能反向覆盖账本。

事件 JSON 格式（此段是示例，不会写入生产库）：

```json
{
  "schema_version": 1,
  "event_id": "EV-unique-uuid",
  "task_id": "T-from-order",
  "run_id": "R-from-order",
  "task_version": 1,
  "seq": 1,
  "event_type": "started",
  "occurred_at": "2026-10-18T12:00:00Z",
  "data": {
    "identity": "codex",
    "cwd": "C:\\Projects\\Example",
    "session_id": "actual-session-id-if-known",
    "message": "已完整读取执行单并开始工作"
  }
}
```

identity 必须等于执行单 Agent ID；cwd 必须是该 Run 的真实授权目录。session_id 无法获取时省略，不编造。occurred_at 记录 UTC/带偏移时间，后台另记 received_at。seq 从 1 开始连续递增，排序依据 seq，时间不用于覆盖状态。

事件 JSON 可由页面手动导入，或先进入 `工程/` 目录，再使用 `npm run report -- <事件文件>` 经 HTTP 上报。离线文件方式使用 `npm run report -- <事件文件> --file`：CLI 仅读取对应 Run 的服务端凭据，规范化事件后生成 HMAC-SHA256 信封 `{ "event": <事件>, "signature": "MAC" }`，先写 `.tmp` 再原子更名 `.json`。文件名使用 event_id 的 SHA256，不能借 ID 穿越目录。不要把令牌放进事件或执行单，也不要直接写未签名 JSON 到 events。旧版 Run 没有 receipt_directory 时使用 HTTP 回报或新建 Run。

1.5 秒补扫，最近 250 ms 文件防抖；半写入 JSON 保留错误记录并在下次重试；不删除原文件。重复 event_id 同内容返回原记录，pending 则重新尝试应用；异内容报冲突。跨 Run、旧版本、身份/cwd 不匹配拒绝。乱序事件 pending，前序到达后顺序处理。确定性状态非法事件标 rejected 并消耗该 seq，修正后用下一 seq；瞬时 IO 失败仍 pending、不消耗序号，重放相同回执即可重试。不能覆盖历史。

状态：ready → awaiting_dispatch → dispatched（可选）→ running → waiting_input/blocked → started 恢复 running → submitted → awaiting_closeout（审查通过）→ closing → awaiting_confirmation → accepted；running 可 failed。Review 要求修改则 changes_requested，不能进入验收。accepted 由用户在页面亲自确认（含会话预填的确认卡），并需具备匹配 hash 的独立通过 Review、执行收尾和使用结果确认（兼容旧版逐项协议）。事件不能上报 accepted。Review 按实际回传方式保留来源：独立 reviewer 回传、用户导入与手工登记分别记录；人工证据不伪称为已自动核验的模型执行。

新 Run 必须传当前 expected_revision；原计划 expected_version 与状态 revision 分开。受保护目录 dataDir、.git、.codex 和凭据始终优先于 allowed_paths，登记项目根不授予这些路径的读写权限。受控 CLI/MCP 对本 Run 令牌的内部读取属于回报机制，不授予执行者浏览全部密钥的权限。同 Windows 用户具有系统文件权限，本工作台不是操作系统进程隔离沙箱。

新 Run 的 `retry_context` 在创建时固化上一 Run 标识、入口、结果、审查意见与最后一次已应用的阻碍/失败/待回答说明。对应 `REWORK.json` 与 RUN.md 中的返工依据用于交接，不扩大权限，也不把旧 Review 套用成新一轮通过。写包失败后重试仍使用同一份依据。Task 级入口可更新，历史 Run 文件不重写。

未生成 Run 的任务也可由页面取消，校验当前 revision 并保留审计。blocked 状态不允许另开并行执行；页面引导先取消当前执行再重新派单。工作台取消不会自动通知外部 Agent，用户仍需在原会话告知停止。

submitted 的 data 需额外提供 result（至少 20 字完整 Markdown）及可选 artifacts 数组：`[{"path":"准确授权文件路径","label":"测试报告.md"}]`。结果自动写为 RESULT.md 并归档。文件复制到 data/artifacts/，保留 SHA256、原路径、大小、来源与 Run。单文件上限 20 MiB；API JSON 上限 2 MiB。

RESULT 内容必须覆盖：完成内容、变更文件、测试命令及实际结果、产物、未完成项、风险、建议 Review 重点。云端无法读本地目录时，用户先取得必要上下文；回传 JSON 可含 result 正文，再由页面导入。二进制产物须用户先存入授权目录，不能把 Windows 路径当云端链接。

备份包含 SQLite、已归档产物、执行包和本地工作台凭据。备份含敏感本地凭据，应仅本机妥善保存。外部工具原始会话与源码不在备份内。

恢复只写新目录，并把 runs.directory/order_path 和签名回执目录改为恢复副本的准确路径。Run.cwd 保持原真实项目目录；原项目源码若不存在，应先恢复源码、核对授权范围。不会覆盖原项目执行包。


### 使用结果确认协议（2026-10-18）

`POST /api/tasks/:id/accept` 保持浏览器 cookie/CSRF 权限以及任务 revision、当前 Run、独立通过审查、归档文件完整性与指纹校验。

新版页面发送 `mode: "user_experience"` 和 `user_checks: boolean[]`，对应任务 `user_acceptance`，没有该字段时使用显式的通用使用确认项。不得同时传技术 `checks`。缺项或未全选拒绝保存；取消表单不写入任何确认。

后端在任务 JSON 和 audit 同时保存 `acceptance_record`，包含 mode、实际确认文本 items、checks、run_id、review_id、artifact_hashes、confirmed_at。记录仅代表用户确认使用结果，不新增技术测试通过标识。现有 JSON 存储可兼容此字段，无需改写历史数据或 SQL 迁移。

无 mode 的旧 checks 协议仅用于没有 user_acceptance 的旧任务，新增记录标为 legacy_checklist。升级前已验收且无 acceptance_record 的数据保持原样；页面只显示历史验收说明，不为技术条目打勾。规划者和执行者 MCP 仍无验收权限。


## 用户明确选择不安排审查（2026-10-20）

普通任务保持既有独立审查要求。只有用户需求记录明确的 skip_review=true 和 review_note 时，规划才可提交 reviewer_id=null；服务器把用户选择保存在 task.review_policy。执行者不能通过回执修改该选择。

该类任务在实际 submitted 后，Run 保留 submitted，Task 为 awaiting_closeout。执行者报告 closeout_started 并完成逐项收尾后才为 awaiting_confirmation。本人试用确认后才 accepted；acceptance_record.review_id 为 null，review_policy 保留用户选择，没有虚构审查通过。生成的 RUN.md 会明确不安排审查。旧执行单与历史审查不回填。

用户停止采用已交付成果时，可取消该 Task；已提交 Run、事件与产物保留原样，这不是审查失败或重新验收。


## 用户验收不通过与返工

人工拒绝保存Task.acceptance_feedback：id、run_id、note、artifact_hashes、created_at、verdict=rejected、source=user_entered，可选followup_task_id。没有新数据库表，沿用现有Task JSON与审计事务。旧Run、Review与归档保持。

- acceptance_rejected：等待复制返工。页面生成新的Run，使用上次实际执行者及指定模型；新Run.retry_context.user_feedback和REWORK.json固化用户意见，复制后仍awaiting_dispatch。
- rework_linked：由另一真实任务继续处理，Task.rework_task_id指向它，旧任务验收未通过。禁止导出和取消旧项，历史保留。不得把这种状态算作验收通过。
- 关联后续任务前沿依赖和替代关系防止循环。依赖被替代任务时，沿替代链等待最终任务accepted才放行。

页面reject/rework须会话、CSRF与当前revision；拒绝还校验当前run_id和产物hash列表。manager MCP 仅准备退回或验收确认卡；用户原话不是确认凭据，用户亲自点击后才生效。


## 2026-10-23：独立 Grok 审查自动回传

1. 执行者先通过 submit_run_result 归档交付。取得 get_review_context({run_id}) 的 Task/Run、review_digest、归档文件清单和 final_response。上下文返回的具体归档文件只用于本次审查，不授予读取同目录其他账本/密钥的权限。
2. 由指定的独立 Grok Build 审查当前成果，以 final_response 的结构返回 JSON（verdict 仅 passed/changes_requested，findings 与 limitations 为字符串数组）。已有会话可以补审；产物或执行变了不能套用旧结果。
3. 调用 submit_grok_review({run_id,session_id})。不传 verdict、路径或报告正文。服务端通过 grok trace --local 导出该会话，只读取 summary/chat_history/updates，不联网上传；无正常 end_turn、模型不符、任务/版本不符或结束期间状态变化时拒绝。
4. 后台保存原始结论、会话/请求/模型、版本绑定与调用来源。passed 进入“待执行者收尾”，changes_requested 进入“需要修改”，不生成用户验收。重复回传幂等。get_run_feedback 包含 review_status 可读回。

本机需安装支持 trace 的 Grok CLI 及 tar。默认从 PATH 找 grok，可在本地 config/local.json 的 review.grokExecutable 设置绝对路径，或通过服务环境 WORKBENCH_GROK_EXECUTABLE 指定。没有该 CLI 的云端仍用手工登记；不能把未知来源冒充机器核验。此核验确认本机 Grok 会话来源和版本归属，不是对本机管理员篡改 Grok 存储的密码学防护，也不保证审查没有漏项。

页面可“读取 Grok 审查”作为补充入口；“撤回误登记”保留原结论、原因与审计，仅允许尚未验收的当前 Run。撤回最新记录后重新等待审查，不自动恢复更早的通过结论。已验收历史保持，发现问题另建修复任务。


## 执行收尾回报

收尾继续使用同一 Run 的签名、身份、cwd 和连续 seq；Run 的作者交付保持 submitted，Task 表示当前交接阶段。原 RESULT.md 不被收尾覆盖。

| 回报 | 允许的 Task 阶段 | 结果 |
| --- | --- | --- |
| closeout_started | awaiting_closeout / closeout_blocked / closeout_waiting_input | closing |
| closeout_progress | closing | closing |
| closeout_waiting_input | closing | closeout_waiting_input |
| closeout_blocked | closing | closeout_blocked |
| closeout_completed | closing | awaiting_confirmation |

每条 data 均需当前 `closeout_id`。等待与受阻的 message 至少5字。completed 需 result（至少20字）和 closeout_results，准确覆盖全部 C1、C2…事项，每项为 `{item_id, outcome: "done" 或 "not_applicable", evidence: "实际结果/不适用依据，至少5字"}`。部分完成不能回报 completed；应继续 progress 或 blocked。完成报告写入 Run/closeouts/CO/CLOSEOUT-RESULT.md，验收会再次核验报告和受审文件 hash。

重复事件 ID + 相同内容幂等；内容冲突拒绝；乱序等待；非法转换留档并消费 seq。先查询 get_closeout_context 的 next_seq 再回报。复制收尾单、保存用户回答、读取上下文均不自动开始工作。收尾记录及报告随备份恢复，原始源码仍由项目路径管理。

一般审查可由当前执行者直接发起，或由已启用的 auto_review 调用独立客户端；审查者本人 started 才标记审查中。RA 绑定入口可用 `scripts/review.ts <RA ID> manage <tool> <JSON路径>` 调用本单授权的管理工具；审查结果可用 `verdict`、`findings`、`limitations`、`evidence`、`report_markdown` 简短提交，由服务端合并当前 RA 模板。多名审查者分别回报，lead 明确写下最终决定及异议处理依据。export_review_order 保留 delivery_mode=manual|agent 作为旧协议兼容；仅生成文件入口不等于调用。旧调用失败可使用 report_review_handoff，以 revision 校验并撤销该 RA 权限，交由有权限的执行/审查会话按当前记录续办或由规划者处理；不要求用户重复确认或转发。Reviewer 只能提交审查，执行者只能提交自己的收尾，用户才能验收。

## 会话直接管理（2026-10-23）

本地 Agent 可在会话里直接办理需求、项目、团队、额度、订阅和回答。验收、退回、撤回审查与已有结论后的改派由 Agent 预填确认卡，用户在首页点一次后生效，不用重复填表。主会话 MCP 默认 manager；已有连接重连后生效。未加载 MCP 的客户端可用项目内 workbench 命令入口。详见 [会话管理手册](CONVERSATION_MANAGEMENT.md)。关键决定仅由用户通过页面确认；执行和审查凭据仍负责本单回报。

执行/收尾回执只通过本Run独立runner连接或签名文件回传；manager没有import_execution_receipt，也不能通过旧工具重放历史回执。远程回执由用户在页面导入，记录来源user_imported。Agent不得使用页面会话或鼠标代用户操作导入。

## 用户修改执行安排（2026-10-25）

用户可在页面任务详情的“执行安排”里修改执行者、主模型和子代理（`POST /api/tasks/:id/arrangement`，仅页面会话与 CSRF；Agent 凭据不能调用）。按阶段生效：未生成执行单直接采用；已生成但未接单（`awaiting_dispatch`/`dispatched` 且未 started）时旧 Run 标为 cancelled 并留档，按新安排生成新 Run，旧 Run 的回执被拒绝；执行中、审查中或待收尾时保存为 `task.pending_arrangement`，下一次生成 Run（返修、重试、停止后重新开始）时采用并清除；失败、取消或需要修改时直接生成下一版。

每个 Run 的 `execution_contract` 在创建时冻结，历史包不改写。对当前 Task/Run 的范围修订作为追加变更记录保存，不覆盖旧合同。修订明确具体变更与原因，并只授权本次所需路径；任何实际内容变化均须重新验证受影响交付，并取得覆盖新内容的审查证据。旧 Review 保留为历史，不能把旧 passed 显示为新内容通过。纯 reviewer/model 调整保留当前 Task/Run，不生成假性范围修订。执行者看到执行单写明“用户选择，覆盖规划建议”时，按该模型执行，不得自行改回、升档或降档。

## 审查完成后的登记恢复

工作台自动接收独立客户端成功终态中的完整报告；允许客户端在唯一报告前附带过程文字，仍校验对应任务、执行、审查单、交付摘要和会话。多份候选、损坏正文、失败退出和身份冲突不会自动记为通过。

审查者已经完成但没有登记 started 时，可以通过本 RA 的 submit_review_report 或 scripts/review.ts submit 直接补交完整原报告，不重新启动模型、不再次检查启动额度。CLI 接受原始 Cursor 成功结果 JSON 文件及其中的过程前言；提交来源仍记为本人回传，文件格式不被当成独立身份认证。

已由工作台启动且正常结束、仅登记失败的调用，执行者可调用 recover_native_review({run_id,job_id}) 或 scripts/agent.ts <Run> recover-review <Job>。程序只读取该调用已保存的原生输出，不接受作者提供的结论或任意文件；旧失败保留并追加原报告来源、指纹与恢复关联。对应当前报告登记后，旧失败不再遮挡正常流转。升级工作台自身时，尚在运行的旧后台没有此接口，先确认没有受管调用在运行并正常退出原后台，再从已受审源码运行 scripts/recover-native-review.ts <Run> <Job>，使用现有 WORKBENCH_ROOT 配置，只完成上述同一登记恢复，不启动第二个服务。恢复完成后重新打开工作台；仍在运行时独占账本检查会拒绝，不能绕过。
