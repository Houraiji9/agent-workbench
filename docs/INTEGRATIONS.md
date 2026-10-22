# 外部数据与图解

首次运行两个数据源均未连接。当前接入边界如下：

| 工具 | 已核验契约 | 用途与范围 |
| --- | --- | --- |
| Token Monitor | 0.70.0 Hub HTTP/SSE | 读取额度与用量；工作台不接管采集器或账号登录 |
| AgentsView | 0.45.0 HTTP API | 会话列表、搜索与按需详情；不直接操作它的私有数据库 |
| Archify | 3.2.0 本地渲染器 | 按结构生成图解，在项目固定图解入口查看 |

上述版本在开发环境验证过真实读取及生命周期；新安装包不携带任何用户的外部数据或二进制数据服务。独立发布版测试覆盖接口映射、超时、离线保留与鉴权；新电脑需要自己的连接设置。其他版本需重新核对接口。

## 连接已有服务

复制 config/example.json 为 config/local.json，在 integrations 中填写本机服务地址。secretEnv 使用环境变量名；secretFile 使用项目内私密文件的相对路径，两者均只在服务端读取。请参考上游启用鉴权并仅监听 127.0.0.1。不要将密钥写入公开配置。

- Token Monitor：[仓库](https://github.com/Javis603/token-monitor) / [API](https://github.com/Javis603/token-monitor/blob/main/docs/API.md)
- AgentsView：[仓库](https://github.com/kenn-io/agentsview) / [API](https://www.agentsview.io/docs/session-api/)

## 可选：由工作台管理本机数据服务

适用于已安装 **Token Monitor 0.70.0** 的 Windows x64 电脑。其他版本请使用已有服务方式，不要跳过版本校验。

1. 在源码环境执行 `npm run integrations:provision`。脚本只提取已安装 Token Monitor 的 Hub/共享代码，并从官方 GitHub 下载固定版本 AgentsView，核对 SHA256。此步不启动服务、不读取账号凭据。
2. 执行 `node scripts/configure-live-integrations.mjs`，生成本项目私密连接文件及配置备份。
3. 若要让现有 Token Monitor 桌面向本地 Hub 上传数据，先关闭 Token Monitor，再显式执行 `node scripts/configure-live-integrations.mjs --connect-desktop`。该选项会备份并修改 Token Monitor 的连接设置；账号登录仍由原软件处理。重新打开 Token Monitor 后在其界面完成连接鉴权。
4. 重开工作台。桌面会启动本次配置的本机服务，退出时只关闭能验证由它拥有的进程。

AgentsView 按其官方标准目录索引本机会话；首次可能需要时间。配置、下载物、进程记录与密钥均保存在忽略的 data/integrations。不要把该目录发到 GitHub。

## 记录与限制

未知余额与零不同；不同币种、积分、tokens 和百分比不相加。成功新快照替换缓存，离线保留最后数据及更新时间。来源声明支持某工具不等于本机已有对应会话。

Archify 随源码分发，版本及原始声明见 vendor/archify。它只渲染结构，不调用收费模型或改变任务状态。Rulesync、Engram、多机协作、所有客户端自动执行尚未实现。
