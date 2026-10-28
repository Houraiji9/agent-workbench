import fs from 'node:fs';import path from 'node:path';import {z} from 'zod';
import type {Workbench} from './workbench.ts';import type {Row} from './schema.ts';
import {assert,id,now,secret,safePath,atomicWrite} from './security.ts';
import {getReviewContext} from './review-evidence.ts';import {exportReviewOrder,startReview,reviewCollaboration,reviewId} from './review-workflow.ts';
import {saveAgent} from './resource-management.ts';import {sameAgent} from './reviewer-resources.ts';
import {agentDispatchInput,agentJobInput} from './agent-route-schema.ts';
export const handoffId=z.string().regex(/^RH-[a-f0-9-]{36}$/);
export const handoffClaimInput=z.object({handoff_id:handoffId,identity:z.string().trim().min(1).max(100),session_id:z.string().max(300).optional(),actual_model:z.string().max(100).nullable().optional()}).strict();
export const peerDispatchInput=agentDispatchInput.omit({run_id:true,review_id:true}).extend({review_id:reviewId,target_review_id:reviewId});
export const peerJobInput=agentJobInput.omit({run_id:true}).extend({review_id:reviewId});
export function handoffCredentialPath(wb:Workbench,hid:string){handoffId.parse(hid);return safePath(path.join(wb.config.dataDir,'review-handoff-keys',hid+'.json'),[wb.config.dataDir],true);}
function current(wb:Workbench,hid:string){const credential=JSON.parse(fs.readFileSync(handoffCredentialPath(wb,hid),'utf8')),r=wb.get('runs',credential.run_id),h=r.review_handoffs?.find((h:Row)=>h.id===hid);assert(h,'审查交接不存在',404);const c=getReviewContext(wb,r.id);assert(h.review_digest===c.review_digest,'该交接对应旧交付，请复制当前审查交接；旧记录保留',409);return {r,h,c};}
export function openReviewHandoff(wb:Workbench,runId:string){
 const c=getReviewContext(wb,runId),r=wb.get('runs',runId);let h=r.review_handoffs?.find((h:Row)=>h.review_digest===c.review_digest);
 if(!h){h={id:id('RH'),review_digest:c.review_digest,created_at:now()};r.review_handoffs=[...(r.review_handoffs||[]),h];wb.put('runs',r,{task_id:r.task_id});atomicWrite(handoffCredentialPath(wb,h.id),JSON.stringify({handoff_id:h.id,run_id:r.id,token:secret()}));wb.audit('handoff','open_review_handoff',h.id,{run_id:r.id});}
 const file=safePath(path.join(r.directory,'reviews',h.id,'REVIEW.md'),[...wb.config.authorizedRoots,wb.config.dataDir],true),cmd=`& "${process.execPath}" --import "${import.meta.resolve('tsx')}" "${path.join(wb.config.root,'scripts','review.ts')}"`;
 atomicWrite(file,`# 审查交接：${c.title}\nTask ${c.task_id} / Run ${r.id}\n\n这份交接不指定接收者或模型。收到的 Agent 以本人实际身份接单；多人共用此入口，工作台分别记录实际参与者和报告。用户只交接一次，执行者或审查负责人按用户口述安排同伴，不要求用户逐人选择或转发。\n\n接单：${cmd} ${h.id} started "当前Agent名称或ID"\n接单返回本人的 review_id 和后续命令；已接单者沿用自己的编号，不重复建单。模型可不披露。\n只查看本轮方案、变化和指定证据；同会话复审只补读变化，不通读全工程或历史。先读：${cmd} ${h.id} context\n按需调用同伴：接单后用 review.ts <本人的RA> manage manage_reviews <请求JSON> 添加成员，或把这份入口直接交给实际同伴接单；dispatch_review 的 target_review_id 指同伴审查单，get_agent_job 查询实际调用。每人提交自己的结论，汇总保留分歧，不代填同伴报告。\n`);
 return {handoff_id:h.id,run_id:r.id,task_id:c.task_id,review_digest:c.review_digest,order_path:file,entry:`请读取并执行本轮审查交接：${file}\n收到的 Agent 直接以本人身份接单，模型自行选择；需要多人审查时按用户口述安排同伴，使用同一份交接，不再让用户逐人转发。`};
}
export function openReviewContext(wb:Workbench,hid:string){const {r,c}=current(wb,hid),summary=reviewCollaboration(wb,r.id);return {handoff_id:hid,task_id:c.task_id,run_id:r.id,title:c.title,cwd:c.cwd,review_digest:c.review_digest,review_scope:c.review_scope,artifacts:c.artifacts,review_files:c.review_files,members:summary.members.map(m=>({review_id:m.id,reviewer_id:m.reviewer_id,status:m.status,verdict:m.report?.verdict||null})),instructions:'无需预选Agent或披露模型，实际接单后记录审查者。多人使用同一入口，各自回报；只按本轮方案和变化补读。'};}
export function claimReviewHandoff(wb:Workbench,input:unknown){const v=handoffClaimInput.parse(input),{r,h,c}=current(wb,v.handoff_id);return wb.transaction(()=>{
 const name=v.identity.toLocaleLowerCase();let agent=wb.all('agents').find(a=>[a.id,a.name].some(x=>String(x).toLocaleLowerCase()===name));
 if(!agent)agent=saveAgent(wb,null,{version:0,name:v.identity,scope:'外部审查会话接单时登记的实际身份',restriction:'',model:null,icon_key:'auto',allowed_kinds:['review'],models:[]});
 assert(!sameAgent(agent,wb.get('agents',r.agent_id)),'请由实际独立审查者接单，执行者不能代为自审',403);
 const members=wb.runRows('review_assignments',r.id),existing=members.find(a=>a.handoff_id===h.id&&a.reviewer_id===agent!.id&&(!v.session_id||a.session_id===v.session_id)&&!['cancelled','revoked','superseded'].includes(a.status));
 let a:Row=existing!;if(!a){const separate=members.some(a=>a.reviewer_id===agent!.id&&a.status==='running'&&(!v.session_id||a.session_id!==v.session_id));const o=exportReviewOrder(wb,{run_id:r.id,reviewer_id:agent.id,expected_revision:wb.get('tasks',c.task_id).revision,reason:'收到开放式审查交接后，以本人实际身份接单',delivery_mode:'manual',...(separate?{new_review:true}:{})},{role:'reviewer',id:'handoff:'+h.id});a=wb.get('review_assignments',o.review_id);a.handoff_id=h.id;a.requested_model=null;a.model_decided_by='agent';wb.put('review_assignments',a,{run_id:r.id});}
 if(a.status!=='completed')a=startReview(wb,{review_id:a.id,identity:agent.id,...(v.session_id?{session_id:v.session_id}:{}),...(v.actual_model?{actual_model:v.actual_model}:{})});
 const command=`& "${process.execPath}" --import "${import.meta.resolve('tsx')}" "${path.join(wb.config.root,'scripts','review.ts')}" ${a.id}`;
 return {review_id:a.id,run_id:r.id,reviewer_id:agent.id,status:a.status,commands:{context:command+' context',submit:command+' submit "本人报告.json"',manage:command+' manage <工具名> <请求JSON>'},instructions:'后续使用本人的review_id。可按用户口述安排同伴，工作台分别收录本人报告，不要求用户重复交接。'};
});}
