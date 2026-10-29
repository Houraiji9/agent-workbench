import {test} from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import fs from 'node:fs';
import {fixture,setup,event,finishCloseout} from './helpers.ts';
import {createApp} from '../src/server/app.ts';import type {Workbench} from '../src/core/workbench.ts';
import {manage} from '../src/core/management.ts';import {exportReviewOrder,startReview,submitReviewResult} from '../src/core/review-workflow.ts';
import {refreshDecision,resolveDecisionGroup} from '../src/core/user-decisions.ts';
process.env.WORKBENCH_RETAIN_TEST_DATA='1';
async function passed(wb:Workbench,root:string,group?:string){
 const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));const sent=wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离测试：完整交付报告用于验证用户确认边界，未调用真实审查模型。'}));assert.equal(sent.disposition,'applied',sent.error);
 const order=exportReviewOrder(wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:wb.get('tasks',s.tid).revision,reason:'隔离测试模拟独立报告'},{role:'planner'});startReview(wb,{review_id:order.review_id,identity:'grok-build'});
 submitReviewResult(wb,{...order.context.final_response,review_id:order.review_id,verdict:'passed',findings:[],limitations:['合成测试不是实际独审'],evidence:['隔离夹具'],report_markdown:'合成独立审查报告：仅验证用户确认生命周期，不启动任何模型或客户端。'},'reviewer:'+order.review_id);finishCloseout(wb,s.tid);
 const t=wb.get('tasks',s.tid);if(group)wb.put('tasks',{...t,delivery_group_id:group},{project_id:t.project_id});
 const proposal=await manage(wb,{} as any,'manage_tasks',{request_id:crypto.randomUUID(),user_instruction:'隔离测试中准备使用确认卡，须可信页面用户本人确认。',change:{action:'accept',task_id:s.tid,run_id:s.rid,revision:t.revision}});
 return {...s,id:proposal.result.decision_id};
}
const expire=(wb:Workbench,id:string)=>{const d=wb.get('user_decisions',id);wb.put('user_decisions',{...d,expires_at:new Date(Date.now()-1000).toISOString()});};
const auditCount=(wb:Workbench,action:string)=>(wb.db.prepare('SELECT count(*) n FROM audit WHERE action=?').get(action) as any).n;

test('expired decision refresh is in place, idempotent and does not rerun reviews or closeout',async()=>{
 const f=fixture();try{const s=await passed(f.wb,f.root,'DG-synthetic');const before={runs:JSON.stringify(f.wb.all('runs')),reviews:JSON.stringify(f.wb.all('reviews')),task:JSON.stringify(f.wb.get('tasks',s.tid))};expire(f.wb,s.id);
 assert.throws(()=>resolveDecisionGroup(f.wb,[s.id]),/过期/);const first=refreshDecision(f.wb,s.id);assert.equal(first.result.decision_id,s.id);assert.equal(first.status,'awaiting_user_confirmation');assert.deepEqual(refreshDecision(f.wb,s.id),first);assert.equal(auditCount(f.wb,'refresh_user_decision'),1);
 assert.equal(JSON.stringify(f.wb.all('runs')),before.runs);assert.equal(JSON.stringify(f.wb.all('reviews')),before.reviews);assert.equal(JSON.stringify(f.wb.get('tasks',s.tid)),before.task);assert.equal(f.wb.get('tasks',s.tid).status,'awaiting_confirmation');
 }finally{f.wb.close()}
});

test('refresh refuses changed binding without mutating expiry or historical evidence',async()=>{
 const f=fixture();try{const s=await passed(f.wb,f.root,'DG-synthetic');expire(f.wb,s.id);const old=JSON.stringify(f.wb.get('user_decisions',s.id)),t=f.wb.get('tasks',s.tid);f.wb.put('tasks',{...t,revision:t.revision+1},{project_id:t.project_id});assert.throws(()=>refreshDecision(f.wb,s.id),/已变化/);assert.equal(JSON.stringify(f.wb.get('user_decisions',s.id)),old);assert.equal(auditCount(f.wb,'refresh_user_decision'),0);}finally{f.wb.close()}
});

test('group only accepts explicitly selected same-group cards, never silently accepts omitted cards',async()=>{
 const f=fixture();try{const a=await passed(f.wb,f.root,'DG-one'),b=await passed(f.wb,f.root,'DG-one'),c=await passed(f.wb,f.root,'DG-other');
 assert.throws(()=>resolveDecisionGroup(f.wb,[a.id,c.id]),/同一交付/);assert.throws(()=>resolveDecisionGroup(f.wb,[a.id,a.id]),/不重复/);assert.throws(()=>resolveDecisionGroup(f.wb,[]),/请选择/);assert.equal(f.wb.get('tasks',a.tid).status,'awaiting_confirmation');
 const selected=resolveDecisionGroup(f.wb,[a.id]);assert.equal(selected.results.length,1);assert.equal(f.wb.get('tasks',a.tid).status,'accepted');assert.equal(f.wb.get('tasks',b.tid).status,'awaiting_confirmation');assert.equal(f.wb.get('tasks',c.tid).status,'awaiting_confirmation');const count=auditCount(f.wb,'accept');assert.deepEqual(resolveDecisionGroup(f.wb,[a.id]),selected);assert.equal(auditCount(f.wb,'accept'),count);
 }finally{f.wb.close()}
});

test('later group member hash failure rolls back earlier acceptance and all confirmation audits',async()=>{
 const f=fixture();try{const a=await passed(f.wb,f.root,'DG-one'),b=await passed(f.wb,f.root,'DG-one');const artifact=f.wb.all('artifacts').find(x=>x.run_id===b.rid)!;fs.appendFileSync(artifact.archive_path,'tampered synthetic fixture');const before=auditCount(f.wb,'accept');
 assert.throws(()=>resolveDecisionGroup(f.wb,[a.id,b.id]),/更改|校验|变化/);for(const s of [a,b]){assert.equal(f.wb.get('tasks',s.tid).status,'awaiting_confirmation');assert.equal(f.wb.get('user_decisions',s.id).status,'pending');}assert.equal(auditCount(f.wb,'accept'),before);assert.equal(auditCount(f.wb,'confirm_user_decision'),0);
 }finally{f.wb.close()}
});

test('manager context cannot refresh cards or confirm groups',async()=>{
 const f=fixture();try{const s=await passed(f.wb,f.root,'DG-one');expire(f.wb,s.id);const ctx={request_id:crypto.randomUUID(),tool:'manage_tasks',user_instruction:'不能作为用户验收',actor:'manager'};
 assert.throws(()=>f.wb.managementContext.run(ctx,()=>refreshDecision(f.wb,s.id)),/页面刷新/);assert.throws(()=>f.wb.managementContext.run(ctx,()=>resolveDecisionGroup(f.wb,[s.id])),/不能代用户验收/);assert.equal(f.wb.get('tasks',s.tid).status,'awaiting_confirmation');
 }finally{f.wb.close()}
});

test('HTTP refresh and group confirm require page cookie and CSRF, reject manager bearer, repeated confirm applies once',async()=>{
 const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});try{
 const a=await passed(wb,f.root,'DG-one'),b=await passed(wb,f.root,'DG-one');expire(wb,a.id);const host='127.0.0.1:'+f.config.port,refresh='/api/user-decisions/'+a.id+'/refresh',group='/api/user-decision-groups/confirm',manager={host,authorization:'Bearer '+wb.keys.manager};
 for(const [url,payload] of [[refresh,{}],[group,{decision_ids:[a.id,b.id]}]] as const){const res=await app.inject({method:'POST',url,headers:manager,payload});assert.equal(res.statusCode,401,res.body);}
 const boot=await app.inject({url:'/api/bootstrap',headers:{host}}),page={host,cookie:String(boot.headers['set-cookie']).split(';')[0]},trusted={...page,'x-workbench-csrf':boot.json().csrf};
 for(const [url,payload] of [[refresh,{}],[group,{decision_ids:[a.id,b.id]}]] as const){assert.equal((await app.inject({method:'POST',url,headers:page,payload})).statusCode,403);assert.equal((await app.inject({method:'POST',url,headers:{...trusted,authorization:manager.authorization},payload})).statusCode,403);}
 const fresh=await app.inject({method:'POST',url:refresh,headers:trusted,payload:{}});assert.equal(fresh.statusCode,200,fresh.body);assert.equal(wb.get('tasks',a.tid).status,'awaiting_confirmation');
 const request={method:'POST' as const,url:group,headers:trusted,payload:{decision_ids:[a.id,b.id]}};const first=await app.inject(request),second=await app.inject(request);assert.equal(first.statusCode,200,first.body);assert.deepEqual(second.json(),first.json());assert.equal(wb.get('tasks',a.tid).status,'accepted');assert.equal(wb.get('tasks',b.tid).status,'accepted');assert.equal(auditCount(wb,'accept'),2);assert.equal(auditCount(wb,'confirm_user_decision'),2);
 }finally{await app.close()}
});
