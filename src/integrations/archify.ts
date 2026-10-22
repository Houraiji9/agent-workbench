import fs from 'node:fs';
import path from 'node:path';
import {managedCommand} from '../core/managed-command.ts';
import {z} from 'zod';
import {Workbench} from '../core/workbench.ts';
import {ROOT} from '../core/config.ts';
import {assert,id,now,hash,safePath,readBounded,atomicWrite} from '../core/security.ts';
import type {Row} from '../core/schema.ts';

export const archifyVersion='3.2.0';
export const archifyCommit='654da74e084e5a1faf708779c23d6172766be9c1';
export const diagramInput=z.object({project_id:z.string().min(1),candidate:z.record(z.unknown()).optional()});
const types=new Set(['tree','workflow','architecture','sequence','dataflow','lifecycle','erd','class','timeline','waterfall']);
const labels:Record<string,string>={draft:'待规划',ready:'待交付',awaiting_dispatch:'待交付',dispatched:'待接单',running:'执行中',waiting_input:'待回答',blocked:'阻塞',submitted:'待审查',in_review:'待验收',acceptance_rejected:'验收未通过',rework_linked:'已安排返工',accepted:'已验收',failed:'失败',cancelled:'已取消'};
export function projectMap(wb:Workbench,projectId:string){
  const p=wb.get('projects',projectId),all=wb.all('tasks').filter(t=>t.project_id===projectId).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)),tasks=all.slice(0,12);
  return {schema_version:1,diagram_type:'tree',meta:{title:p.name+' · 项目总览',locale:'zh-CN',output:'diagram.html',quality_profile:'showcase'},layout:{direction:'right'},
    nodes:[{id:'project',label:p.name.slice(0,22),sublabel:'已保存的项目与任务'},...tasks.map((t,i)=>({id:'task'+i,parent:'project',label:t.title.slice(0,20),sublabel:labels[t.status]||t.status}))],
    cards:[{dot:'slate',title:'如何阅读',items:[`生成时间：${now()}`,`展示最近 ${tasks.length} / ${all.length} 项任务。完整任务仍在项目列表中。`,'连线表示项目包含任务，不表示依赖或执行顺序。','这是生成时的快照，不会替代任务状态，也不会自动把任务标为完成。']},...tasks.map(t=>({dot:'cyan',title:t.title,items:[t.id,'状态：'+(labels[t.status]||t.status),'目标：'+t.goal]}))]};
}
// No file lookup, remote brand download or repository checkout is delegated to the renderer.
function checkInput(value:unknown,depth=0){
  assert(depth<30,'图解层级过深');
  if(Array.isArray(value)){assert(value.length<=200,'图解元素过多');for(const v of value)checkInput(v,depth+1)}
  else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){
    assert(!['brand','brand_mark','repository','sources','__proto__','constructor','prototype'].includes(k),'暂不支持图解外部资源或源文件引用：'+k);
    checkInput(v,depth+1);
  }
}
export class Archify {
  private busy=false;
  private closing=false;
  private command:ReturnType<typeof managedCommand>|undefined;
  async close(){this.closing=true;const command=this.command;if(command){await command.cancel();await command.result.catch(()=>{})}}

  constructor(private wb:Workbench){}
  async generate(input:unknown){
    const b=diagramInput.parse(input),p=this.wb.get('projects',b.project_id);this.wb.roots(p);
    assert(!this.closing,'后台正在退出',503);
    assert(!this.busy,'已有图解正在生成，请稍后重试',409);
    const candidate:Row=b.candidate?structuredClone(b.candidate):projectMap(this.wb,p.id);
    assert(types.has(candidate.diagram_type),'不支持的图解类型');checkInput(candidate);
    assert(Buffer.byteLength(JSON.stringify(candidate))<250000,'图解内容超过大小限制');
    candidate.meta={...candidate.meta,output:'diagram.html',locale:candidate.meta?.locale||'zh-CN',quality_profile:'showcase'};
    const did=id('D'),dir=safePath(path.join(this.wb.config.dataDir,'diagrams',did),[this.wb.config.dataDir],true);
    fs.mkdirSync(dir,{recursive:true});atomicWrite(path.join(dir,'candidate.json'),JSON.stringify(candidate,null,2));
    this.busy=true;
    try{
      this.command=managedCommand(process.execPath,[path.join(ROOT,'vendor/archify/bin/archify.mjs'),'finalize',candidate.diagram_type,'candidate.json','diagram.html','--quality','showcase','--json'],{
        cwd:dir,
        env:{...process.env,ARCHIFY_UPDATE_CHECK_DISABLED:'1'}});
      const {stdout}=await this.command.result;assert(!this.closing,'后台正在退出');
      const receipt=JSON.parse(stdout);atomicWrite(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2));
      assert(receipt.status==='pass','Archify 校验未通过');
      const bytes=readBounded(path.join(dir,'diagram.html'),20*1024*1024);
      const row={id:did,project_id:p.id,title:candidate.meta.title,type:candidate.diagram_type,created_at:now(),source:b.candidate?'codex_plan':'ledger_snapshot',version:archifyVersion,commit:archifyCommit,sha256:hash(bytes),directory:dir,status:'validated',visual_review:'not_performed',task_ids:b.candidate?[]:this.wb.all('tasks').filter(t=>t.project_id===p.id).map(t=>t.id)};
      this.wb.transaction(()=>{this.wb.put('diagrams',row,{project_id:p.id});this.wb.audit('planner','diagram_created',did,{project_id:p.id,sha256:row.sha256})});
      return row;
    }catch(error:any){
      atomicWrite(path.join(dir,'failure.txt'),String(error.stdout||error.message).slice(0,100000));
      throw new Error('图解未通过生成检查，未登记为成功。请查看该次生成目录中的 failure.txt。');
    }finally{this.busy=false;this.command=undefined}
  }
  content(did:string){const row=this.wb.get('diagrams',did);const dir=safePath(row.directory,[path.join(this.wb.config.dataDir,'diagrams')]);const bytes=readBounded(safePath(path.join(dir,'diagram.html'),[dir]),20*1024*1024);assert(hash(bytes)===row.sha256,'图解文件完整性校验失败',409);return {row,bytes}}
}
