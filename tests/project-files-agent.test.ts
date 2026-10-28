import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inside,protectedName,safePath} from '../src/core/security.ts';
import {scanProjectFiles,saveProjectFile,projectFilePath,moveProjectFiles,restoreProjectFile,type ProjectFilesWorkbench,type ProjectFile,type AgentFileAction} from '../src/core/project-files.ts';
import {getProjectFiles,getProjectFilesInput,classifyProjectFiles,classifyProjectFilesInput} from '../src/core/project-file-management.ts';

const testRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.test-tmp/project-files-agent');
fs.mkdirSync(testRoot,{recursive:true});process.env.TEMP=testRoot;process.env.TMP=testRoot;
const user={actor:'user' as const};
function env(){
 const home=path.join(testRoot,crypto.randomUUID()),root=path.join(home,'project'),data=path.join(home,'internal');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(data);
 const tables=new Map<string,Map<string,any>>();for(const table of ['projects','project_files','file_moves','tasks','runs','artifacts','reviews','review_assignments'])tables.set(table,new Map());
 const wb:ProjectFilesWorkbench={config:{authorizedRoots:[home],dataDir:data},all(table){assert(tables.has(table));return [...tables.get(table)!.values()].map(v=>structuredClone(v));},get(table,id){const row=tables.get(table)?.get(id);assert(row,'record missing');return structuredClone(row);},put(table,row,refs){assert(tables.has(table));if(table==='project_files')assert.equal(refs?.project_id,row.project_id);tables.get(table)!.set(row.id,structuredClone(row));},roots(project){return project.paths.map((p:string)=>safePath(p,[home]));},privatePath(file){return inside(data,file)||protectedName(file);}};
 wb.put('projects',{id:'p',paths:[root]});wb.put('tasks',{id:'t',project_id:'p'});wb.put('runs',{id:'r',task_id:'t',agent_id:'codex'});
 const actor:AgentFileAction={actor:'agent',actor_id:'runner:r',run_id:'r',task_id:'t'};
 const write=(name:string,content='SYNTHETIC_FILE_CONTENT')=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file;};
 const scan=()=>scanProjectFiles(wb,'p',user,{maxMilliseconds:5000});
 const classify=(row:ProjectFile,change:any={})=>classifyProjectFiles(wb,{project_id:'p',items:[{file_id:row.id,expected_revision:row.revision,category:'process',validity:'current',retention:'keep',purpose:'当前会话生成的过程记录',reason:'当前执行者按本轮用途登记',...change}]},actor);
 return {wb,root,home,data,tables,actor,write,scan,classify};
}

test('按路径提供source/test/process/backup规则与未知原因，效力保留独立且不伪造作者',()=>{
 const e=env();for(const name of ['src/app.ts','tests/example.ts','docs/handoff/session/report.json','backup/session.tmp','README.md','strange.bin'])e.write(name);
 const files=e.scan().files;const find=(name:string)=>files.find(row=>row.path===path.join(e.root,name))!;
 for(const [name,category] of [['src/app.ts','source'],['tests/example.ts','test'],['docs/handoff/session/report.json','process'],['backup/session.tmp','backup'],['README.md','source'],['strange.bin','unknown']]){
  const row=find(name);assert.equal(row.category,category,name);assert.equal(row.validity,'unknown');assert.equal(row.retention,'keep');assert(row.classification_reason);assert.equal(row.classification!.actor,'rule');assert.equal(row.classification!.actor_id,null);assert.deepEqual(row.sources,[]);
 }
 assert.match(find('strange.bin').classification_reason!,/没有匹配/);
});

test('Agent分类记录身份Task Run用途依据时间版本；重扫保留，用户可覆盖但Agent不能覆盖用户',()=>{
 const e=env();e.write('notes.tmp');const row=e.scan().files[0],result=e.classify(row);assert.equal(result.applied,1);
 const saved=e.wb.get('project_files',row.id);assert.equal(saved.classification_source,'agent');assert.equal(saved.classification.actor_id,'runner:r');assert.equal(saved.classification.run_id,'r');assert.equal(saved.classification.task_id,'t');assert(saved.classification.recorded_at);assert.equal(saved.revision,2);assert.equal(saved.classification_history[0].classification_source,'unknown');
 const refresh=e.scan().files.find(r=>r.id===row.id)!;assert.equal(refresh.category,'process');assert.equal(refresh.validity,'current');assert.equal(refresh.classification_source,'agent');assert.deepEqual(refresh.classification,saved.classification);assert.equal(refresh.revision,2);
 const manual=saveProjectFile(e.wb,'p',row.id,user,{category:'backup',validity:'historical',retention:'keep',purpose:'用户明确保留的版本'});
 assert.equal(manual.classification!.actor,'user');assert.equal(manual.revision,3);const skipped=e.classify(manual);assert.equal(skipped.skipped_user,1);assert.equal(skipped.applied,0);assert.deepEqual(e.wb.get('project_files',row.id),manual);
 assert.equal(e.scan().files[0].classification_source,'user');assert.equal(e.scan().files[0].category,'backup');
});

test('有界元信息查询分页筛选，刷新不读取文件正文，拒绝凭据及伪造来源输入',()=>{
 const e=env();for(let i=0;i<5;i++)e.write('src/file-'+i+'.ts');e.write('.env','PRIVATE_SECRET');e.write('data/private.txt');
 const read=fs.readFileSync;Object.assign(fs,{readFileSync:()=>{throw Error('must never read content');}});
 try{
  const page=getProjectFiles(e.wb,{project_id:'p',refresh:true,category:'source',limit:2},e.actor);assert.equal(page.files.length,2);assert.equal(page.total,5);assert.equal(page.next_offset,2);assert.equal(page.metadata_only,true);assert(!JSON.stringify(page.files).includes('SYNTHETIC_FILE_CONTENT'));assert(!JSON.stringify(page.files).includes('PRIVATE_SECRET'));
  const next=getProjectFiles(e.wb,{project_id:'p',category:'source',offset:2,limit:2},e.actor);assert.notEqual(next.files[0].file_id,page.files[0].file_id);
  const query=getProjectFiles(e.wb,{project_id:'p',query:'file-4'},e.actor);assert.equal(query.total,1);
 }finally{Object.assign(fs,{readFileSync:read});}
 assert.throws(()=>getProjectFilesInput.parse({project_id:'p',limit:101}));assert.throws(()=>getProjectFilesInput.parse({project_id:'p',actor:'user'}));
 assert.throws(()=>classifyProjectFilesInput.parse({project_id:'p',items:[{file_id:'f',category:'source',validity:'current',retention:'keep',purpose:'内容',reason:'依据',actor:'user',run_id:'forged'}]}));
});

test('批量逐项回执含应用、人工保护、跨项目失败、版本冲突，不暗示整批成功',()=>{
 const e=env();for(const name of ['one.tmp','manual.tmp','conflict.tmp'])e.write(name);const rows=e.scan().files;
 const one=rows.find(r=>r.path.endsWith('one.tmp'))!,manual=rows.find(r=>r.path.endsWith('manual.tmp'))!,conflict=rows.find(r=>r.path.endsWith('conflict.tmp'))!;
 saveProjectFile(e.wb,'p',manual.id,user,{category:'source',validity:'current',retention:'keep',purpose:'用户说明'});
 e.wb.put('project_files',{...one,id:'foreign',project_id:'other'},{project_id:'other'});
 const changes=(file_id:string,expected_revision:number)=>({file_id,expected_revision,category:'test',validity:'unknown',retention:'keep',purpose:'合成批量测试',reason:'合成依据'});
 const result=classifyProjectFiles(e.wb,{project_id:'p',items:[changes(one.id,1),changes(manual.id,1),changes(conflict.id,99),changes('foreign',1)]},e.actor);
 assert.equal(result.applied,1);assert.equal(result.skipped_user,1);assert.equal(result.conflicts,1);assert.equal(result.failed,1);assert.deepEqual(result.results.map(r=>r.status),['applied','skipped_user','conflict','failed']);assert.equal(result.file_operations_performed,false);
 assert.equal(e.wb.get('project_files','foreign').category,'unknown');assert.equal(fs.readFileSync(one.path,'utf8'),'SYNTHETIC_FILE_CONTENT');
 assert.throws(()=>classifyProjectFilesInput.parse({project_id:'p',items:[changes(one.id,2),changes(one.id,2)]}),/重复/);
});

test('快照变化先拒绝，刷新保留Agent分类并提示核对，必须携带当前revision才能重新分类',()=>{
 const e=env();const file=e.write('scratch.tmp'),original=e.scan().files[0];e.classify(original);const saved=e.wb.get('project_files',original.id) as ProjectFile;
 fs.writeFileSync(file,'CHANGED_SIZE_AND_METADATA');const blocked=e.classify(saved);assert.equal(blocked.conflicts,1);assert.match((blocked.results[0] as any).error,/快照/);
 const refreshed=e.scan().files[0];assert.equal(refreshed.category,'process');assert.equal(refreshed.classification_source,'agent');assert.equal(refreshed.classification_stale,true);assert.match(refreshed.snapshot_warning!,/变化/);assert.equal(refreshed.revision,3);
 const without=e.classify(refreshed,{expected_revision:undefined});assert.equal(without.conflicts,1);assert.match((without.results[0] as any).error,/revision/);
 const confirmed=e.classify(refreshed,{purpose:'已核对变化后的过程文件'});assert.equal(confirmed.applied,1);assert.equal(e.wb.get('project_files',original.id).classification_stale,false);
});

test('partial scan不把未观察文件判无效；成果登记仍保留单独来源并优先于路径规则',()=>{
 const e=env();for(let i=0;i<5;i++)e.write('f-'+i+'.tmp');const deliver=e.write('src/delivered.ts');e.wb.put('artifacts',{id:'a',run_id:'r',original_path:deliver,current:true,sha256:'synthetic-only'});
 const before=e.scan().files,artifact=before.find(row=>row.path===deliver)!;assert.equal(artifact.category,'deliverable');assert.equal(artifact.classification_source,'artifact');assert.equal(artifact.classification!.actor,'artifact');assert.equal(artifact.validity,'current');
 const partial=scanProjectFiles(e.wb,'p',user,{maxFiles:1,maxMilliseconds:5000});assert.equal(partial.coverage.complete,false);assert.equal(e.wb.all('project_files').length,before.length);assert.equal(e.wb.all('project_files').filter(row=>row.validity==='invalid').length,0);
});

test('可信身份的项目Task Run检查；classify权限不扩大原扫描打开移动恢复user-only保护',()=>{
 const e=env();e.write('notes.tmp');const row=e.scan().files[0];
 e.wb.put('projects',{id:'other',paths:[e.root]});e.wb.put('tasks',{id:'other-task',project_id:'other'});e.wb.put('runs',{id:'other-run',task_id:'other-task'});
 assert.throws(()=>getProjectFiles(e.wb,{project_id:'p'},{actor:'agent',actor_id:'runner:other',run_id:'other-run'}),/不属于/);
 assert.throws(()=>getProjectFiles(e.wb,{project_id:'p'},{...e.actor,task_id:'other-task'}),/不属于|不匹配/);
 assert.throws(()=>getProjectFiles(e.wb,{project_id:'p'},{actor:'user',actor_id:'forged'} as any),/真实 Agent/);
 assert.equal(getProjectFiles(e.wb,{project_id:'other'},{...e.actor,project_ids:['p','other']}).project_id,'other');
 assert.throws(()=>getProjectFilesInput.parse({project_id:'other',project_ids:['other']}));
 e.classify(row,{retention:'cleanup_candidate',validity:'invalid'});
 for(const action of [()=>scanProjectFiles(e.wb,'p',e.actor as any),()=>saveProjectFile(e.wb,'p',row.id,e.actor as any,{} as any),()=>projectFilePath(e.wb,'p',row.id,e.actor as any),()=>moveProjectFiles(e.wb,'p',e.actor as any,[],{}),()=>restoreProjectFile(e.wb,'p','missing',e.actor as any,{})])assert.throws(action,/仅允许用户/);
 const attempt=moveProjectFiles(e.wb,'p',user,[{id:row.id,sourceDeclaration:'user_created_temporary',reason:'不能用Agent标记绕过人工分类要求'}],{probeOccupancy:()=> 'available',moveNoReplace:()=>{throw Error('must not move');}});assert.equal(attempt.failed,1);assert.match(attempt.results[0].error!,/用户明确标记/);assert.equal(fs.readFileSync(row.path,'utf8'),'SYNTHETIC_FILE_CONTENT');
});

test('元信息列表对授权撤销与伪造外部缓存路径保守处理，不泄露内部文件',()=>{
 const e=env();e.write('safe.tmp');const row=e.scan().files[0];e.wb.put('project_files',{...row,id:'outside',path:path.join(e.home,'outside.txt')},{project_id:'p'});e.wb.put('project_files',{...row,id:'secret',path:path.join(e.root,'.env')},{project_id:'p'});
 assert.equal(getProjectFiles(e.wb,{project_id:'p'},e.actor).total,1);e.wb.config.authorizedRoots=[e.data];assert.throws(()=>getProjectFiles(e.wb,{project_id:'p'},e.actor),/授权/);
});

test('Agent可直接选择第二项目根的src局部扫描，coverage明确局部且默认user扫描仍按项目根有界',()=>{
 const e=env(),firstRoot=path.join(e.home,'installed');fs.mkdirSync(firstRoot);fs.writeFileSync(path.join(firstRoot,'installed.ts'),'synthetic installed tree');
 const source=e.write('src/selected.ts');e.write('other/unselected.ts');e.wb.put('projects',{id:'p',paths:[firstRoot,e.root]});
 const defaultScan=scanProjectFiles(e.wb,'p',user,{maxFiles:1,maxMilliseconds:5000});assert.equal(defaultScan.coverage.truncated,true);assert.deepEqual(defaultScan.coverage.roots,[firstRoot,e.root]);assert.equal(defaultScan.coverage.partial,undefined);assert(!defaultScan.files.some(row=>row.path===source));
 const selected=getProjectFiles(e.wb,{project_id:'p',refresh:true,scan_paths:[path.join(e.root,'src')],query:'selected.ts'},e.actor);
 assert.equal(selected.files.length,1);assert.equal(selected.files[0].path,source);assert.equal(selected.files[0].category,'source');assert.equal(selected.coverage.partial,true);assert.deepEqual(selected.coverage.roots,[path.join(e.root,'src')]);assert.deepEqual(selected.coverage.project_roots,[firstRoot,e.root]);assert.match(selected.coverage.scope,/局部扫描，不代表全项目/);assert.equal(selected.coverage.observedFiles,1);assert.equal(selected.coverage.visitedDirectories,1);
});

test('局部scan_paths在写入前逐个拒绝项目外、data、凭据、junction和普通文件，最多10目录',()=>{
 const e=env(),source=e.write('src/safe.ts'),outside=path.join(e.home,'outside'),protectedData=path.join(e.root,'data'),credentials=path.join(e.root,'.ssh'),link=path.join(e.root,'linked-src');
 for(const directory of [outside,protectedData,credentials])fs.mkdirSync(directory);fs.symlinkSync(path.dirname(source),link,process.platform==='win32'?'junction':'dir');
 const before=e.wb.all('project_files');
 for(const selected of [outside,protectedData,credentials,link,source]){
  assert.throws(()=>getProjectFiles(e.wb,{project_id:'p',refresh:true,scan_paths:[path.dirname(source),selected]},e.actor),/授权|受保护|链接|普通目录/);assert.deepEqual(e.wb.all('project_files'),before);assert.equal(e.wb.get('projects','p').file_coverage,undefined);
 }
 assert.throws(()=>getProjectFilesInput.parse({project_id:'p',refresh:true,scan_paths:Array.from({length:11},()=>path.dirname(source))}));assert.throws(()=>getProjectFilesInput.parse({project_id:'p',refresh:true,scan_paths:[]}));
});

test('局部扫描不抹其他目录人工或Agent分类，handoff规则仍按项目根判断，查询仍覆盖全项目索引',()=>{
 const e=env();e.write('kept/manual.tmp');e.write('kept/agent.tmp');const before=e.scan().files,manual=before.find(row=>row.path.endsWith('manual.tmp'))!,agent=before.find(row=>row.path.endsWith('agent.tmp'))!;
 saveProjectFile(e.wb,'p',manual.id,user,{category:'backup',validity:'historical',retention:'keep',purpose:'人工保留其他目录经验'});assert.equal(e.classify(agent).applied,1);
 const manualBefore=e.wb.get('project_files',manual.id),agentBefore=e.wb.get('project_files',agent.id),report=e.write('docs/handoff/session/report.json');
 const selected=getProjectFiles(e.wb,{project_id:'p',refresh:true,scan_paths:[path.dirname(report)]},e.actor);
 assert.equal(selected.coverage.observedFiles,1);assert.equal(selected.files.find(row=>row.path===report)!.category,'process');assert.equal(selected.total,3);assert.deepEqual(e.wb.get('project_files',manual.id),manualBefore);assert.deepEqual(e.wb.get('project_files',agent.id),agentBefore);assert.equal(e.wb.all('project_files').filter(row=>row.validity==='invalid').length,0);
});
