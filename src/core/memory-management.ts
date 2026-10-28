import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,id,now} from './security.ts';

const key=z.string().trim().min(1).max(200);
const kind=z.enum(['decision','known_issue','failed_attempt','handoff']);
const content=z.string().trim().min(1).max(20000);
const scope=z.string().trim().min(1).max(100);
const mutation={project_id:key,memory_id:key,version:z.number().int().positive()};
// No action is the original create contract. Author/confirmation/history fields are never accepted.
export const manageMemoryInput=z.union([
 z.object({action:z.literal('create').optional(),project_id:key,kind,content,status:z.enum(['candidate','confirmed']),source_id:key,supersedes:key.optional(),scope:scope.default('project')}).strict(),
 z.object({...mutation,action:z.literal('update'),kind,content,scope:scope.default('project')}).strict(),
 z.object({...mutation,action:z.literal('delete')}).strict(),
 z.object({...mutation,action:z.literal('restore')}).strict(),
]);
export function memoryVersion(m:Row):number{return Number.isInteger(m.version)&&m.version>0?m.version:1;}
export function memoryIsDeleted(m:Row):boolean{return !!m.deleted_at;}
function snapshot(m:Row){const {revisions,...record}=m;return structuredClone({...record,version:memoryVersion(m)});}
function revise(m:Row,actor:string,action:string,changes:Row):Row{
 const at=now();
 return {...m,...changes,version:memoryVersion(m)+1,updated_at:at,updated_by:actor,
  revisions:[...(m.revisions||[]),{version:memoryVersion(m),recorded_at:at,recorded_by:actor,action,snapshot:snapshot(m)}]};
}
export function projectMemoryHistory(wb:Workbench,projectId:string):Row{
 wb.get('projects',projectId);
 return {project_id:projectId,items:wb.all('memories').filter(m=>m.project_id===projectId)
  .sort((a,b)=>String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at))||a.id.localeCompare(b.id))
  .map(m=>({...m,version:memoryVersion(m)})),guidance:'删除仅收纳经验；来源任务、会话和版本历史保留。恢复保持替代关系，不自动恢复旧事实。'};
}
export function manageMemory(wb:Workbench,input:unknown,actor='user'):Row{
 const v=manageMemoryInput.parse(input);wb.get('projects',v.project_id);
 return wb.transaction(()=>{
  if(v.action==='update'||v.action==='delete'||v.action==='restore'){
   const old=wb.get('memories',v.memory_id);
   assert(old.project_id===v.project_id,'经验不属于当前项目',403);
   assert(memoryVersion(old)===v.version,'经验版本冲突，请刷新后重试；当前编辑内容已保留',409);
   assert(v.action==='restore'?memoryIsDeleted(old):!memoryIsDeleted(old),v.action==='restore'?'这条经验未被删除':'这条经验已删除，请从历史中恢复',409);
   let changes:Row;
   if(v.action==='update')changes={kind:v.kind,content:v.content,scope:v.scope};
   else if(v.action==='delete')changes={deleted_at:now(),deleted_by:actor};
   else {
    // Even a deleted successor is historical evidence of replacement. Never revive its predecessor as a fact.
    const replaced=wb.all('memories').some(m=>m.project_id===v.project_id&&m.supersedes===old.id);
    changes={deleted_at:null,deleted_by:null,status:old.status==='superseded'||replaced?'superseded':old.status};
   }
   const row=revise(old,actor,v.action,changes);
   wb.put('memories',row,{project_id:row.project_id});wb.audit(actor,'memory_'+v.action,row.id,{version:row.version,previous_version:memoryVersion(old)});
   return row;
  }
  const instruction=wb.managementContext.getStore();
  const delegated=instruction?.tool==='manage_memories'&&instruction.actor===actor&&typeof instruction.user_instruction==='string'&&instruction.user_instruction.trim().length>=2;
  assert(actor==='user'||v.status==='candidate'||delegated,'正式经验需要用户确认或当前会话的明确用户指示',403);
  const src=wb.maybe('tasks',v.source_id)||wb.maybe('sessions',v.source_id);
  assert(src&&(src.project_id===v.project_id||(src.project_ids||[]).includes(v.project_id)),'记忆需引用本项目的真实任务或会话');
  let previous:Row|undefined;
  if(v.supersedes){previous=wb.get('memories',v.supersedes);assert(previous.project_id===v.project_id,'被替代记忆不属于本项目');assert(!memoryIsDeleted(previous),'不能替代已删除经验，请先从历史中恢复',409);}
  const row:Row={id:id('M'),project_id:v.project_id,kind:v.kind,content:v.content,status:v.status,scope:v.scope,source_id:v.source_id,supersedes:v.supersedes||null,
   created_at:now(),source:actor,version:1,revisions:[],confirmation:v.status==='confirmed'?{basis:actor==='user'?'user_page':'conversation_instruction',recorded_by:actor,request_id:instruction?.request_id||null,user_instruction:delegated?instruction!.user_instruction:null}:null};
  wb.put('memories',row,{project_id:row.project_id});
  if(previous){const replaced=revise(previous,actor,'supersede',{status:'superseded'});wb.put('memories',replaced,{project_id:replaced.project_id});}
  wb.audit(actor,'memory',row.id);return row;
 });
}
