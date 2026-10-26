import type {Row} from './schema.ts';

/** Workbench records advice; client authorization and truthful evidence remain separate. */
export const workflowGuidance='工作台负责引导、记录和汇总。流程顺序、资源快照、模型、阅读清单与预算是建议，不是操作许可。按当前用户要求自主推进，按需补读；结果、来源和未验证项如实回报。';

export function preview(value:unknown,limit=700):string {
  const text=typeof value==='string'?value:JSON.stringify(value??null);
  return text.length<=limit?text:text.slice(0,limit)+'…（全文按需读取）';
}
function list(value:any,limit=8){return Array.isArray(value)?value.slice(0,limit).map(x=>typeof x==='string'?preview(x,300):x):value;}
/** Bounded handoff, not a claim that the caller already read the full material. */
export function briefContext(context:Row):Row {
  const out:Row={};
  for(const key of ['task_id','run_id','review_id','reviewer_id','agent_id','title','cwd','source_root','runtime_root','task_version','review_digest','importance','requested_model'])if(key in context)out[key]=context[key];
  for(const key of ['goal','scope'])if(key in context)out[key]=preview(context[key]);
  for(const key of ['acceptance','tests','allowed_paths','forbidden_actions','required_files'])if(key in context){out[key]=list(context[key]);if(context[key]?.length>8)out[key+'_total']=context[key].length;}
  if(context.delivery_profile)out.delivery={artifacts:context.delivery_profile.artifacts,deployment:context.delivery_profile.deployment};
  if(context.execution_policy)out.execution_advice={main_model:context.execution_policy.main_model,allow_subagents:context.execution_policy.allow_subagents,child_models:context.execution_policy.child_models,note:preview(context.execution_policy.note||'',300)};
  if(context.review_route)out.review_route=context.review_route;
  if(context.review_policy)out.review_policy=context.review_policy;
  if(context.file_context)out.files={output_dir:context.file_context.contract?.output_dir||null,suggested:context.file_context.files.slice(0,12).map((f:Row)=>({path:f.path,range:f.range,status:f.status})),total:context.file_context.files.length};
  if(context.delivery_warnings)out.delivery_warnings=context.delivery_warnings;
  if(context.artifacts)out.artifacts=context.artifacts.slice(0,8).map((a:Row)=>({id:a.id,label:a.label,archive_path:a.archive_path}));
  if(context.review_files)out.review_files={paths:context.review_files.slice(0,12).map((f:Row)=>f.path),total:context.review_files.length};
  if(context.previous_findings)out.previous_findings=context.previous_findings.slice(-5).map((f:Row)=>({id:f.id,findings:preview(f.findings,900)}));
  if(context.amendments)out.amendments=context.amendments.slice(-3).map((a:Row)=>({id:a.id,reason:preview(a.reason||'',400),changes:preview(a.changes,700)}));
  if(context.delegations)out.delegations=context.delegations.slice(-8).map((d:Row)=>({id:d.id,status:d.status,goal:preview(d.goal,150)}));
  return out;
}
