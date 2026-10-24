import {relationshipGraph,layoutRelationships,taskAction,actionGroups} from '../shared/workflow-view.ts';
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
  const p=wb.get('projects',projectId),tasks=wb.executionTasks().filter(t=>t.project_id===projectId),graph=relationshipGraph(tasks,[],[],[],projectId),layout=layoutRelationships(graph.nodes,graph.edges);
  assert(graph.nodes.length<=180,'保存快照最多支持180个节点；请使用项目交互关系图查看完整结构');
  const nodes=layout.nodes.length?layout.nodes:[{id:'project',label:p.name,status:'ready',x:24,y:24}];
  assert(nodes.every(n=>Math.round((n.x-24)/310)<=5),'静态快照超过六列，请使用交互关系图查看完整结构；未截断任务');
  const laneIds=[...new Set(nodes.map(n=>'lane'+Math.round((n.y-24)/110)))];
  return {schema_version:2,diagram_type:'workflow',meta:{title:p.name+' · 任务依赖快照',locale:'zh-CN',output:'diagram.html',quality_profile:'showcase'},
    lanes:laneIds.map((id,i)=>({id,label:'任务分支 '+(i+1)})),nodes:nodes.map(n=>({id:n.id,lane:'lane'+Math.round((n.y-24)/110),col:Math.round((n.x-24)/310),type:'backend',width:370,label:n.label.length>24?n.label.slice(0,23)+'…':n.label,sublabel:actionGroups[taskAction({status:n.status}).group]})),
    edges:graph.edges.map(e=>({from:e.from,to:e.to,label:e.label,...(e.kind==='rework'?{variant:'dashed',role:'return'}:{})})),
    cards:[{dot:'slate',title:'覆盖范围',items:[`共 ${tasks.length} 项任务、${graph.edges.length} 条真实关系。`,'连线只来自已登记的依赖与返工关系，不根据时间或标题猜测。','静态快照；当前状态请查看上方交互关系图。']},...tasks.map(t=>({dot:'cyan',title:t.title,items:[t.id,'当前动作：'+actionGroups[taskAction(t).group]]}))]};
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
