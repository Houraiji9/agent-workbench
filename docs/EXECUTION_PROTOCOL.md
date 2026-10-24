# 执行包与回执协议 v1

## 审查结论后的权限（2026-10-23 返工）

`export_review_order` 使用后台认证的角色，不接受请求体指定角色。runner/planner 仅在当前 Run 为 submitted、review_stage 与当前审查单均非 completed、且没有未撤回的审查时可安排或改派。已有 changes_requested、passed 或进入收尾/待验收阶段后返回 403，并保留原审查、任务和收尾记录。用户页面通过会话和 CSRF 仍可明确重新安排，撤回原因与原报告保留。

`submit_grok_review` 同样限制 Agent 导入新的结论；同一当前 Grok 会话/请求、相同绑定与内容可幂等重试。新会话或新请求在异步核验后的事务内检查权限。需要修改时使用新 Run 返工；用户选择不审查的任务交付后直接进入执行者收尾，页面提示“交付后继续完成剩余事项”。

Task ID、Run ID 使用带前缀 UUID，不以路径为身份。Task.version 是计划版本，revision 是页面并发版本。每次重试独立 Run；原 Run 与产物长期保留。数据库是正式账本，文件只是输入与导出。

执行包路径：`<项目>/.agent-workbench/tasks/T-.../`。Task 级保留 `task.json` 当前投影与 `EXECUTION.md` 当前入口；每次执行在 `runs/R-.../` 独立保存 `RUN.md`、`task.json`、`CONTEXT.md`、`events/`、`RESULT.md` 和 `artifacts/`。2026-10-21 起新包的上下文固定在本 Run 内；旧包原样保留。

EXECUTION.md 指向最新 RUN.md；历史 RUN.md 不覆盖。复制按钮只生成/复制执行包，不标 running。用户点击已交给 Agent 才 dispatched；有效 started 才 running。

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

状态：ready → awaiting_dispatch → dispatched（可选）→ running → waiting_input/blocked → started 恢复 running → submitted → awaiting_closeout（审查通过）→ closing → awaiting_confirmation → accepted；running 可 failed。Review 要求修改则 changes_requested，不能进入验收。accepted 由用户在页面亲自确认（含会话预填的确认卡），并需具备匹配 hash 的独立通过 Review、执行收尾和使用结果确认（兼容旧版逐项协议）。事件不能上报 accepted。Review 证据默认为 user_attested，不伪称系统自动核验了模型执行；当前实现由用户登记真实审查引用。

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

一般审查可通过 `export_review_order` 指定 `delivery_mode=manual|agent`。后者表示执行者负责调用已可用的独立模型；审查者本人 started 才标记审查中。失败使用 `report_review_handoff`，以 revision 校验并撤销该 RA 权限，回到人工安排。Reviewer 只能提交审查，执行者只能提交自己的收尾，用户才能验收。

## 会话直接管理（2026-10-23）

本地 Agent 可在会话里直接办理需求、项目、团队、额度、订阅和回答。验收、退回、撤回审查与已有结论后的改派由 Agent 预填确认卡，用户在首页点一次后生效，不用重复填表。主会话 MCP 默认 manager；已有连接重连后生效。未加载 MCP 的客户端可用项目内 workbench 命令入口。详见 [会话管理手册](CONVERSATION_MANAGEMENT.md)。关键决定仅由用户通过页面确认；执行和审查凭据仍负责本单回报。

执行/收尾回执只通过本Run独立runner连接或签名文件回传；manager没有import_execution_receipt，也不能通过旧工具重放历史回执。远程回执由用户在页面导入，记录来源user_imported。Agent不得使用页面会话或鼠标代用户操作导入。
