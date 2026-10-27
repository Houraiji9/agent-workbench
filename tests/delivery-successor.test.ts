import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {hash} from '../src/core/security.ts';import {reviewedSourceSuccessor,deployedSuccessor} from '../src/core/delivery-successor.ts';
import {DatabaseSync} from 'node:sqlite';
function fixture(){
 const base=process.env.WORKBENCH_TEST_OUTPUT_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.test-tmp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'successor-')),dataDir=path.join(root,'data'),runtime=path.join(root,'runtime'),source=path.join(root,'source');
 fs.mkdirSync(path.join(dataDir,'artifacts'),{recursive:true});fs.mkdirSync(runtime);fs.mkdirSync(source);
 const manifest='{"version":"2.0.0"}',manifestHash=hash(manifest),archive=path.join(dataDir,'artifacts','manifest.json');fs.writeFileSync(archive,manifest);fs.writeFileSync(path.join(runtime,'update-manifest.json'),manifest);
 const currentHash=hash('new source'),file=path.join(source,'app.ts');fs.writeFileSync(file,'new source');
 const task={id:'T1',project_id:'P',runtime_root:runtime,delivery_target:'runtime'},run={id:'R1',agent_id:'current-author',created_at:'2026-01-01T00:00:00Z',cwd:source};
 const next={id:'R2',task_id:'T2',agent_id:'executor',status:'submitted',created_at:'2026-01-02T00:00:00Z',cwd:source,review_files:[{path:file,sha256:currentHash}],deployment:{verified:true,review_id:'V2',runtime_root:runtime,manifest_sha256:manifestHash,verified_at:'2026-01-02T03:00:00Z'}};
 const review={id:'V2',run_id:'R2',reviewer_id:'other',verdict:'passed',created_at:'2026-01-02T02:00:00Z',artifact_hashes:[manifestHash]},otherTask={id:'T2',project_id:'P',current_run_id:'R2'};
 const rows:any={runs:[run,next],tasks:[task,otherTask],projects:[{id:'P',paths:[root]}],reviews:[review],artifacts:[{run_id:'R2',current:true,archive_path:archive,sha256:manifestHash}]};
 const wb:any={config:{dataDir},all:(table:string)=>rows[table]||[],runRows:(table:string,rid:string)=>(rows[table]||[]).filter((row:any)=>row.run_id===rid),maybe:(table:string,id:string)=>rows[table]?.find((r:any)=>r.id===id),get:(table:string,id:string)=>rows[table]?.find((r:any)=>r.id===id),roots:()=>[root],db:{prepare:()=>({get:(rid:string)=>{const r=rows.reviews.map((review:any,index:number)=>({review,index})).filter(({review}:any)=>review.run_id===rid).sort((a:any,b:any)=>b.review.created_at.localeCompare(a.review.created_at)||b.index-a.index)[0]?.review;return r?{data:JSON.stringify(r)}:undefined}})}};
 return {wb,task,run,next,review,otherTask,rows,manifestHash,currentHash,file,runtime,archive};
}

function reviewDatabase(f:ReturnType<typeof fixture>,reviews:any[]){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews (run_id TEXT NOT NULL,data TEXT NOT NULL)');
 const insert=db.prepare('INSERT INTO reviews (run_id,data) VALUES (?,?)');for(const r of reviews)insert.run(r.run_id,JSON.stringify(r));f.wb.db=db;return db;
}

test('real database latest row wins timestamp ties and a revoked latest decision never restores an earlier pass',()=>{
 for(const historical of [false,true])for(const change of ['failed','revoked-pass','revoked-failed','later-revoked'] as const){
  const f=fixture();if(historical)f.otherTask.current_run_id='R3';
  const latest={...f.review,id:'V3',verdict:change==='failed'||change==='revoked-failed'?'changes_requested':'passed',...(change!=='failed'?{revoked_at:'2026-01-03T00:00:00Z'}:{}),...(change==='later-revoked'?{created_at:'2026-01-02T02:30:00Z'}:{})};
  const db=reviewDatabase(f,[f.review,latest]);
  try{assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash),null);assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,f.currentHash),null);}finally{db.close();}
 }
});
test('real database latest independent pass must match the deployment and be independent of both authors',()=>{
 for(const reviewer of ['current-author','executor','independent-reviewer']){
  const f=fixture();f.otherTask.current_run_id='R3';
  const latest={...f.review,id:'V3',reviewer_id:reviewer};f.next.deployment.review_id='V3';
  const db=reviewDatabase(f,[{...f.review,verdict:'changes_requested'},latest]);
  try{assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash)?.evidence.review_id,reviewer==='independent-reviewer'?'V3':undefined);assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,f.currentHash)?.review_id,reviewer==='independent-reviewer'?'V3':undefined);}finally{db.close();}
 }
});
test('same-project reviewed and deployed successor explains changed source without altering old records',()=>{const f=fixture(),before=JSON.stringify(f.run);assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,f.currentHash)?.run_id,'R2');assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash)?.evidence.review_id,'V2');assert.equal(JSON.stringify(f.run),before);});
test('unknown source change or manifest cannot inherit a passed review',()=>{const f=fixture();assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,hash('unreviewed')),null);assert.equal(deployedSuccessor(f.wb,f.task,f.run,hash('unknown manifest')),null);});
test('a new task run does not invalidate the independently reviewed portable release still installed',()=>{
 for(const status of ['submitted','accepted']){
  const f=fixture(),before=JSON.stringify({review:f.review,deployment:f.next.deployment,artifacts:f.rows.artifacts});
  f.next.status=status;f.otherTask.current_run_id='R3';f.rows.runs.push({id:'R3',task_id:'T2',status:'running',created_at:'2026-01-03T00:00:00Z',cwd:f.next.cwd});
  assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,f.currentHash)?.run_id,'R2');
  assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash)?.evidence.review_id,'V2');
  assert.equal(JSON.stringify({review:f.review,deployment:f.next.deployment,artifacts:f.rows.artifacts}),before);
 }
});
test('cross-project, different checkout and older run never qualify',()=>{for(const change of [(f:any)=>f.otherTask.project_id='OTHER',(f:any)=>f.next.cwd=f.runtime,(f:any)=>f.next.created_at='2025-01-01T00:00:00Z']){const f=fixture();change(f);assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,f.currentHash),null);}});
test('historical portable candidates retain all review, archive, deployment and current manifest checks',()=>{
 const changes=[
  (f:any)=>f.rows.reviews=[],(f:any)=>f.review.revoked_at='2026-01-03T00:00:00Z',(f:any)=>f.review.verdict='changes_requested',
  (f:any)=>f.review.reviewer_id='executor',(f:any)=>f.next.deployment.review_id='OTHER',(f:any)=>f.next.deployment.verified=false,
  (f:any)=>f.next.deployment.verified_at='2026-01-01T00:00:00Z',(f:any)=>f.next.deployment.verified_at='2999-01-01T00:00:00Z',
  (f:any)=>f.next.deployment.runtime_root=f.next.cwd,(f:any)=>f.rows.artifacts[0].current=false,
  (f:any)=>fs.writeFileSync(f.archive,'changed'),(f:any)=>fs.writeFileSync(path.join(f.runtime,'update-manifest.json'),'changed'),
  (f:any)=>f.review.artifact_hashes=[hash('other')],(f:any)=>f.next.status='running',(f:any)=>f.next.status='cancelled',
  (f:any)=>f.otherTask.project_id='OTHER',(f:any)=>f.next.cwd=f.runtime,
 ];
 for(const change of changes){const f=fixture();f.otherTask.current_run_id='R3';change(f);assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,f.currentHash),null);assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash),null);}
 const f=fixture();f.otherTask.current_run_id='R3';assert.equal(reviewedSourceSuccessor(f.wb,f.task,f.run,f.file,hash('unreviewed')),null);
});
test('missing, revoked, failed or self review and mismatched deployment review are rejected',()=>{for(const change of [(f:any)=>f.rows.reviews=[],(f:any)=>f.review.revoked_at='2026-01-03T00:00:00Z',(f:any)=>f.review.verdict='changes_requested',(f:any)=>f.review.reviewer_id='executor',(f:any)=>f.next.deployment.review_id='OTHER']){const f=fixture();change(f);assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash),null);}});
test('missing deployment, old verification and different runtime root are rejected',()=>{for(const change of [(f:any)=>f.next.deployment.verified=false,(f:any)=>f.next.deployment.verified_at='2026-01-01T00:00:00Z',(f:any)=>f.next.deployment.runtime_root=f.next.cwd]){const f=fixture();change(f);assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash),null);}});
test('tampered archive, changed live manifest and unreviewed artifact sets never qualify',()=>{for(const change of [(f:any)=>fs.writeFileSync(f.archive,'changed'),(f:any)=>fs.writeFileSync(path.join(f.runtime,'update-manifest.json'),'changed'),(f:any)=>f.review.artifact_hashes=[hash('other')],(f:any)=>f.rows.artifacts=[]]){const f=fixture();change(f);assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.manifestHash),null);}});
