import { z } from 'zod';
import type { Workbench } from './workbench.ts';
import type { Row } from './schema.ts';
import { assert, id, now } from './security.ts';
import { modelCatalog, type ModelGroup } from './model-catalog.ts';
import { agentPresets } from './agent-presets.ts';
import { baseQuotaView } from './quota-cache.ts';
import {monthlyPointsSchema} from './points-schema.ts';
import { agentIconKeys } from '../shared/resource-options.ts';

const text=z.string().trim().min(1).max(100);
const kinds=z.enum(['engineering','frontend_light','review','research','operations']);
const model=z.object({id:text,name:text,purpose:z.string().trim().max(500),access:z.string().max(300).optional(),kind:z.literal('mode').optional(),retire_at:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict();
const agentInput=z.object({version:z.number().int().nonnegative(),preset_id:z.string().max(100).nullable().optional(),name:text,scope:z.string().trim().min(1).max(10000),restriction:z.string().trim().max(10000),model:z.string().max(200).nullable(),icon_key:z.enum(agentIconKeys),allowed_kinds:z.array(kinds).min(1).max(5),models:z.array(model).max(60).refine(ms=>new Set(ms.map(m=>m.id)).size===ms.length,'模型名称不能重复')}).strict();
const versionInput=z.object({version:z.number().int().nonnegative()}).strict();
export function currentModels(wb:Workbench):ModelGroup[]{
  return wb.all('agents').filter(a=>!a.archived).map(a=>{
    const base=modelCatalog.find(g=>g.agent_id===a.id);
    return a.model_group||base||{agent_id:a.id,as_of:a.as_of||'',sources:[],models:[]};
  });
}
export function saveAgent(wb:Workbench,aid:string|null,input:unknown):Row{
  const v=agentInput.parse(input);
  return wb.transaction(()=>{
    const old=aid?wb.get('agents',aid):null;
    assert(!old?.archived,'请先恢复这位成员',409);
    assert(v.version===(old?.version||0),'成员资料已更新，请重新打开编辑',409);
    const preset=agentPresets.find(p=>p.id===(old?.preset_id||v.preset_id));
    assert(!v.preset_id||preset,'预设不存在');
    if(old)assert(v.preset_id===undefined||v.preset_id===old.preset_id||!v.preset_id,'成员的来源预设保持不变');
    if(!old&&preset){
      const matches=wb.all('agents').filter(a=>a.preset_id===preset.id||a.id===preset.existing_id);
      assert(!matches.some(a=>!a.archived),'这位成员已经在团队中',409);
      assert(!matches.some(a=>a.archived&&a.managed_archived),'这位成员在已移除中，请恢复原记录',409);
    }
    assert(!wb.all('agents').some(a=>a.id!==aid&&!a.archived&&a.name.toLocaleLowerCase()===v.name.toLocaleLowerCase()),'团队中已有这个名称',409);
    if(aid==='grok-build'||preset?.id==='grok-build')assert(v.allowed_kinds.length===1&&v.allowed_kinds[0]==='review','Grok Build 的职责是独立审查');
    const key=aid||id('A'),at=now(),catalogGroup=modelCatalog.find(g=>g.agent_id===aid);
    const row={...(old||{}),id:key,name:v.name,scope:v.scope,restriction:v.restriction,model:v.model,icon_key:v.icon_key,allowed_kinds:[...new Set(v.allowed_kinds)],
      preset_id:old?.preset_id||preset?.id||null,account_ids:old?.account_ids||[],pool_ids:old?.pool_ids||[],activity:old?.activity||'unknown',source:old?.source||'user_entered',version:v.version+1,updated_at:at,
      model_group:{agent_id:key,as_of:old?.model_group?.as_of||catalogGroup?.as_of||preset?.as_of||at.slice(0,10),sources:old?.model_group?.sources||catalogGroup?.sources||preset?.sources||[],models:v.models}};
    wb.put('agents',row);wb.audit('user',old?'edit_agent':'add_agent',key,{before:old,after:row});return row;
  });
}
export function archiveAgent(wb:Workbench,aid:string,input:unknown,restore=false):Row{
  const v=versionInput.parse(input);
  return wb.transaction(()=>{
    const old=wb.get('agents',aid);assert(v.version===old.version,'成员资料已更新，请重新打开后操作',409);
    if(restore){
      assert(old.archived&&old.managed_archived,'这位成员已合并或属于旧入口',409);
      assert(!wb.all('agents').some(a=>!a.archived&&(a.name.toLocaleLowerCase()===old.name.toLocaleLowerCase()||old.preset_id&&a.preset_id===old.preset_id)),'团队已有同名成员或相同预设，请先调整',409);
    }else{
      assert(!old.archived,'这位成员已删除',409);
      const open=wb.all('tasks').filter(t=>!['accepted','cancelled','rework_linked'].includes(t.status)&&((t.current_run_id?wb.get('runs',t.current_run_id).agent_id:t.agent_id)===aid||t.reviewer_id===aid));
      assert(!open.length,`还有 ${open.length} 项任务关联此成员，请先完成、改派或取消：${open.slice(0,3).map(t=>t.title).join('、')}`,409);
    }
    const row={...old,archived:!restore,managed_archived:!restore,version:old.version+1,updated_at:now()};
    wb.put('agents',row);wb.audit('user',restore?'restore_agent':'delete_agent',aid,{before:old,after:row});return row;
  });
}

const number=z.number().finite().min(0).max(1e12);
const quotaWindow=z.object({label:text,metric:z.enum(['percent','points','currency','count']),remaining:number.nullable(),limit:number.positive().nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),unit:z.string().trim().max(20),resets_at:z.string().datetime({offset:true}).nullable(),monthly:monthlyPointsSchema.nullable().optional()}).strict().superRefine((w,ctx)=>{
  if(w.metric==='percent'&&w.remaining!==null&&w.remaining>100)ctx.addIssue({code:'custom',message:'百分比须在 0—100 之间'});
  if(w.metric!=='percent'&&w.limit!==null&&w.remaining!==null&&w.remaining>w.limit)ctx.addIssue({code:'custom',message:'剩余数量超过总量'});
  if(w.metric==='currency'&&!w.currency)ctx.addIssue({code:'custom',message:'请选择币种'});
  if(w.monthly&&w.metric!=='points')ctx.addIssue({code:'custom',message:'月度基础积分适用于积分类型'});
  if(w.monthly&&w.limit!==null)ctx.addIssue({code:'custom',message:'月度积分请使用每月基础积分作为总量'});
  if(w.monthly?.remaining!=null&&w.remaining!==null&&w.monthly.remaining>w.remaining)ctx.addIssue({code:'custom',message:'月度积分包含在总积分内，请核对数量'});
});
const quotaInput=z.object({version:z.number().int().nonnegative(),source_ref:z.string().max(300).nullable(),name:text,members:z.array(z.string().max(100)).max(100),windows:z.array(quotaWindow).max(20)}).strict();
export {agentInput,quotaInput,versionInput};
const defaultMember:Record<string,string>={grok:'grok-build',zai:'zcode',codex:'codex',claude:'claude',antigravity:'antigravity',deepseek:'deepseek',kimi:'kimi',workbuddy:'workbuddy',gemini:'gemini'};
export function quotaMembers(wb:Workbench,p:Row){return (p.members?.length?p.members:[defaultMember[p.provider]].filter(Boolean)).filter((aid:string)=>!wb.maybe('agents',aid)?.archived&&!!wb.maybe('agents',aid))}
export function saveQuota(wb:Workbench,qid:string|null,input:unknown,archive=false):Row{
  const v=quotaInput.parse(input);
  return wb.transaction(()=>{
    const old=qid?wb.get('quota_definitions',qid):null;
    assert(!old?.archived,'请先恢复这项额度',409);
    assert(v.version===(old?.version||0),'额度设置已更新，请重新打开编辑',409);
    if(old)assert(v.source_ref===old.source_ref,'额度来源保持不变，请单独添加新的记录');
    const members=[...new Set(v.members)];
    for(const aid of members)assert(!wb.get('agents',aid).archived,'关联成员已移出团队，请重新选择');
    if(v.source_ref){
      assert(baseQuotaView(wb).pools.some(p=>p.id===v.source_ref),'来源额度已不可用，请重新选择');
      assert(!wb.all('quota_definitions').some(q=>q.id!==qid&&q.source_ref===v.source_ref),'这项来源已登记，请编辑或恢复原记录',409);
      assert(!v.windows.length,'同步额度通过原数据来源更新');
    }else assert(v.windows.length>0,'请添加至少一个额度窗口');
    assert(!archive||!!v.source_ref,'仅来源额度使用隐藏入口');
    const key=qid||id('QP'),at=now(),valuesAt=old&&JSON.stringify(old.windows)===JSON.stringify(v.windows)?old.values_updated_at||old.updated_at:at;
    const row={...v,id:key,members,version:v.version+1,source:'user_entered',updated_at:at,values_updated_at:valuesAt,archived:archive};
    wb.put('quota_definitions',row);wb.audit('user',old?'edit_quota':'add_quota',key,{before:old,after:row});return row;
  });
}
export function archiveQuota(wb:Workbench,qid:string,input:unknown,restore=false):Row{
  const v=versionInput.parse(input);
  return wb.transaction(()=>{
    const old=wb.get('quota_definitions',qid);assert(old.version===v.version,'额度设置已更新，请重新打开后操作',409);
    assert(!!old.archived===restore,restore?'这项额度已恢复':'这项额度已删除',409);
    const row={...old,archived:!restore,version:old.version+1,updated_at:now()};wb.put('quota_definitions',row);wb.audit('user',restore?'restore_quota':'delete_quota',qid,{before:old,after:row});return row;
  });
}
export function managedQuotaView(wb:Workbench,pools:Row[],windows:Row[]){
  const definitions=wb.all('quota_definitions'),activeAgents=new Set(wb.all('agents').filter(a=>!a.archived).map(a=>a.id));
  const result:Row[]=pools.flatMap(p=>{
    const def=definitions.find(d=>d.source_ref===p.id);if(def?.archived)return [];
    return [{...p,name:def?.name||p.name,members:(def?.members||quotaMembers(wb,p)).filter((a:string)=>activeAgents.has(a)),management_id:def?.id||null,management_version:def?.version||0}];
  });
  const projected=windows.filter(w=>result.some(p=>p.id===w.pool_id));
  for(const d of definitions.filter(d=>!d.source_ref&&!d.archived)){
    const hasValue=d.windows.some((w:Row)=>w.remaining!==null||w.monthly?.remaining!=null),at=d.values_updated_at||d.updated_at,age=Date.now()-Date.parse(at),fresh=age>=0&&age<=600000;
    result.push({id:d.id,name:d.name,provider:'custom',source:'user_entered',custom_quota:true,management_id:d.id,management_version:d.version,members:d.members.filter((a:string)=>activeAgents.has(a)),display_state:hasValue?'manual':'empty',status:hasValue?'ok':'notConfigured',freshness:hasValue&&fresh?'fresh':'stale',source_updated_at:at,balance:null});
    projected.push(...d.windows.map((w:Row,i:number)=>({...w,id:d.id+':'+i,pool_id:d.id,kind:'custom',remaining_percent:w.metric==='percent'?w.remaining:w.remaining!==null&&w.limit?100*w.remaining/w.limit:null,remaining:w.metric==='percent'?null:w.remaining,unit:w.metric==='percent'?'percent':w.metric==='points'?'积分':w.metric==='currency'?w.currency:w.unit||'次',source:'user_entered',source_updated_at:at,display_state:w.remaining!==null||w.monthly?.remaining!=null?'manual':'empty',freshness:(w.remaining!==null||w.monthly?.remaining!=null)&&fresh?'fresh':'stale'})));
  }
  return {pools:result,windows:projected};
}

