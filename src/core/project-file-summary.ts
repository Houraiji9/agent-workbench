import type {Workbench} from './workbench.ts';
/** Metadata only: no scan, file read, deletion authority, or inferred authorship. */
export function projectFileSummary(wb:Workbench,projectId:string){
 const p=wb.get('projects',projectId),all=wb.all('project_files').filter(f=>f.project_id===projectId),rows=all.slice(0,20);
 return {indexed:all.length,returned:rows.length,has_more:all.length>rows.length,observed_at:p.file_coverage?.observed_at||null,
  files:rows.map(f=>({id:f.id,path:f.path,category:f.category,validity:f.validity,retention:f.retention,purpose:String(f.purpose||'').slice(0,160),sources:(f.sources||[]).slice(0,3)})),
  note:'仅已登记文件的简短清单，不代表全项目扫描；未知来源和待清理分类均不构成移动或删除授权。'};
}
