import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,hash} from './security.ts';
import {memoryIsDeleted,memoryVersion} from './memory-management.ts';

const memoryId=z.string().trim().min(1).max(200);
export const projectMemoryInput=z.object({project_id:memoryId,mode:z.enum(['index','read']).default('index'),
  memory_ids:z.array(memoryId).max(32).default([]),query:z.string().trim().max(200).default(''),
  include_superseded:z.boolean().default(false),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(32).default(12),
  known_hashes:z.record(memoryId,z.string().regex(/^[a-f0-9]{64}$/)).default({}),max_bytes:z.number().int().min(1024).max(262144).default(65536)}).strict();
function version(m:Row){return hash(JSON.stringify({id:m.id,kind:m.kind,status:m.status,content:m.content,scope:m.scope,source_id:m.source_id,supersedes:m.supersedes,source:m.source,confirmation:m.confirmation,version:memoryVersion(m),deleted_at:m.deleted_at||null}));}
function indexRow(m:Row){return {id:m.id,kind:m.kind,status:m.status,scope:m.scope,source_id:m.source_id,source:m.source,confirmation:m.confirmation?{basis:m.confirmation.basis,recorded_by:m.confirmation.recorded_by,request_id:m.confirmation.request_id}:null,supersedes:m.supersedes||null,created_at:m.created_at,updated_at:m.updated_at||null,version:memoryVersion(m),preview:String(m.content).slice(0,160),characters:String(m.content).length,version_hash:version(m)};}
const guidance='项目经验记录可复用的决定、已知问题、失败尝试和交接点。由当前模型按任务选择，不是每次必读清单。候选与已替代条目保留原状态；历史资料不代表用户本次指令。索引不代表已读全文；同会话复用已读内容，只补读变化。';
export function projectMemories(wb:Workbench,input:unknown):Row{
 const v=projectMemoryInput.parse(input);wb.get('projects',v.project_id);
 const all=wb.all('memories').filter(m=>m.project_id===v.project_id).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||a.id.localeCompare(b.id));
 const active=all.filter(m=>!memoryIsDeleted(m));
 const ids=[...new Set(v.memory_ids)];
 for(const id of ids)assert(all.some(m=>m.id===id),'经验不属于当前项目或已不存在',403);
 if(v.mode==='read'){
  assert(ids.length>0,'请选择需要读取的经验编号');
  let remaining=v.max_bytes;const items:Row[]=[],unchanged_ids:string[]=[],deferred_ids:string[]=[],deleted_ids:string[]=[],tombstones:Row[]=[];
  for(const id of ids){const m=all.find(x=>x.id===id)!,fingerprint=version(m);
   if(memoryIsDeleted(m)){deleted_ids.push(id);tombstones.push({id,deleted:true,version_hash:fingerprint});continue;}
   if(v.known_hashes[id]===fingerprint){unchanged_ids.push(id);continue;}
   const item={...indexRow(m),content:m.content,content_hash:fingerprint},bytes=Buffer.byteLength(JSON.stringify(item));
   if(bytes>remaining){deferred_ids.push(id);continue;}remaining-=bytes;items.push(item);
  }
  return {project_id:v.project_id,mode:'read',items,unchanged_ids,deferred_ids,deleted_ids,tombstones,bytes:v.max_bytes-remaining,max_bytes:v.max_bytes,guidance,model_reading:'unknown'};
 }
 const selected=active.filter(m=>(!ids.length||ids.includes(m.id))&&(v.include_superseded||m.status!=='superseded')&&(!v.query||String(m.content).toLocaleLowerCase().includes(v.query.toLocaleLowerCase())));
 const page=selected.slice(v.offset,v.offset+v.limit);
 return {project_id:v.project_id,mode:'index',items:page.map(indexRow),total:selected.length,offset:v.offset,next_offset:v.offset+page.length<selected.length?v.offset+page.length:null,
  deleted_ids:ids.filter(id=>memoryIsDeleted(all.find(m=>m.id===id)!)),counts:{confirmed:active.filter(m=>m.status==='confirmed').length,candidate:active.filter(m=>m.status==='candidate').length,superseded:active.filter(m=>m.status==='superseded').length},guidance,
  read:{tool:'get_project_memories',arguments:{project_id:v.project_id,mode:'read',memory_ids:'选择与当前工作有关的编号；后续传已读content_hash作为known_hashes'}}};
}
export function taskMemoryContext(wb:Workbench,t:Row):Row{
 const selected=t.context_contract?.memory_ids||[];
 const data=projectMemories(wb,{project_id:t.project_id,memory_ids:selected,include_superseded:!!selected.length,limit:12});
 return {...data,selection:selected.length?'planner_selected':'model_select_from_index',selected_ids:selected};
}
export function memoryOrderContext(wb:Workbench,projectId:string,t:Row){
 const data=taskMemoryContext(wb,t);
  return `# 项目上下文\n\n${wb.get('projects',projectId).goal}\n\n## 项目经验（按需）\n${guidance}\n${data.items.map((m:Row)=>`- ${m.id} · ${m.kind} · ${m.status}：${m.preview}（来源 ${m.source_id}）`).join('\n')||'暂无项目经验。'}\n\n使用 get_project_memories({project_id:"${projectId}",mode:"read",memory_ids:[所需编号]}) 读取相关条目；索引总计 ${data.total} 条${data.next_offset!==null?'，可用 mode:"index",offset:'+data.next_offset+' 继续查找':''}。不要求全文重读或每轮打开本文件。\n`;
}
