import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {ROOT} from '../src/core/config.ts';
import {hash} from '../src/core/security.ts';
import {stageCloseout,verifyDelivery,getCloseoutContext,applyCloseoutEvent,assertCloseoutComplete} from '../src/core/closeout.ts';
import {verifyRuntime,reportDeployment} from '../src/core/runtime-delivery.ts';
import {bindDeploymentReceipt} from '../src/core/delivery-profile.ts';
import {getDeploymentEvidenceContext} from '../src/core/deployment-evidence.ts';
import {deployedSuccessor} from '../src/core/delivery-successor.ts';

const {MANAGED}=createRequire(import.meta.url)('../desktop/update-files.cjs');
const output=path.resolve(process.env.WORKBENCH_TEST_OUTPUT_DIR||path.join(ROOT,'.test-tmp','delivery-closeout'));
function portable(root:string,version:string){
  const dirs=['src','dist','desktop','migrations','vendor','licenses','docs','scripts','node_modules','桌面版'];
  fs.mkdirSync(root,{recursive:true});
  for(const managed of MANAGED){
    if(managed==='update-manifest.json')continue;
    const file=path.join(root,managed);
    if(dirs.includes(managed)){fs.mkdirSync(file,{recursive:true});continue}
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture '+managed);
  }
  for(const relative of ['桌面版/工作台/工作台.exe','桌面版/工作台/resources/runtime/node.exe','桌面版/工作台/resources/app/main.cjs','dist/index.html']){
    const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic runtime '+relative);
  }
  fs.writeFileSync(path.join(root,'portable-release.json'),JSON.stringify({schema:1,product:'Houraiji9/agent-workbench',version}));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version}));
  const files:any[]=[];
  function collect(dir:string){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())collect(file);else{const relative=path.relative(root,file).split(path.sep).join('/');if(relative!=='update-manifest.json'){const bytes=fs.readFileSync(file);files.push({path:relative,bytes:bytes.length,sha256:hash(bytes)})}}}}
  collect(root);const manifest=JSON.stringify({schema:1,product:'Houraiji9/agent-workbench',version,files});
  fs.writeFileSync(path.join(root,'update-manifest.json'),manifest);return {manifest,sha256:hash(manifest)};
}
function fixture(){
  fs.mkdirSync(output,{recursive:true});const root=fs.mkdtempSync(path.join(output,'delivery-closeout-')),dataDir=path.join(root,'data'),runtime=path.join(root,'runtime'),source=path.join(root,'source');
  fs.mkdirSync(path.join(dataDir,'artifacts'),{recursive:true});fs.mkdirSync(source);
  const directory=path.join(root,'runs','R1');fs.mkdirSync(directory,{recursive:true});
  const old=portable(runtime,'0.4.0'),current=portable(runtime,'0.4.2'),file=path.join(source,'app.ts');fs.writeFileSync(file,'new source');
  const task:any={id:'T1',project_id:'P',runtime_root:runtime,delivery_target:'runtime',current_run_id:'R1',allowed_paths:[source],reviewer_id:'reviewer',status:'submitted',version:1,revision:1};
  const run:any={id:'R1',task_id:'T1',agent_id:'executor',status:'submitted',created_at:'2026-01-01T00:00:00Z',cwd:source,directory,seq:1,review_files:[{path:file,sha256:hash('old source')}],deployment:{verified:true,runtime_root:runtime,manifest_sha256:old.sha256,review_id:'V1',verified_at:'2026-01-01T03:00:00Z'}};
  const next:any={id:'R2',task_id:'T2',agent_id:'executor',status:'submitted',created_at:'2026-01-02T00:00:00Z',cwd:source,review_files:[{path:file,sha256:hash('new source')}],deployment:{verified:true,runtime_root:runtime,manifest_sha256:current.sha256,review_id:'V2',verified_at:'2026-01-02T03:00:00Z'}};
  const otherTask:any={id:'T2',project_id:'P',current_run_id:'R2'};
  const review:any={id:'V1',run_id:'R1',reviewer_id:'reviewer',verdict:'passed',created_at:'2026-01-01T02:00:00Z',artifact_hashes:[old.sha256]};
  const nextReview:any={id:'V2',run_id:'R2',reviewer_id:'reviewer',verdict:'passed',created_at:'2026-01-02T02:00:00Z',artifact_hashes:[current.sha256]};
  const artifacts=[old,current].map((release,index)=>{const archive_path=path.join(dataDir,'artifacts','manifest-'+index+'.json');fs.writeFileSync(archive_path,release.manifest);return {id:'A'+index,run_id:'R'+(index+1),current:true,archive_path,sha256:release.sha256}});
  const rows:any={runs:[run,next],tasks:[task,otherTask],reviews:[review,nextReview],artifacts,projects:[{id:'P',paths:[root]}]};
  const wb:any={config:{dataDir},all:(table:string)=>rows[table]||[],maybe:(table:string,id:string)=>rows[table]?.find((r:any)=>r.id===id),get:(table:string,id:string)=>{const r=rows[table]?.find((r:any)=>r.id===id);assert.ok(r);return r},roots:()=>[root],put:(table:string,row:any)=>{const index=rows[table].findIndex((r:any)=>r.id===row.id);if(index<0)rows[table].push(row);else rows[table][index]=row},audit:()=>{},db:{prepare:()=>({get:(rid:string)=>{const r=rows.reviews.map((review:any,index:number)=>({review,index})).filter(({review}:any)=>review.run_id===rid).sort((a:any,b:any)=>b.review.created_at.localeCompare(a.review.created_at)||b.index-a.index)[0]?.review;return r?{data:JSON.stringify(r)}:undefined}})}};
  return {wb,rows,task,run,next,review,nextReview,otherTask,file,root,runtime,old,current};
}
function event(f:ReturnType<typeof fixture>,event_type:string){return {event_type,seq:f.run.seq+1,event_id:'synthetic-event',data:{closeout_id:f.run.closeout.id,message:'合成夹具测试',result:'已完成本次实际交付、健康与回滚说明的逐项核对，并保留相应证据。',closeout_results:f.run.closeout.items.map((item:any)=>({item_id:item.id,outcome:'done',evidence:'仅合成测试夹具'}))}} as any}
function complete(f:ReturnType<typeof fixture>){stageCloseout(f.wb,f.task,f.run);applyCloseoutEvent(f.wb,event(f,'closeout_started'),f.task,f.run,[]);applyCloseoutEvent(f.wb,event(f,'closeout_completed'),f.task,f.run,[]);}
function reviewDatabase(f:ReturnType<typeof fixture>,reviews:any[]=f.rows.reviews){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews (run_id TEXT NOT NULL,data TEXT NOT NULL)');
  for(const r of reviews)db.prepare('INSERT INTO reviews (run_id,data) VALUES (?,?)').run(r.run_id,JSON.stringify(r));
  f.wb.db=db;return db;
}
function startRework(f:ReturnType<typeof fixture>){
  f.otherTask.current_run_id='R3';f.otherTask.status='running';
  f.rows.runs.push({id:'R3',task_id:'T2',agent_id:'executor',status:'running',created_at:'2026-01-03T00:00:00Z',cwd:f.next.cwd,review_files:[]});
}
function genericFixture(accepted=false,mode:'remote'|'local'|'other'='remote'){
  const f=fixture();
  function profile(){return {schema:1,artifacts:['source','service'],deployment:{mode,target:'合成机器人远程环境',deploy:'部署受审服务',health:'读取执行者健康记录',rollback:'恢复保留版本',verification:'executor_reported'}}}
  for(const [task,run,version] of [[f.task,f.run,'bot-1'],[f.otherTask,f.next,'bot-2']] as const){
    task.delivery_profile=profile();task.status='submitted';delete task.runtime_root;delete run.deployment;run.delivery_version=version;
    run.execution_contract={agent_id:'executor',reviewer_id:'reviewer',review_policy:{mode:'required'},delivery_profile:structuredClone(task.delivery_profile),delivery_target:'source',runtime_root:null};
    const c=getDeploymentEvidenceContext(f.wb,{run_id:run.id});
    run.deployment_evidence=bindDeploymentReceipt(c,{...c.report_template,reported_at:run.id==='R1'?'2026-01-01T03:00:00Z':'2026-01-02T03:00:00Z',deployment_evidence:'合成执行者部署记录',health_evidence:'合成执行者健康记录',rollback_evidence:'合成回滚材料'});
  }
  if(accepted){f.next.status='accepted';f.otherTask.status='accepted';}
  return f;
}

test('an accepted portable successor still supports the older closeout and acceptance',()=>{
  const f=fixture();f.next.status='accepted';f.otherTask.status='accepted';
  complete(f);assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
  assert.equal(f.run.closeout.successor_evidence.runtime[0].verification,'portable_manifest');
});

test('portable closeout and acceptance survive the deployed successor task moving to a new running rework',()=>{
  for(const status of ['submitted','accepted'])for(const moveBeforeCloseout of [false,true]){
    const f=fixture();f.next.status=status;
    const oldReview=JSON.stringify(f.review),nextReview=JSON.stringify(f.nextReview),deployment=JSON.stringify(f.next.deployment),artifacts=JSON.stringify(f.rows.artifacts);
    if(moveBeforeCloseout)startRework(f);
    complete(f);
    if(!moveBeforeCloseout)startRework(f);
    assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
    assert.equal(f.task.status,'awaiting_confirmation');assert.equal(f.otherTask.current_run_id,'R3');
    assert.equal(f.run.closeout.successor_evidence.source[0].run_id,'R2');assert.equal(f.run.closeout.successor_evidence.runtime[0].run_id,'R2');
    assert.equal(JSON.stringify(f.review),oldReview);assert.equal(JSON.stringify(f.nextReview),nextReview);
    assert.equal(JSON.stringify(f.next.deployment),deployment);assert.equal(JSON.stringify(f.rows.artifacts),artifacts);
  }
});

test('real database latest failed or revoked successor decision blocks closeout and acceptance even at the same timestamp',()=>{
  for(const revoked of [false,true])for(const accepting of [false,true]){
    const f=fixture();startRework(f);const db=reviewDatabase(f);
    try{
      if(accepting)complete(f);else stageCloseout(f.wb,f.task,f.run);
      const latest={...f.nextReview,id:'V3',verdict:revoked?'passed':'changes_requested',...(revoked?{revoked_at:'2026-01-03T00:00:00Z'}:{})};
      db.prepare('INSERT INTO reviews (run_id,data) VALUES (?,?)').run('R2',JSON.stringify(latest));
      if(accepting)assert.throws(()=>assertCloseoutComplete(f.wb,f.task,f.run),/受审文件已变化/);
      else assert.throws(()=>applyCloseoutEvent(f.wb,event(f,'closeout_started'),f.task,f.run,[]),/受审文件已变化/);
    }finally{db.close();}
  }
});

test('real database current-run latest failure or revocation never restores an older pass for closeout or deployment',()=>{
  for(const revoked of [false,true]){
    const f=fixture();const db=reviewDatabase(f);
    try{
      complete(f);
      const latest={...f.review,id:'V1-latest',verdict:revoked?'passed':'changes_requested',...(revoked?{revoked_at:'2026-01-03T00:00:00Z'}:{})};
      db.prepare('INSERT INTO reviews (run_id,data) VALUES (?,?)').run('R1',JSON.stringify(latest));
      assert.throws(()=>stageCloseout(f.wb,f.task,f.run),/独立 Review/);
      assert.throws(()=>assertCloseoutComplete(f.wb,f.task,f.run),/独立 Review/);
      f.task.status='submitted';
      assert.throws(()=>reportDeployment(f.wb,{run_id:'R1',manifest_sha256:f.old.sha256}),/独立审查/);
    }finally{db.close();}
  }
});

test('real database latest genuinely independent approval supports current deployment and historical portable closeout',()=>{
  const f=fixture();f.next.agent_id='successor-author';
  Object.assign(f.otherTask,{status:'submitted',runtime_root:f.runtime,delivery_target:'runtime'});
  const latest={...f.nextReview,id:'V3',reviewer_id:'independent-reviewer'};f.next.deployment.review_id='V3';
  const db=reviewDatabase(f,[f.review,{...f.nextReview,verdict:'changes_requested'},latest]);
  f.wb.privatePath=()=>false;f.wb.transaction=(fn:()=>unknown)=>fn();
  try{
    assert.equal(reportDeployment(f.wb,{run_id:'R2',manifest_sha256:f.current.sha256}).review_id,'V3');
    startRework(f);complete(f);assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
    assert.equal(f.run.closeout.successor_evidence.source[0].review_id,'V3');
  }finally{db.close();}
});

test('real database successor review by the older current author blocks both closeout and acceptance',()=>{
  for(const accepting of [false,true]){
    const f=fixture();f.next.agent_id='successor-author';startRework(f);const db=reviewDatabase(f);
    try{
      if(accepting)complete(f);else stageCloseout(f.wb,f.task,f.run);
      db.prepare("UPDATE reviews SET data=json_set(data,'$.reviewer_id',?) WHERE run_id=?").run(f.run.agent_id,'R2');
      if(accepting)assert.throws(()=>assertCloseoutComplete(f.wb,f.task,f.run),/受审文件已变化/);
      else assert.throws(()=>applyCloseoutEvent(f.wb,event(f,'closeout_started'),f.task,f.run,[]),/受审文件已变化/);
    }finally{db.close();}
  }
});

test('generic submitted and accepted successors support old closeout and acceptance without local runtime evidence',()=>{
  for(const mode of ['remote','local','other'] as const)for(const accepted of [false,true]){
    const f=genericFixture(accepted,mode),oldReceipt=JSON.stringify(f.run.deployment_evidence),oldReview=JSON.stringify(f.review);
    f.otherTask.delivery_profile.deployment.target='mutable task changed after frozen contract';
    f.wb.roots=()=>{throw new Error('generic successor must not access a runtime root')};
    assert.equal(deployedSuccessor(f.wb,f.task,f.run,f.current.sha256),null);
    complete(f);assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
    const evidence=getCloseoutContext(f.wb,'R1').closeout.successor_evidence.source[0];
    assert.equal(evidence.run_id,'R2');assert.equal(evidence.verification,'executor_reported');assert.equal(evidence.version,'bot-2');
    assert.match(evidence.verification_note,/未验证实际部署/);assert.equal(evidence.manifest_sha256,undefined);assert.equal(evidence.verified_at,undefined);
    assert.equal(JSON.stringify(f.run.deployment_evidence),oldReceipt);assert.equal(JSON.stringify(f.review),oldReview);
  }
});

test('real database generic deployment context uses the latest decision including timestamp ties and revocation',()=>{
  for(const revoked of [false,true]){
    const f=genericFixture();const db=reviewDatabase(f);
    try{
      assert.equal(getDeploymentEvidenceContext(f.wb,{run_id:'R1'}).review_id,'V1');
      const blocked={...f.review,id:'V1-blocked',verdict:revoked?'passed':'changes_requested',...(revoked?{revoked_at:'2026-01-03T00:00:00Z'}:{})};
      db.prepare('INSERT INTO reviews (run_id,data) VALUES (?,?)').run('R1',JSON.stringify(blocked));
      assert.throws(()=>getDeploymentEvidenceContext(f.wb,{run_id:'R1'}),/尚未通过独立审查/);
      assert.throws(()=>verifyRuntime(f.wb,f.task,f.run),/尚未通过独立审查/);
      const approved={...f.review,id:'V1-approved'};
      db.prepare('INSERT INTO reviews (run_id,data) VALUES (?,?)').run('R1',JSON.stringify(approved));
      assert.equal(getDeploymentEvidenceContext(f.wb,{run_id:'R1'}).review_id,'V1-approved');
    }finally{db.close();}
  }
});

test('remote successor tampering, missing evidence, mismatched target or unsupported status block closeout and acceptance',()=>{
  const changes=[
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.version='wrong'},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.profile_sha256='a'.repeat(64)},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.artifact_hashes=[f.old.sha256]},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.review_id='other-review'},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.reported_by='someone-else'},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.reported_at='2026-01-02T01:00:00Z'},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment_evidence.reported_at='2999-01-01T00:00:00Z'},
    (f:ReturnType<typeof fixture>)=>{delete f.next.deployment_evidence},
    (f:ReturnType<typeof fixture>)=>{f.next.execution_contract.delivery_profile.deployment.target='不同远程目标'},
    (f:ReturnType<typeof fixture>)=>{f.next.execution_contract.delivery_profile.deployment.mode='other'},
    (f:ReturnType<typeof fixture>)=>{f.next.execution_contract.delivery_profile={schema:1,artifacts:['source'],deployment:{mode:'none',verification:'none'}}},
    (f:ReturnType<typeof fixture>)=>{f.otherTask.project_id='OTHER'},
    (f:ReturnType<typeof fixture>)=>{startRework(f)},
    (f:ReturnType<typeof fixture>)=>{f.next.cwd=f.runtime},
    (f:ReturnType<typeof fixture>)=>{f.nextReview.revoked_at='2026-01-03T00:00:00Z'},
    (f:ReturnType<typeof fixture>)=>{f.nextReview.reviewer_id='executor'},
    (f:ReturnType<typeof fixture>)=>{f.rows.reviews=f.rows.reviews.filter((r:any)=>r.id!=='V2')},
    (f:ReturnType<typeof fixture>)=>{fs.writeFileSync(f.rows.artifacts.find((a:any)=>a.run_id==='R2').archive_path,'tampered')},
    (f:ReturnType<typeof fixture>)=>{f.next.status='failed'},
    (f:ReturnType<typeof fixture>)=>{f.next.status='running'},
    (f:ReturnType<typeof fixture>)=>{f.next.status='cancelled'},
  ];
  for(const change of changes){
    const closing=genericFixture();stageCloseout(closing.wb,closing.task,closing.run);closing.task.status='closing';change(closing);
    assert.throws(()=>applyCloseoutEvent(closing.wb,event(closing,'closeout_completed'),closing.task,closing.run,[]),/受审文件已变化/);
    const accepting=genericFixture(true);complete(accepting);change(accepting);assert.throws(()=>assertCloseoutComplete(accepting.wb,accepting.task,accepting.run),/受审文件已变化/);
  }
});

test('legacy digest is unchanged; successor release permits closeout and acceptance without rewriting prior review/deployment',()=>{
  const f=fixture(),oldReview=JSON.stringify(f.review),oldDeployment=JSON.stringify(f.run.deployment);
  assert.throws(()=>verifyDelivery(f.wb,f.task,f.run),/受审文件已变化/);
  assert.throws(()=>verifyRuntime(f.wb,f.task,f.run),/清单已改变/);
  complete(f);
  const expected=hash(JSON.stringify({run:'R1',review:'V1',files:[['A0',f.old.sha256]],review_files:f.run.review_files}));
  assert.equal(f.run.closeout.digest,expected);assert.equal(f.task.status,'awaiting_confirmation');
  assert.equal(f.run.closeout.successor_evidence.source[0].run_id,'R2');assert.equal(f.run.closeout.successor_evidence.runtime[0].run_id,'R2');
  assert.equal(getCloseoutContext(f.wb,'R1').closeout.successor_evidence.runtime[0].review_id,'V2');
  assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
  assert.equal(JSON.stringify(f.review),oldReview);assert.equal(JSON.stringify(f.run.deployment),oldDeployment);
  assert.throws(()=>verifyDelivery(f.wb,f.task,f.run),/受审文件已变化/);
});

test('historical portable closeout and acceptance reject unknown drift, invalid reviews, archives or deployment targets',()=>{
  const changes=[
    (f:ReturnType<typeof fixture>)=>fs.writeFileSync(f.file,'unknown change'),
    (f:ReturnType<typeof fixture>)=>{f.otherTask.project_id='OTHER'},
    (f:ReturnType<typeof fixture>)=>{f.next.cwd=f.runtime},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment.verified=false},
    (f:ReturnType<typeof fixture>)=>{f.next.deployment.runtime_root=f.root},
    (f:ReturnType<typeof fixture>)=>{f.nextReview.verdict='changes_requested'},
    (f:ReturnType<typeof fixture>)=>{f.nextReview.created_at='invalid'},
    (f:ReturnType<typeof fixture>)=>{f.nextReview.revoked_at='2026-01-03T00:00:00Z'},
    (f:ReturnType<typeof fixture>)=>{f.rows.reviews=f.rows.reviews.filter((r:any)=>r.id!=='V2')},
    (f:ReturnType<typeof fixture>)=>{fs.writeFileSync(f.rows.artifacts.find((a:any)=>a.run_id==='R2').archive_path,'tampered')},
    (f:ReturnType<typeof fixture>)=>{f.rows.artifacts.find((a:any)=>a.run_id==='R2').current=false},
    (f:ReturnType<typeof fixture>)=>{f.next.status='cancelled'},
  ];
  for(const change of changes){
    const closing=fixture();startRework(closing);stageCloseout(closing.wb,closing.task,closing.run);closing.task.status='closing';change(closing);
    assert.throws(()=>applyCloseoutEvent(closing.wb,event(closing,'closeout_completed'),closing.task,closing.run,[]));assert.notEqual(closing.task.status,'awaiting_confirmation');
    const accepted=fixture();complete(accepted);startRework(accepted);change(accepted);assert.throws(()=>assertCloseoutComplete(accepted.wb,accepted.task,accepted.run));
  }
});

test('approved successor manifest never replaces verification of real runtime bytes or complete managed tree',()=>{
  for(const modify of [(f:ReturnType<typeof fixture>)=>fs.writeFileSync(path.join(f.runtime,'dist/index.html'),'tampered'),(f:ReturnType<typeof fixture>)=>fs.writeFileSync(path.join(f.runtime,'src/unlisted.ts'),'unlisted')]){
    const f=fixture();complete(f);startRework(f);modify(f);assert.throws(()=>assertCloseoutComplete(f.wb,f.task,f.run),/文件不匹配|清单外/);
  }
});

test('source/none settings cannot downgrade an existing portable deployment receipt',()=>{
  const f=fixture();f.task.delivery_target='source';fs.writeFileSync(path.join(f.runtime,'dist/index.html'),'tampered');
  assert.throws(()=>verifyRuntime(f.wb,f.task,f.run,{allowSuccessor:true}),/文件不匹配/);
});

test('new profile and delivery version participate in closeout identity while legacy project defaults do not',()=>{
  const f=fixture();f.task.delivery_profile={schema:1,artifacts:['source','software'],deployment:{mode:'local',target:f.runtime,deploy:'部署受审便携文件',health:'核验便携清单',rollback:'使用旧便携备份',verification:'portable_manifest'}};f.run.delivery_version='0.4.0';
  stageCloseout(f.wb,f.task,f.run);assert.doesNotThrow(()=>getCloseoutContext(f.wb,'R1'));f.run.delivery_version='different';assert.throws(()=>getCloseoutContext(f.wb,'R1'),/已失效/);
  f.run.delivery_version='0.4.0';f.task.delivery_profile.deployment.health='修改后的检查';assert.throws(()=>getCloseoutContext(f.wb,'R1'),/已失效/);
  const legacy=fixture();stageCloseout(legacy.wb,legacy.task,legacy.run);legacy.rows.projects[0].delivery_profile={schema:1,artifacts:['service'],deployment:{mode:'remote',target:'server',deploy:'deploy',health:'health',rollback:'rollback',verification:'executor_reported'}};
  assert.doesNotThrow(()=>getCloseoutContext(legacy.wb,'R1'));
});

test('remote closeout requires a version-bound receipt and rechecks it on acceptance without a runtime directory',()=>{
  const f=fixture();f.task.delivery_profile={schema:1,artifacts:['source','service'],deployment:{mode:'remote',target:'合成机器人环境',deploy:'部署受审服务',health:'查询合成健康结果',rollback:'恢复上一版本',verification:'executor_reported'}};
  delete f.task.runtime_root;delete f.run.deployment;f.run.delivery_version='bot-2';fs.writeFileSync(f.file,'old source');
  f.run.execution_contract={agent_id:'executor',reviewer_id:'reviewer',review_policy:{mode:'required'},delivery_profile:structuredClone(f.task.delivery_profile),delivery_target:'source',runtime_root:null};
  stageCloseout(f.wb,f.task,f.run);applyCloseoutEvent(f.wb,event(f,'closeout_started'),f.task,f.run,[]);
  assert.throws(()=>applyCloseoutEvent(f.wb,event(f,'closeout_completed'),f.task,f.run,[]),/尚未提交/);
  const c=getDeploymentEvidenceContext(f.wb,{run_id:'R1'});
  f.run.deployment_evidence=bindDeploymentReceipt(c,{...c.report_template,deployment_evidence:'仅合成部署证据',health_evidence:'仅合成健康证据',rollback_evidence:'仅合成回滚证据'});
  applyCloseoutEvent(f.wb,event(f,'closeout_completed'),f.task,f.run,[]);assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
  f.task.delivery_profile={schema:1,artifacts:['document'],deployment:{mode:'none',verification:'none'}};
  assert.doesNotThrow(()=>getCloseoutContext(f.wb,'R1'));assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.task,f.run));
  f.run.deployment_evidence.version='bot-1';assert.throws(()=>assertCloseoutComplete(f.wb,f.task,f.run),/版本/);
});
import {reviewDeliveryDigest} from '../src/core/latest-review.ts';
import {verifyDeploymentEvidence} from '../src/core/deployment-evidence.ts';
test('late report preserves generic deployment receipt bound to explicit zero-report continue decision',()=>{const f=genericFixture();f.rows.reviews=f.rows.reviews.filter((v:any)=>v.run_id!==f.run.id);f.run.review_decision={id:'RD-synthetic-decision',decision:'continue',binding_review_id:null,review_digest:reviewDeliveryDigest(f.wb,f.run.id),artifact_hashes:[f.old.sha256]};const initial=getDeploymentEvidenceContext(f.wb,{run_id:f.run.id});assert.equal(initial.review_id,null);f.run.deployment_evidence=bindDeploymentReceipt(initial,{...initial.report_template,deployment_evidence:'合成部署证据',health_evidence:'合成健康证据',rollback_evidence:'合成回滚证据'});f.rows.reviews.push({...f.review,id:'V-late-adverse',verdict:'changes_requested',created_at:'2026-01-04T00:00:00Z'});assert.equal(getDeploymentEvidenceContext(f.wb,{run_id:f.run.id}).review_id,null);assert.doesNotThrow(()=>verifyDeploymentEvidence(f.wb,f.task,f.run));});
