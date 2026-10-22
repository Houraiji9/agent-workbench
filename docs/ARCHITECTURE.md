# 架构与数据边界

Electron 打开本机页面并管理生命周期；React/Vite 展示界面；Fastify 的业务层统一管理 SQLite。MCP stdio 和页面调用同一个后台，执行文件包是输入/输出，不是第二套账本。

| 目录 | 作用 |
| --- | --- |
| desktop | 窗口、托盘、外链与进程生命周期 |
| src/web | 页面、组件、状态同步 |
| src/server | HTTP、页面会话、CSRF、受限 MCP 路由 |
| src/core | 路径、权限、任务、状态、团队、额度与持久化 |
| src/integrations | Token Monitor、AgentsView、Archify |
| src/mcp | 规划者与执行者 stdio 接口 |
| migrations | 数据库版本迁移 |
| tests | 独立临时目录下的业务及页面检查 |

Task 保存计划，Run 保存某次执行；接单、进展、结果是有序幂等事件。产物复制到归档并记录 SHA256。Review 绑定 Run 和产物指纹；用户验收通过或退回另存记录。新 Run 不覆盖旧执行。

服务只绑定回环地址，校验 Host、Origin、页面会话及写入 CSRF。规划者凭据不能代验收，执行者凭据限当前 Run。路径基于 realpath 与授权根验证，拒绝目录链接越界和凭据文件。HTML 图解在隔离环境预览，Markdown 按文本渲染。

公开版初始化仅有三个角色模板，不初始化账号或付费计划。tests/fixtures.ts 是明确的测试数据，仅测试入口使用。程序运行后生成的数据、凭据、项目路径、截图和日志均留在本机。
