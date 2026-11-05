# 外部服务

团队 → 外部服务集中保存 API、CLI、可委派 Agent CLI 和应用 MCP 连接。连接从预设创建，填写实际地址、模型或本机 CLI 路径，再选择允许使用的项目与 Agent。凭据在本机通过 Windows 当前用户 DPAPI 加密；页面仅显示是否配置。保存和本地检测不代表账号额度充足或真实调用已经成功。

外部服务负责提供工具；需要进群自主执行和派活的模型，请在团队 → API 型 Agent 创建成员，见 [项目工作群](WORKGROUPS.md)。两种入口保留各自的授权范围。

## 预设与适配范围

预设包括 MiniMax、火山方舟、即梦、阿里云百炼、智谱、Kimi、DeepSeek、腾讯、百度千帆、硅基流动及其他国内服务。每个预设显示协议、已适配操作、官方资料和待核验项；当前完整清单以团队页面为准。没有实现调用适配的预设只用于保存配置，不能被当作可调用服务。

- MiniMax 模型 API、媒体 API、`mmx`、`mcode`、Design 应用 MCP 与官方多媒体 API MCP 分开配置。Design 必须使用应用正式导出的 MCP 接入资料，不能从应用内部猜测鉴权或接口。
- 火山方舟使用其 API Key；即梦开放平台 AK/SK 签名、即梦网页账号与 Dreamina Canvas CLI 是不同入口。专用 AK/SK 适配未实现时，页面明确显示待核验。
- 媒体模型与对话模型分别填写；套餐凭据、按量 API、地域与业务空间按服务商要求匹配。
- CLI 调用前查看本机版本与帮助。工作台保留 CLI 的权限、登录与积分确认机制，不自动安装、切换账号或购买额度。

## Agent 调用流程

已认证的执行、审查或工作群会话通过以下工具调用：

1. `list_external_services` 查找当前项目和身份允许使用的连接。
2. `get_external_service_usage` 获取连接支持的操作、参数和调用限制。
3. `invoke_external_service` 提交操作和唯一请求 ID。
4. `get_external_invocation` 查询原调用的状态。异步任务只查询原任务；网络结果未知时不能重发创建。
5. `get_external_artifact` 获取已经安全落盘的产物与 SHA-256。

工具身份由工作台认证，不采信提示词中的身份声明。凭据由后台注入，不能写入调用参数、提示词、命令行参数、报告或发布包。媒体生成按连接授权执行；CLI 退出码为零与远端媒体生成完成分别记录。

## Harness 图片工具

现有文本 provider、模型和凭据保持独立。新增 OpenAI Images 连接，配置实际图片模型和可用凭据，并通过 Harness 原生 MCP 客户端加载工作台图片工具。文本模型支持工具调用，不代表图片模型、额度和图片工具已经可用。

工作台启动的会话绑定自身 Run 或工作群调用身份，不借用其他会话的权限。桌面 profile 的接入须保留原配置和备份；只能复用已授权的凭据来源。跨电脑或 Windows 账号迁移后需要重新填写密钥。

OpenAI 图片操作与参数见 [官方 Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)。其他预设的官方来源随连接展示。
