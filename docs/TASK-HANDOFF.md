# 方案、资料和成果如何交接

工作台是桥梁和记录者。用户提出需求，规划 Agent 给方案，执行者完成并交回成果，审查者检查指定内容，执行者收尾。规划、阅读清单、模型和流程顺序都是协作建议，不是工作许可。执行、审查、部署、收尾和用户验收分别保留真实记录。

## 小改动从哪里开始

例如给工作台加一个按钮：大脑先看当前项目摘要，再定位按钮所在页面与直接调用的接口；执行者从方案指定的组件和相关测试开始；审查者先看本轮差异、相关源码和验证证据。发现接口、共享组件或数据约定受影响时，再补读对应资料。没有必要先遍历工程、读完旧会话或跑全部测试。

方案写在任务 `scope` 中即可。已有独立方案文档时，可以用 `context_contract.plan.path` 记录位置，或用 `plan.content` 保存正文。工作台保留原文，不用程序规则编造方案。

`context_contract` 按需提供，不要求每个小任务填满：

```json
{
  "plan": {"content": "本轮只调整搜索按钮与直接调用的接口。"},
  "required": [
    {"path": "src/Search.tsx", "roles": ["executor"], "reason": "实施入口"},
    {"path": "output/change.patch", "roles": ["reviewer"], "reason": "先看本轮差异"}
  ],
  "supplemental": [
    {"path": "src/search-api.ts", "reason": "请求参数变化或相关检查失败时补读"}
  ],
  "output_dir": "output/search-button",
  "review_focus": ["按钮交互、请求参数和直接调用方是否仍然正确"]
}
```

- 文件可指定 `range: {start_line, end_line}`，避免为了一个函数读完整大文件。
- `roles` 可选 planner / executor / reviewer；不填表示各角色均可参考。它只控制推荐资料，不限制实际读取。
- `required` 表示建议首读，`supplemental.reason` 表示何时补读。失效建议不会连带阻止另一份合法项目文件的读取。
- `review_focus` 是本轮检查重点，与任务完成条件一起使用，不把未检查的关联风险记为通过。
- `max_bytes` 是阅读预算建议。需要更多资料时可继续，说明关联即可。

## 按需取用

| 需要什么 | 入口 |
| --- | --- |
| 项目当前情况 | `get_project_context(project_id, detail="brief")` |
| 相关历史定位 | `search_execution_history(project_id, query, limit=5)`；更多用 `offset`，全文用返回的具体引用 |
| 当前方案或单项资料 | `get_run_context(run_id, section="plan"/"files"/"requirements"/"history")` |
| 审查单项资料 | `get_review_assignment(review_id, section=...)` |
| 已知文件片段 | `read_run_context_file` / `read_review_context_file`，传路径与行范围 |
| 项目经验 | `get_project_memories` 先取索引，再按相关 ID 取正文 |

执行与审查 CLI 的 `context-section plan`、`context-section files`、`context-section requirements`、`context-section history` 对应以上单项接口。完整兼容资料仍可用 `mode="full"` 读取，不作为默认接单步骤。

同会话继续传 `known_context_hash` 取 delta，只发送变化字段、变化文件和新的审查问题。新会话或缓存失效时给当前简版，不假称已继承旧会话。文件指纹仅记录版本，不证明模型读过或理解了内容。

## 记录变更和结果

用户口述调整由当前会话直接办理。`manage_tasks` 的 `amend` 可修改本轮方案与 `context_contract`，保留原值和修改原因，不为纯管理变更创建空任务。修改过的内容需要如实记录本轮验证，不能沿用旧报告冒称通过。

执行者将成果放到指定位置并提交实际路径；工作台收录交付和版本。审查者从本轮变化与指定证据开始，发现影响再扩展检查，不默认全量回归；作者日志不等于审查者自己跑过测试。审查报告可直接用文字 JSON 返回，由工作台接收保存。执行者随后记录安装、文档、交接等实际收尾结果，用户亲自确认试用。

新外部主执行由用户启动；大脑本人执行且用户要求直接做时可自接单。当前执行者可直接调用独立审查和已授权子代理，不需要用户再次转发。工作台不替客户端批准权限，也不伪造来源、模型型号、测试或验收。
