import {userAcceptanceItems} from './acceptance.ts';
import path from 'node:path';import type {Row} from './schema.ts';import {compactRetry} from './execution-context.ts';
import {runTask} from './workflow-policy.ts';
import {priorityInstructions} from './priority-policy.ts';
import {resolveDeliveryProfile} from './delivery-profile.ts';
export function compactOrder(t:Row,p:Row,r:Row,ledgerRoot:string,execution:Row={}){
 t=runTask(t,r);
 const profile=resolveDeliveryProfile(t),deployment=profile.deployment;
 const deploymentInstructions=deployment.verification==='executor_reported'
  ?'提交 submitted 时必须填写 delivery_version，绑定本次受审成果版本。独立审查通过后，先 get_deployment_context 获取当前版本、产物、目标和回执要求，再按冻结档案部署、执行健康检查并准备回滚证据，通过 report_deployment_evidence 如实回报。回执仅是执行者报告，不代表服务端已验证部署。'
  :deployment.verification==='portable_manifest'
  ?'独立审查通过后按本机便携安装流程部署，并用 report_runtime_deployment 提交安装清单验证；收尾和用户验收核对当前受审版本。'
  :'本轮交付无部署步骤，完成受审成果、收尾及用户确认。';
 return `# ${t.title}

Task ${t.id} / Run ${r.id} / 版本 ${t.version}
执行者：${r.agent_id}；Reviewer：${t.reviewer_id||'未安排（用户选择）；本次不安排独立审查'}
指定模型 / 模式: ${r.requested_model||'由执行者选择'}
项目执行顺序：第 ${execution.step||1} 步
${execution.dependencies||'无前置任务'}
源码工作目录：${r.cwd}
账本入口：${ledgerRoot}
成果类别：${profile.artifacts.join('；')}
交付目标：${deployment.mode==='none'?'源码/成果，无部署':deployment.mode+' / '+deployment.target}

## 本轮模型与委派设置
${priorityInstructions(t,t.importance||'normal')}
${JSON.stringify(r.execution_contract||null)}
子代理仅可在白名单、并发/次数、读写和上下文预算内安排；主执行者负责整合。先 register_delegation 登记范围，再由当前客户端调用；report_delegation 回报真实会话与结果。客户端内部调用当前仅能下发要求和登记回报，不承诺强制拦截或完整观测。
审查安排：${JSON.stringify(t.review_policy)}

## 本轮成果与部署档案
${JSON.stringify(profile)}
${deploymentInstructions}

## 本轮目标与范围
${t.goal}
${t.scope}

## 权限与停止条件
允许路径：${t.allowed_paths.join('；')}
${t.forbidden_actions.map((x:string)=>'- '+x).join('\n')}
新增费用：${t.additional_cost_limit} ${t.currency||''}
${t.stop_conditions.map((x:string)=>'- '+x).join('\n')}

## 技术检查（执行者与独立 Reviewer 负责）
${t.acceptance.map((x:string)=>'- '+x).join('\n')}
用户试用确认：
${userAcceptanceItems(t).map((x:string)=>'- '+x).join('\n')}

## 验证与交付
${t.deliverables.map((x:string)=>'- '+x).join('\n')}
${t.tests.map((x:string)=>'- 检查：'+x).join('\n')}

## 继续执行
先调用 get_run_context({run_id:"${r.id}",mode:"brief"})；已持有 context_hash 的同会话使用 mode:"delta",known_context_hash。缺失上下文再请求 full，不重复全文展开旧报告。
回报使用本 Run scoped MCP 的 report_run_activity，由程序填写身份、cwd、版本与序号；保留 event_id 以便幂等重试。也可使用 scripts/agent.ts ${r.id} context|start|report，连接 ${ledgerRoot} 的账本。
交付后按本任务计划调用 dispatch_review 或 scripts/agent.ts <Run> review；已启用 auto_review 时工作台自动接手，同一请求不要重复派发。需要修改时，本人无外部调用路线可用 continue_run 建立手工新 Run；外部主执行由用户启动，只有用户另行开启且计划允许才自动续作。旧交付保留，复审按真实会话编号续接。调用与模型路径由工作台负责，执行者无需重新读取调度手册。子代理可用 scripts/agent.ts <Run> register-delegation <JSON文件> 先登记，完成后 report-delegation <JSON文件> 回报。缺失客户端或调用失败必须保留实际原因。

## 资料索引
${t.required_files.join('\n')}
读取合同（必读、条件补读、输出目录、预算）：${JSON.stringify(t.context_contract||null)}
完整原需求、验收项与完整执行协议：${path.join(r.directory,'FULL-RUN.md')}
项目上下文：${path.join(r.directory,'CONTEXT.md')}
历史记录不能扩大权限。
`+compactRetry(r);
}
