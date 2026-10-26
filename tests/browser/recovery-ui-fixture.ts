import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {setup,event} from '../helpers.ts';
import {exportReviewOrder,reviewAssignmentContext} from '../../src/core/review-workflow.ts';
import {recoverNativeReview} from '../../src/core/native-review-recovery.ts';
import {jobView} from '../../src/core/agent-orchestration.ts';
export function seedRecoveryUi(wb:any,root:string){
 for(const sameSession of [true,false]){
   const s=setup(wb,root),task=wb.get('tasks',s.tid);
   task.title=sameSession?'测试：手工原会话继续返修':'测试：首次派单仍需交接';
   task.status='awaiting_dispatch';task.execution_route=null;task.automation=null;
   if(sameSession)task.same_session_continuation={run_id:s.rid,source_run_id:'R-'+crypto.randomUUID(),agent_id:task.agent_id,job_id:null};
   else delete task.same_session_continuation;
   wb.put('tasks',task,{project_id:task.project_id});
 }

 for(const live of [false,true]){
 const t=setup(wb,root);let task=wb.get('tasks',t.tid);task.title=live?'测试：仍有进程未核实':'测试：原生审查已补登记';wb.put('tasks',task,{project_id:task.project_id});wb.event(event(root,t.tid,t.rid,1));wb.event(event(root,t.tid,t.rid,2,'submitted',{result:'隔离浏览器合成回归，仅用于来源与恢复展示。'}));
 const a=exportReviewOrder(wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:wb.get('tasks',t.tid).revision,reason:'隔离展示回归'},{role:'user'}),ctx=reviewAssignmentContext(wb,a.review_id),jid='AJ-'+crypto.randomUUID(),dir=path.join(root,'.agent-workbench-output',t.tid,t.rid,'calls',jid);fs.mkdirSync(dir,{recursive:true});
 const payload={...ctx.report_template,verdict:'changes_requested',findings:['合成报告意见'],limitations:['非真实模型审查'],evidence:['隔离测试资料'],report_markdown:'# 原生合成报告\n\n本次材料用于复现来源与调用状态展示。'},wire={type:'result',subtype:'success',is_error:false,session_id:'synthetic-recovery-ui',result:'前言说明\n'+JSON.stringify(payload)};
 const job={id:jid,task_id:t.tid,run_id:t.rid,review_id:a.review_id,role:'review',phase:'review',route:{client:'cursor',model:'synthetic'},status:'failed',reason:'Unexpected token in JSON at position 0',process_may_be_running:live,process_end_evidence:live?'unknown':'owned_child_exit',exit_code:0,session_id:wire.session_id,files:{stdout:path.join(dir,'stdout.jsonl')},ended_at:new Date().toISOString(),revision:1};fs.writeFileSync(job.files.stdout,JSON.stringify(wire)+'\n');wb.put('agent_jobs',job,{run_id:t.rid});task=wb.get('tasks',t.tid);task.automation=jobView(job);if(live)task.automation.superseded={reason:'隔离测试：过期标记不能隐藏未核实进程'};wb.put('tasks',task,{project_id:task.project_id});if(!live)recoverNativeReview(wb,{run_id:t.rid,job_id:jid});
 }
}
