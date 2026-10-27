import {userAcceptanceItems} from './acceptance.ts';
import path from 'node:path';import type {Row} from './schema.ts';import {compactRetry} from './execution-context.ts';
import {runTask} from './workflow-policy.ts';
import {priorityInstructions} from './priority-policy.ts';
import {resolveDeliveryProfile} from './delivery-profile.ts';
import {taskHandoff} from '../shared/task-handoff.ts';
export function handoffText(t:Row,role:'executor'|'reviewer'='executor'){
 const h=taskHandoff(t,role),files=h.files.slice(0,8);
 return `方案：${h.plan.path||'见本轮工作'}${h.plan.range?'（第 '+h.plan.range.start_line+'–'+h.plan.range.end_line+' 行）':''}\n${h.plan.content&&h.plan.content!==t.scope?'方案摘要：'+h.plan.content.slice(0,600)+(h.plan.content.length>600?'…（context-section plan 查看全文）':'')+'\n':''}`+
 files.map(f=>`${f.kind==='supplemental'?'按需补读':'建议首读'}：${f.path}${f.range?' / '+f.range.start_line+'–'+f.range.end_line+' 行':''}${f.reason?'；'+f.reason:''}`).join('\n')+
 (h.files.length>files.length?'\n更多资料：context-section files':'')+
 (h.review_focus.length?'\n审查重点：'+h.review_focus.join('；'):'')+'\n'+h.guidance;
}
export function runnerEntry(runId:string,ledgerRoot:string,connection:Row={}){
 const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
 const env=`$env:WORKBENCH_ROOT=${quote(ledgerRoot)}; `+(connection.dataDir?`$env:WORKBENCH_DATA_DIR=${quote(connection.dataDir)}; `:'')+(connection.port?`$env:WORKBENCH_PORT=${quote(String(connection.port))}; `:'');
 return `未配置 MCP 或 npm 时使用工作台随单提供的本机入口，无需查找客户端安装路径：\n\n    ${env}& ${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx'))} ${quote(path.join(ledgerRoot,'scripts','agent.ts'))} ${runId} start\n\n将末尾 start 换为 context、report <JSON文件>、review、continue、job <调用编号>、manage <工具名> <JSON文件> 或 closeout <结果JSON>。同会话返修后这条入口继续有效，服务端返回当前 Run；无需用户再次复制。\n`;
}
export function compactOrder(t:Row,p:Row,r:Row,ledgerRoot:string,execution:Row={},connection:Row={}){
 t=runTask(t,r);const profile=resolveDeliveryProfile(t),deploy=profile.deployment;
 return `# ${t.title}
Task ${t.id} / Run ${r.id} / 版本 ${t.version}
执行者：${r.agent_id}；审查者：${t.reviewer_id||'未安排'}；建议顺序：${execution.step||1}
工作目录：${r.cwd}
产物目录：${t.context_contract?.output_dir||r.cwd}
交付：${profile.artifacts.join('、')}${deploy.mode==='none'?'':'；'+deploy.mode+' / '+deploy.target}

## 本轮工作
${t.goal}
${t.scope}
${r.retry_context?'本轮返修意见见 context 的 review_changes / user_feedback；已掌握的历史无需重读。':'验收要点：\n'+t.acceptance.map((x:string)=>'- '+x).join('\n')}

## 方案与资料
${handoffText(t)}

## 固定入口
${runnerEntry(r.id,ledgerRoot,connection)}
当前会话按已有上下文继续；缺少资料时用 context 获取简版，单项展开用 context-section plan / files / requirements / history；MCP 对应 get_run_context(section=...)。文件按需读取。
交付用 report，独立审查用 review，返修或收尾用 continue。同一入口跟随当前执行，不需要用户再次转交。
工作台记录流程和结果；模型、预算和阅读清单是建议。执行者可直接调用审查和子代理，登记委派与结果可用 register-delegation / report-delegation。新增外部主执行仍由用户启动。
只回报实际结果；用户试用确认由用户本人完成。

完整资料：${path.join(r.directory,'FULL-RUN.md')}
项目经验：context(mode=full) 的 project_memory 索引按需查询，无需每轮通读。
`;
}
