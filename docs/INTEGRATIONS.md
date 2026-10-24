# 外部数据与图解

首次运行两个数据源均未连接。当前接入边界如下：

| 工具 | 已核验契约 | 用途与范围 |
| --- | --- | --- |
| Token Monitor | 0.70.0 Hub HTTP/SSE；0.65.0 用户实测兼容 | 读取额度与用量；采集与账号登录由原软件处理 |
| AgentsView | 0.45.0 HTTP API | 会话列表、搜索与按需详情；不直接操作它的私有数据库 |
| Archify | 3.2.0 本地渲染器 | 按结构生成图解，在项目固定图解入口查看 |

0.70.0 在开发环境验证过真实读取及生命周期。0.65.0 来自用户在 Windows 10 19045 x64 上的实测反馈：`/api/stats`、`/api/stats/stream` 和 `/api/subscriptions` 均可用，额度正常入库。这是用户实测记录，本轮没有在另一台电脑重复验证。0.77.0 已发布，尚未验证桌面端兼容性。

v0.1.1 内置官方 0.70.0 Hub 的最小依赖代码（MIT、固定提交与逐文件校验见 `vendor/token-monitor`），与安装的桌面采集器版本解耦。无需提取桌面安装包，也不要求桌面软件恰好为 0.70.0；新版本仍需验证通信契约。首次运行两个数据源保持未连接。

## 推荐：便携包连接 Token Monitor

适合仅在这台电脑使用额度的用户。无需安装 Node、npm 或构建环境。

1. 先安装并正常使用 Token Monitor，让它能显示自己的额度。退出工作台。
2. 在工作台解压目录双击 **连接Token Monitor.cmd**。
3. 选择已安装的 `Token Monitor.exe`，例如 `I:\Token Monitor\Token Monitor.exe`。支持其他盘符和含空格的路径。
4. 工具显示本机连接地址，并提供“复制地址”“复制连接密钥”。默认使用 17321；若被占用，选择 17322–17340 内的空闲端口，以窗口显示为准。
5. 打开工作台。点击连接窗口里的“打开 Token Monitor”，在它的“设置 → 多设备同步”中选择 **连接已有 Hub**，粘贴地址与共享密钥并保存；如它提示重启，按提示重启。
6. 回到工作台的额度页查看连接和更新时间。密钥粘贴后复制一段普通文字，替换剪贴板中的密钥。

此方式的 Hub **仅监听 127.0.0.1**。工具只写工作台连接设置与本机密钥，不修改 Token Monitor 设置、账号或凭据文件；你在原软件中确认连接。无需同时安装 AgentsView。

已有可用连接会保留，连接工具会给出说明而不会覆盖。只升级工作台的用户无需重新连接。再次运行工具时，已有自管连接的地址与密钥会复用。

工作台启动时只启动本次管理的 Hub，Token Monitor 由你自行打开。关闭窗口后服务继续在托盘运行；从托盘选择“退出工作台”时停止能验证属于本次启动的服务，Token Monitor 桌面应用继续保留。工作台退出期间，Token Monitor 的同步会离线，原软件仍可本地采集。

## 连接已有服务

适合已经运行 Hub 的用户。Token Monitor 的默认 **local 模式不启动 HTTP 服务**，直接填写 `http://127.0.0.1:17321` 会连接失败。

1. 在 Token Monitor 的“设置 → 多设备同步”选择 **在本机托管 Hub**，保存并重启。对应设置为 `%APPDATA%\Token Monitor\settings.json` 中 `hubMode: "host"`。优先通过界面设置。
2. 首次开启 Host 会生成共享密钥。可在它的同步设置里复制；也可从 `%APPDATA%\Token Monitor\credentials.json` 的 **hub.hostSecret** 字段取得。只复制字段值，不要复制整个凭据文件。
3. 在工作台内建立 `data/integrations/private/token-monitor.key`，只保存这段密钥。
4. 若还没有 `config/local.json`，复制 `config/example.json` 为该文件。把 `integrations.tokenMonitor` 改为：

```json
{
  "baseUrl": "http://127.0.0.1:17321",
  "secretFile": "data/integrations/private/token-monitor.key",
  "managed": false
}
```

5. 保留其他配置，重新打开工作台。

**secretFile 的位置要求：**相对路径从工作台根目录解析，解析后的文件必须在工作台 **data 目录内**，包括符号链接/目录链接的真实目标。放在 config 下会被拒绝。如果设置了 `WORKBENCH_DATA_DIR`，须放在该指定数据目录内。也可改用 `secretEnv`（填写环境变量名）；选择一种即可。

**Host 的监听范围：**用户实测 Token Monitor 0.65.0 的嵌入式 Host 监听 `0.0.0.0:17321`，局域网可能访问。共享密钥仍须保密。工作台无法把上游 Host 自动改为仅本机监听；只在本机使用时推荐上面的内置 Hub。确需 Host 时，在 Windows 防火墙高级设置中为 Token Monitor Hub 端口添加阻止入站规则，或按自己的网络范围限制来源。此工具不会更改防火墙。

- Token Monitor：[仓库](https://github.com/Javis603/token-monitor) / [API](https://github.com/Javis603/token-monitor/blob/main/docs/API.md)
- AgentsView：[仓库](https://github.com/kenn-io/agentsview) / [API](https://www.agentsview.io/docs/session-api/)

## 源码安装与可选 AgentsView

源码安装也可用根目录的连接入口，构建桌面版后使用自带运行环境。开发者可运行 `node scripts/configure-live-integrations.mjs --desktop "I:\Token Monitor\Token Monitor.exe"`，取得地址及密钥文件位置，随后在 Token Monitor 中填入连接信息。脚本不会打印密钥。

AgentsView 为独立可选服务。源码环境运行 `npm run integrations:provision -- --agentsview`，再运行 `node scripts/configure-live-integrations.mjs --agentsview`。前者从官方 GitHub 下载固定 0.45.0 Windows x64 包并核对 SHA256；后者准备两个服务的连接配置。便携环境可在 PowerShell 中将命令里的 `node` 替换为 `& '.\桌面版\工作台\resources\runtime\node.exe'`，依次执行 `scripts/provision-integrations.mjs --agentsview` 和 `scripts/configure-live-integrations.mjs --agentsview`。

已有自定义连接需单独核对，脚本会保留它。AgentsView 也可按上游文档自行启动，再配置已有服务地址与密钥。

AgentsView 按其官方标准目录索引本机会话，首次可能需要时间。配置、下载物、进程记录与密钥均保存在 data/integrations。它们不进入发布包。

## 连接排错

- **连接被拒绝/17321 没有监听：**先确认上游不是 local 模式；已有服务方案需要 Host，自管方案需要工作台已启动。
- **401/403：**核对 Host 密钥或本机 Hub 密钥。两种方式的密钥不同。不要将整个 credentials.json 用作密钥文件。
- **密钥路径报错：**把文件放入 data/integrations/private，并检查 secretFile；不要放在 config 目录。
- **服务已连接但没有额度：**在 Token Monitor 检查采集和同步状态；工作台读取的是它上传的额度。
- **安装在其他盘：**连接入口直接选择该目录下的 Token Monitor.exe。
- **端口在配置后被占用：**数据服务日志会报告冲突；退出占用程序或修改为另一个本机端口，并同步修改 Token Monitor 的 Hub 地址。

## 记录与限制

未知余额与零不同；不同币种、积分、tokens 和百分比不相加。成功新快照替换缓存，离线保留最后数据及更新时间。来源声明支持某工具不等于本机已有对应会话。

Archify 随源码分发，版本及原始声明见 vendor/archify。它只渲染结构，不调用收费模型或改变任务状态。Rulesync、Engram、多机协作、所有客户端自动执行尚未实现。

## v0.1.6 读取范围

工作台已停止请求 Token Monitor 的 /api/subscriptions，并移除旧的外部订阅镜像；用量、额度与 SSE 保留。本地“订阅与日程”仍由用户维护。上面的三个接口记录是早期兼容性证据，当前只要求额度与用量接口。
