# 首次连接 Codex 工作台 MCP

设置页生成本机首次配置提示词。复制本身不会安装、探测客户端或调用模型。将提示词交给目标 Codex 后，使用其中当前电脑的内置 Node、工作台 ROOT 与 tsx loader 的 file URL 运行 `scripts/setup-codex-mcp.ts`。

脚本必须明确指定 `--status`（只读预览）或 `--install`（安装/修复）。可选参数为 `--root`、`--node`、`--config` 与 `--codex-home`。默认 root 为脚本所在工程，node 为当前解释器；配置按显式 `--config`、显式 `--codex-home` 下的 config.toml、当前进程 CODEX_HOME 下的 config.toml、用户目录 .codex/config.toml 顺序定位。若目标 Codex 使用不同 profile 或自定义配置，传入该客户端实际读取的 config.toml 路径；脚本不会猜测或遍历其他 profile。

`previewCodexMcpSetup({root,nodePath,configPath?,codexHome?})` 返回明确的 PowerShell `installCommand`。它验证 Node、MCP 入口、引导脚本和 loader 存在，仅返回目标工作台连接，不返回其他配置值。先检查目标路径和预览，再执行该命令。不要把业务内容或凭据放入命令。

安装只持久登记 `mcp_servers.agent_workbench` STDIO 连接：command 为本机内置 Node；args 为 `--import`、tsx loader file URL、ROOT/src/mcp/index.ts；cwd 与 WORKBENCH_ROOT 为实际工作台目录；WORKBENCH_ROLE 为 manager，以支持团队管理写入。连接不包含明文 token；MCP 入口按工作台自身机制读取本机连接凭据。

安装保留其他 MCP、provider、全局 model 及设置的原文字节；修改已有文件前在同目录保存唯一命名的 `config.toml.agent-workbench-backup-*`。同名连接指向其他路径时只替换本连接及其子表；重复执行不写入、不生成新备份。遇到无法安全局部修改的内联 MCP 定义、数组连接、未闭合字符串或符号链接配置会停止并保留原文件，需先确认真实目标或转换为独立 TOML 表。安装器不承担完整 TOML 语法校验，应由目标 Codex 检查其配置。它不改动其他客户端，也不执行客户端发现或模型调用。

备份含原配置中的现有敏感信息，留在本机，不上传或粘贴到聊天。回滚时先确认其他设置此后是否发生修改；可从 backupPath 对应文件恢复原工作台段。只有确实需要回退整个原文件且没有后续修改时，才用完整备份恢复该 config.toml。

安装结果的 `state: current` 仅表示文件已登记；`verificationStatus: not_verified`、`requiresReconnect: true` 始终提醒尚未验证客户端加载。重新连接 MCP 或由用户开启目标 Codex 新会话，确认工具列表实际包含 `get_chat_planning_context` 与 `submit_task_plan`，并成功完成一次不写业务数据的 MCP 读调用，才算接通。旧会话不能热加载时保留“等待重连/新会话验证”，不把 CLI 可运行当作最终接通证据。

## 新会话中的核对顺序与证据边界

工作台 ROOT 决定连接哪套程序和账本，Codex 的 config.toml 路径决定目标客户端从哪里加载连接。二者可以位于不同磁盘；工作区目录不等于 Codex 配置目录。安装时确认目标 Codex 的实际 CODEX_HOME/profile；必要时显式传 `--config`。脚本仅维护 `agent_workbench`，不更改全局 model、provider、其他 MCP 或其他 profile。`--help` 单独使用，只显示帮助，不访问配置或触发安装。

安装后按以下步骤办理：

1. 在目标客户端重连 MCP，或由用户打开使用同一配置的新会话。检查实际工具列表包含 `get_chat_planning_context`、`submit_task_plan` 和首次配置工具。
2. 调用 `get_onboarding_context` 读取当前接入、团队与诊断状态。该工具只读，不进行客户端探测或模型生成。
3. 从目标新 MCP 会话调用 `verify_workbench_connection`，保存握手和实际工具调用证据。该工具会登记连接回执；它与只读上下文不同，不是业务计划提交。
4. 调用 `refresh_onboarding_models`，可按 `agent_id` 限定明确的非 Claude 客户端。它核对客户端与原生模型资料，不执行模型生成；不可枚举时保留未知。不要为列模型运行生成请求。
5. 客户端无法自动枚举但已有明确来源时，使用 `record_onboarding_models` 登记 `agent_id`、`machine_id`、`client_id`、版本、`observed_at`、`source` 与原生模型 ID/provider。不能由展示名称猜 ID，也不能自行填写已完成实际调用的 `invocation_verified`。
6. 在用户授权的调用范围内，明确选择一个非 Claude 原生型号，再使用 `run_onboarding_diagnostic`：填写新的 UUID `request_id`、`agent_id`、精确 `model`，Harness 同时明确 provider。每个选定路由仅一次短诊断；不自动重试、不切换供应商或 default/auto，不因失败购买。已有 request_id 用于读取同次结果。实际生成成功、失败、未知与模型枚举分别记录，不能当作正式 Review 通过或用户验收。

MCP initialize 中的客户端名称、版本与连接实例是客户端自报的协议元数据；连通回执证明这条连接完成了握手与工具调用，不等同于密码学身份认证，也不单独证明操作者身份。不能只凭名称字符串认定一定来自某个桌面窗口。

CLI 全新会话成功加载和调用 MCP，与 Codex 桌面新会话成功加载是两项不同证据。分别记录客户端、时间、实际工具调用及未完成项；CLI fresh session 的成功不能表述成桌面新会话已经验证。终端转接脚本、配置文件存在或后台启动成功，也不能替代任一客户端新会话的工具验证。

## 仅为指定普通工具配置 Codex 审批模式

某些目标 Codex 会话全局设置为 `approval_policy = "never"`，而 MCP 工具默认需要提示审批。这样即使工具已加载，调用仍可能返回 `MCP tool call requires approval, but approval policy is never`。安装脚本仅在 `agent_workbench` 连接内，为以下具体工具补充独立表 `tools.<name>.approval_mode = "approve"`：

- `get_onboarding_context`
- `verify_workbench_connection`
- `refresh_onboarding_models`
- `record_onboarding_models`
- `run_onboarding_diagnostic`
- `get_management_context`
- `manage_agents`
- `get_agent_clients`
- `get_chat_planning_context`
- `get_dispatch_context`
- `get_project_context`
- `submit_task_plan`

这是显式工具清单，不修改全局 `approval_policy`，不为整个服务器设置 blanket approval，也不更改其他 MCP。名单不包含用户验收、发布、部署、审查分派或其他删除工具。`manage_agents` 是当前团队维护统一入口，工具自身仍要求真实 `user_instruction`、作用域和版本校验；其中的归档动作不因配置而获得额外用户授权。诊断工具仍只能在已授权的路由、型号和次数内调用。

已有 `agent_workbench.tools.*` 的显式审批值（包括 deny/prompt）完整保留；服务器默认审批值也保留。已有 `disabled_tools` 或 `enabled_tools` 明确排除某项时，不为该项补 approve，也不重新启用它。返回的 `approvalConflicts` 仅指出哪些工具已有规则或被服务器列表排除；此时不能声称该工具已可调用。内联 tools 对象或无法安全识别的点号键规则会保守停止，原文件不变。原配置修改前保存备份，重复安装保持幂等。

配置更新后仍需目标新会话实际调用核验；工具注册、配置存在、审批模式登记和成功调用是不同证据。
