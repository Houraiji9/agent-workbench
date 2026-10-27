import type {Row} from './schema.ts';
import {type HandoffRole} from '../shared/task-handoff.ts';

/** Workbench records advice; client authorization and truthful evidence remain separate. */
export const workflowGuidance='工作台负责引导、记录和汇总。流程顺序、资源快照、模型、阅读清单与预算是建议，不是操作许可。按当前用户要求自主推进，按需补读；结果、来源和未验证项如实回报。';

export function preview(value:unknown,limit=700):string {
  const text=typeof value==='string'?value:JSON.stringify(value??null);
  return text.length<=limit?text:text.slice(0,limit)+'…（全文按需读取）';
}
function list(value:any,limit=8){return Array.isArray(value)?value.slice(0,limit).map(x=>typeof x==='string'?preview(x,300):x):value;}
/** Bounded handoff, not a claim that the caller already read the full material. */
export function briefContext(context:Row,role:HandoffRole='executor'):Row {
  const out:Row={};
  for(const key of ['task_id','run_id','review_id','reviewer_id','agent_id','title','cwd','source_root','runtime_root','task_version','review_digest','importance','requested_model'])if(key in context)out[key]=context[key];
  for(const key of ['goal','scope'])if(key in context)out[key]=preview(context[key]);
  for(const key of ['acceptance','tests','allowed_paths','forbidden_actions','required_files'])if(key in context){out[key]=list(context[key]);if(context[key]?.length>8)out[key+'_total']=context[key].length;}
  if(context.delivery_profile)out.delivery={artifacts:context.delivery_profile.artifacts,deployment:context.delivery_profile.deployment};
  if(context.execution_policy)out.execution_advice={main_model:context.execution_policy.main_model,allow_subagents:context.execution_policy.allow_subagents,child_models:context.execution_policy.child_models,note:preview(context.execution_policy.note||'',300)};
  if(context.review_route)out.review_route=context.review_route;
  if(context.review_policy)out.review_policy=context.review_policy;
  if(context.handoff)out.handoff={...context.handoff,files:undefined,plan:{...context.handoff.plan,content:context.handoff.plan.content?preview(context.handoff.plan.content,700):undefined},review_focus:list(context.handoff.review_focus)};
  if(context.review_scope)out.review_scope={mode:context.review_scope.mode,label:context.review_scope.label,focus:list(context.review_scope.focus),limitation:context.review_scope.limitation};
  if(context.file_context){const files=context.file_context.files.filter((f:Row)=>!f.roles?.length||f.roles.includes(role));out.files={output_dir:context.file_context.contract?.output_dir||null,suggested:files.slice(0,12).map((f:Row)=>({path:f.path,range:f.range,kind:f.kind,reason:f.reason,roles:f.roles,status:f.status})),total:files.length,...(context.file_context.removed?{removed:context.file_context.removed}:{})};}
  if(context.delivery_warnings)out.delivery_warnings=context.delivery_warnings;
  if(context.artifacts)out.artifacts=context.artifacts.slice(0,8).map((a:Row)=>({id:a.id,label:a.label,archive_path:a.archive_path}));
  if(context.review_files)out.review_files={paths:context.review_files.slice(0,12).map((f:Row)=>f.path),total:context.review_files.length};
  if(context.previous_findings)out.previous_findings=context.previous_findings.slice(-5).map((f:Row)=>({id:f.id,findings:preview(f.findings,900)}));
  if(context.amendments)out.amendments=context.amendments.slice(-3).map((a:Row)=>({id:a.id,reason:preview(a.reason||'',400),changes:preview(a.changes,700)}));
  if(context.delegations)out.delegations=context.delegations.slice(-8).map((d:Row)=>({id:d.id,status:d.status,goal:preview(d.goal,150)}));
  return out;
}

export function contextChanges(current:Row,previous?:Row){
  if(!previous)return current;
  const changes=Object.fromEntries(Object.entries(current).filter(([key,value])=>JSON.stringify(previous[key])!==JSON.stringify(value)));
  if(changes.file_context&&JSON.stringify(current.file_context.contract)===JSON.stringify(previous.file_context?.contract)){
    const before=new Map((previous.file_context?.files||[]).map((f:Row)=>[f.key,JSON.stringify(f)]));
    changes.file_context={...current.file_context,files:current.file_context.files.filter((f:Row)=>before.get(f.key)!==JSON.stringify(f)),removed:(previous.file_context?.files||[]).filter((f:Row)=>!current.file_context.files.some((n:Row)=>n.key===f.key)).map((f:Row)=>({path:f.path,range:f.range}))};
  }
  return changes;
}
/** Expand one subject without injecting unrelated history or the entire contract. */
export function contextSection(context:Row,section:string,role:HandoffRole='executor'){
  if(section==='plan')return {handoff:context.handoff};
  if(section==='files')return {files:{output_dir:context.file_context?.contract?.output_dir||null,suggested:(context.file_context?.files||[]).filter((f:Row)=>!f.roles?.length||f.roles.includes(role))}};
  if(section==='requirements')return Object.fromEntries(['goal','scope','acceptance','tests','review_scope','required_files','delivery_profile'].filter(key=>key in context).map(key=>[key,context[key]]));
  return Object.fromEntries(['project_memory','amendments','previous_findings','review_changes','user_feedback'].filter(key=>key in context).map(key=>[key,context[key]]));
}
