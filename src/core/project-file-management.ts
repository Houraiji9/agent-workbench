import {z} from 'zod';
import {DomainError} from './security.ts';
import {assertFileAgent,classifyProjectFileForAgent,projectFileMetadataRows,projectFileRevision,scanProjectFilesForAgent,type AgentFileAction,type ProjectFilesWorkbench} from './project-files.ts';

const key=z.string().trim().min(1).max(200),category=z.enum(['source','test','process','backup','deliverable','unknown']);
export const getProjectFilesInput=z.object({project_id:key,refresh:z.boolean().default(false),scan_paths:z.array(z.string().trim().min(1).max(2000)).min(1).max(10).optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(30),query:z.string().trim().max(200).default(''),category:category.optional()}).strict();
export const classifyProjectFilesInput=z.object({project_id:key,items:z.array(z.object({file_id:key,expected_revision:z.number().int().positive().optional(),category,validity:z.enum(['current','historical','invalid','unknown']),retention:z.enum(['keep','cleanup_candidate']),purpose:z.string().trim().min(1).max(2000),reason:z.string().trim().min(1).max(2000)}).strict()).min(1).max(100)}).strict().superRefine((v,ctx)=>{if(new Set(v.items.map(i=>i.file_id)).size!==v.items.length)ctx.addIssue({code:z.ZodIssueCode.custom,path:['items'],message:'同一批次不得重复分类同一文件'});});

/** Bounded metadata only. Central session-management must authorize project scope first. */
export function getProjectFiles(wb:ProjectFilesWorkbench,input:unknown,actor:AgentFileAction){
 const v=getProjectFilesInput.parse(input);assertFileAgent(wb,v.project_id,actor);
 let coverage=wb.get('projects',v.project_id).file_coverage||null;
 if(v.refresh){const scan=scanProjectFilesForAgent(wb,v.project_id,actor,{},v.scan_paths);coverage=scan.coverage;const project=wb.get('projects',v.project_id);wb.put('projects',{...project,file_coverage:coverage});}
 const needle=v.query.toLocaleLowerCase(),all=projectFileMetadataRows(wb,v.project_id).filter(row=>(!v.category||row.category===v.category)&&(!needle||[row.path,row.purpose,row.classification_reason].join(' ').toLocaleLowerCase().includes(needle))).sort((a,b)=>a.path.localeCompare(b.path)||a.id.localeCompare(b.id));
 const files=all.slice(v.offset,v.offset+v.limit).map(row=>({file_id:row.id,project_id:row.project_id,path:row.path,category:row.category,validity:row.validity,retention:row.retention,purpose:String(row.purpose||'').slice(0,2000),reason:String(row.classification_reason||row.classification?.reason||'未记录分类依据').slice(0,2000),classification_source:row.classification_source,classification:row.classification||null,revision:projectFileRevision(row),classification_stale:!!row.classification_stale,snapshot_warning:row.snapshot_warning||null,bytes:row.bytes,mtime:row.mtime,observed_at:row.observed_at,sources:(row.sources||[]).slice(0,5),source_count:(row.sources||[]).length}));
 return {project_id:v.project_id,files,total:all.length,offset:v.offset,next_offset:v.offset+files.length<all.length?v.offset+files.length:null,coverage,metadata_only:true,guidance:'仅授权项目文件元信息，不读取文件正文。规则为可解释建议；用户分类优先，Agent 可按本轮用途分类。类别、效力和保留策略独立；待清理不构成移动或删除授权。文件快照变化时重新查询 revision 后再分类。'};
}
/** Every input item gets an explicit outcome; no silent partial batch success. */
export function classifyProjectFiles(wb:ProjectFilesWorkbench,input:unknown,actor:AgentFileAction){
 const v=classifyProjectFilesInput.parse(input);assertFileAgent(wb,v.project_id,actor);
 const results=v.items.map(item=>{
  try{const {file_id,...changes}=item;return classifyProjectFileForAgent(wb,v.project_id,file_id,actor,changes);}
  catch(error){return {file_id:item.file_id,status:error instanceof DomainError&&error.status===409?'conflict' as const:'failed' as const,error:error instanceof Error?error.message:'分类保存失败',http_status:error instanceof DomainError?error.status:400};}
 });
 return {project_id:v.project_id,results,applied:results.filter(r=>r.status==='applied').length,skipped_user:results.filter(r=>r.status==='skipped_user').length,conflicts:results.filter(r=>r.status==='conflict').length,failed:results.filter(r=>r.status==='failed').length,metadata_only:true,file_operations_performed:false};
}
