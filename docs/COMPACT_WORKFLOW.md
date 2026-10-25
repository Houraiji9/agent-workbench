# 简版执行与真实交付

默认调度上下文为 brief，可用 project_id 限定项目。只有确需旧材料时请求 detail=full。完整历史仍在账本和不可变执行包中，不因缩短提示而删除。

多客户端发现、模型/供应商选择、自动派审与返工规则只进入规划者上下文，见 [规划手册](CODEX_PLANNER.md)。执行者和审查者分别只读本 Run / RA 的简版入口、当前范围、资料清单与固定回报方法，不承担客户端查找与调度配置。

执行者使用本 Run 独立 MCP：

- `get_run_context({run_id, mode:"brief"})`：读取本轮范围、权限、当前问题和资料索引。
- `ack_run_context({run_id, context_hash, session_id?})`：确认读到的版本，关联实际原生会话编号。
- `read_run_context_file({run_id,path,range?,reason?})`：按 context_contract 读取指定必读文件或行范围；补充材料须提供具体理由。文件指纹仅表示服务器核对过版本，内容提供和确认回执也不证明模型已理解。
- 同会话后续使用 `mode:"delta", known_context_hash`；找不到旧版本时返回 reset_required，不能假装继承成功。不同任务不会借用另一任务的权限或正文。
- `report_run_activity({run_id,event_id,event_type,data})`：程序填写 Task、身份、cwd、版本和序号；event_id 保持同一重试编号。作者不能回报 accepted，管理连接不能代交执行结果。
- `wait_run_update({run_id,after_revision,timeout_ms})`：最多等待 30 秒的状态变化，超时如实返回 changed=false。这是当前连接内的短等待，不会唤醒已结束的 Agent 会话。
- `complete_run_closeout({run_id,event_id,result,closeout_results})`：实际做完收尾后提交每项结果，程序合并接单和完成回执；缺项、审查失效或本机安装未验证仍然拦截，不代用户验收。
- 无 MCP 时用本 Run 固定入口中的 Node/tsx 执行 `scripts/agent.ts <Run ID> context [known_hash]|read <请求JSON文件>|start|report <JSON文件>|register-delegation <JSON文件>|report-delegation <JSON文件>|review|wait <revision>|closeout <JSON文件>|deployment <manifest_sha256>`；`--help` 列出完整动作。运行前 WORKBENCH_ROOT 指向所用账本的安装根，不能误连另一份开发账本。

主执行由用户启动；`start` 仅表示当前执行者读取上下文并接单，不会启动另一个主执行客户端。执行者可按当前 Run 的授权直接调用独立审查和子代理：派审用固定的 `review` 入口，子代理先用 `register-delegation` 登记获准，再由当前客户端调用，随后用 `report-delegation` 如实回报。登记不是启动，也不是独立审查；不要求执行者遍历所有 MCP/CLI 或重新寻找客户端。

两种委派 JSON 都省略 `run_id`，命令行的当前 Run 固定身份；跨 Run 输入会被拒绝，字段与权限仍由后端校验。登记未传 `request_id` 时按 Run 与内容生成稳定 UUID，重试相同内容沿用编号；要新建一项相同内容的委派须显式给新 UUID。回报沿用后端内容摘要幂等，不增加 `request_id`。真实会话编号或实际模型未知时省略相应字段，不从请求型号或当前主会话推造。字段见 [执行协议的委派入口](EXECUTION_PROTOCOL.md#子代理委派登记与回报)。

审查者使用当前 RA 的 `get_review_assignment`、`ack_review_context`、`read_review_context_file`、`report_review_started`、`submit_review_result`，固定命令以 REVIEW.md 为准。只读当前合同、交付与变更证据，不接收作者完整会话作为独立审查依据。

新执行包的 RUN.md 是简版，完整合同存于 FULL-RUN.md；旧报告只在 REWORK.json 保存一次。历史执行包不重写。计划的 context_contract 明确必读文件/行范围、补充材料及理由、项目内输出目录与内容大小上限。读取内容受授权路径限制，资料不足应说明缺口，不能扫描无关目录补齐。

已配置 execution_route 的任务，“同会话继续”通过工作台调用已登记客户端，优先恢复实际会话，必要时建立新的正式返修 Run。缺少会话编号、客户端不支持恢复或调用失败时保留原因，不伪称续接成功。旧任务未配置路线时仍准备可复制简讯，不把复制当作发送或接单。

一个原生会话可以通过真实回执或显式关联连接多个 Task/Run。各绑定分别保存项目、任务和执行编号；AgentsView 提供会话来源，不根据聊天顺序猜测任务因果。

项目资料可登记源码目录、运行目录和交付目标。新 Run 使用源码 cwd，执行包与账本仍走既有登记位置；旧 Run.cwd 不变。当前本机安装校验支持工作台便携格式：交付并审查完整 manifest 后，执行者调用 report_runtime_deployment，后台核对运行目录所有程序文件。没有安装证明不能完成本机目标的收尾或用户验收；其他软件需相应的可验证交付适配器，不伪装已经支持。

“轮到你了”按待回答、待试用、异常需决定、待安排分组，后者默认展开并保留手动收起。已登记自动调用的正常派审、返工与接单等待不作为用户转发事项；客户端缺失、登录/权限或用户决定才需要人工处理。内部完整接力流程仍在详情中。项目说明默认三行，展开/编辑保留全文。关系图直接读取真实依赖、返工和会话绑定；静态快照另存，不替代实时状态。

上下文统计是接口提供的字符数和次数，**不是模型计费 token**。设置页显示本机客户端发现结果与失败原因，可刷新检测；路径仅为本机配置，不进入发布包。客户端存在、来源连通、额度可用、模型实际可调用是不同事实。已知低额度规则保留，未知/过期/未关联分别说明，不推算满额。调用 completed 只表示进程结束，正式交付、审查和验收各有记录。

Harness 正常会话缓存按客户端机制保存；主动产生的临时文件、报告、脚本和截图写入项目授权范围。安全拒绝不能绕过。清理不再手动删除：确认不再使用的本轮临时内容移入项目根“待清理”目录，记录原路径、新路径和原因，由用户删除。移动前核验范围、链接和占用；验证证据、有效成果、正式记录和仍被占用的文件保留原处，移动受阻时说明原因。
