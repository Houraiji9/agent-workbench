# v0.1.1 · 便携安装与额度连接修复

- 新增可双击的“连接Token Monitor.cmd”，使用便携包内置运行环境，支持自行选择 Token Monitor 安装位置。
- 随包提供官方固定版本 Hub，取消从特定版本桌面安装包提取代码的要求；仅监听本机，密钥保存在私人数据目录。
- 原已连接的配置保留；Token Monitor 内的连接模式、地址与密钥由用户在原软件界面确认。
- 补充默认 local 模式无 HTTP 服务、Host 开启方式、共享密钥来源、secretFile 目录限制及局域网监听说明。
- 补齐 Bolt、智谱清言、Grok Bot、通义灵码、Zcode 品牌图标及来源声明。
- 增加 Token Monitor 0.65.0 用户实测兼容记录；0.77.0 尚未验证。

验证：151 项功能测试、97 项页面测试通过；Windows 便携 EXE 和自管 Hub 的启动、鉴权、回环监听、托盘运行、关闭清理通过；连接窗口在 PowerShell 5.1 下渲染检查通过。模拟协议数据与用户真实接入反馈分别记录。

升级请先备份并关闭工作台，再将新包的程序文件覆盖到原目录，保留 `data/`、`config/local.json`、`.agent-workbench/`。原有额度连接无需重新设置。完整步骤见 [使用与维护](USAGE.md)。

当前提供 Windows x64 便携包与源码包；EXE 未签名，无自动更新。GitHub Release 同时提供 SHA256 校验文件。
