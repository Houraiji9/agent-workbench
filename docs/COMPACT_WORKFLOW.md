# 简版执行与真实交付

默认调度上下文为 brief，可用 project_id 限定项目。只有确需旧材料时请求 detail=full。完整历史仍在账本和不可变执行包中，不因缩短提示而删除。

执行者使用本 Run 独立 MCP：

- `get_run_context({run_id, mode:"brief"})`：读取本轮范围、权限、当前问题和资料索引。
- `ack_run_context({run_id, context_hash, session_id?})`：确认读到的版本，关联实际原生会话编号。
- 同会话后续使用 `mode:"delta", known_context_hash`；找不到旧版本时返回 reset_required，不能假装继承成功。不同任务不会借用另一任务的权限或正文。
- `report_run_activity({run_id,event_id,event_type,data})`：程序填写 Task、身份、cwd、版本和序号；event_id 保持同一重试编号。作者不能回报 accepted，管理连接不能代交执行结果。
- `wait_run_update({run_id,after_revision,timeout_ms})`：最多等待 30 秒的状态变化，超时如实返回 changed=false。这是当前连接内的短等待，不会唤醒已结束的 Agent 会话。
- `complete_run_closeout({run_id,event_id,result,closeout_results})`：实际做完收尾后提交每项结果，程序合并接单和完成回执；缺项、审查失效或本机安装未验证仍然拦截，不代用户验收。
- 无 MCP 时用安装目录的 Node/tsx 执行 `scripts/agent.ts <Run ID> context [known_hash]|start|report <JSON文件>|wait <revision>|closeout <JSON文件>|deployment <manifest_sha256>`。运行前 WORKBENCH_ROOT 指向所用账本的安装根，不能误连另一份开发账本。

新执行包的 RUN.md 是简版，完整合同存于 FULL-RUN.md；旧报告只在 REWORK.json 保存一次。历史执行包不重写。界面的“同会话继续”准备本轮简讯，必要时新建返修 Run；未接通客户端投递时明确保持未发送，不能把复制当作接单。

一个原生会话可以通过真实回执或显式关联连接多个 Task/Run。各绑定分别保存项目、任务和执行编号；AgentsView 提供会话来源，不根据聊天顺序猜测任务因果。

项目资料可登记源码目录、运行目录和交付目标。新 Run 使用源码 cwd，执行包与账本仍走既有登记位置；旧 Run.cwd 不变。当前本机安装校验支持工作台便携格式：交付并审查完整 manifest 后，执行者调用 report_runtime_deployment，后台核对运行目录所有程序文件。没有安装证明不能完成本机目标的收尾或用户验收；其他软件需相应的可验证交付适配器，不伪装已经支持。

“轮到你了”按待回答、待试用、异常需决定、待安排分组，后者默认展开，保留手动收起，避免隐藏需要用户转发的事项。内部完整接力流程仍在详情中。项目说明默认三行，展开/编辑保留全文。关系图直接读取真实依赖、返工和会话绑定；静态快照另存，不替代实时状态。

上下文统计是接口提供的字符数和次数，**不是模型计费 token**。客户端自动执行能力未接通时如实标记；来源连通、额度可用、模型实际可调用是不同事实。已知低额度规则保留，未知/过期/未关联分别说明，不推算满额。
