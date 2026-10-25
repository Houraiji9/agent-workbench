import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inside,protectedName,safePath} from '../src/core/security.ts';
import {scanProjectFiles,saveProjectFile,projectFilePath,moveProjectFiles,restoreProjectFile,checkProjectFileReferences,filterProjectFiles,PROJECT_FILE_ENTRIES,type ProjectFilesWorkbench,type ProjectFile,type MoveOptions,type FileMove} from '../src/core/project-files.ts';

const user={actor:'user' as const};
const testRoot=process.env.PROJECT_FILES_TEST_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.project-files-tests');
fs.mkdirSync(testRoot,{recursive:true});process.env.TEMP=testRoot;process.env.TMP=testRoot;
// Test fixtures and manifests intentionally remain in this project for inspection.
function env(){
  const home=path.join(testRoot,crypto.randomUUID()),root=path.join(home,'project'),data=path.join(home,'internal');
  fs.mkdirSync(root,{recursive:true});fs.mkdirSync(data);
  const tables=new Map<string,Map<string,any>>();for(const table of ['projects','project_files','file_moves','tasks','runs','artifacts','reviews','review_assignments'])tables.set(table,new Map());
  const wb:ProjectFilesWorkbench={config:{authorizedRoots:[home],dataDir:data},all(table){assert.ok(tables.has(table),'table must be declared');return [...tables.get(table)!.values()].map(v=>structuredClone(v))},get(table,id){const row=tables.get(table)?.get(id);assert.ok(row,'record missing');return structuredClone(row)},put(table,row,refs){assert.ok(tables.has(table));if(table==='project_files')assert.equal(refs?.project_id,row.project_id);if(table==='file_moves'){assert.equal(refs?.project_id,row.project_id);assert.equal(refs?.file_id,row.file_id)}tables.get(table)!.set(row.id,structuredClone(row))},roots(project){return project.paths.map((p:string)=>safePath(p,[home]))},privatePath(file){return inside(data,file)||protectedName(file)}};
  wb.put('projects',{id:'p',paths:[root]});
  const write=(name:string,content='temporary fixture')=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file};
  const scan=(limits={})=>scanProjectFiles(wb,'p',user,limits);
  const candidate=(name='notes.tmp')=>{const file=write(name),row=scan().files.find(f=>f.path===file)!;return saveProjectFile(wb,'p',row.id,user,{category:'process',validity:'invalid',retention:'cleanup_candidate',purpose:'本测试创建的临时过程文件',cleanup_reason:'合成夹具，无后续用途'})};
  const select=(row:ProjectFile)=>({id:row.id,sourceDeclaration:'user_created_temporary' as const,reason:'本人创建的临时文件，无其他用途或引用'});
  const options:MoveOptions={probeOccupancy:()=> 'available',moveNoReplace:(from,to)=>{assert.equal(fs.existsSync(to),false);fs.renameSync(from,to)}};
  return {wb,root,home,data,tables,write,scan,candidate,select,options};
}

test('默认成果与七入口，未知文件无作者、元信息准确',()=>{
  const e=env(),file=e.write('未知.txt','abc'),result=e.scan();assert.equal(PROJECT_FILE_ENTRIES.length,7);assert.equal(result.files.length,1);
  const row=result.files[0];assert.equal(row.path,file);assert.equal(row.bytes,3);assert.equal(row.category,'unknown');assert.equal(row.validity,'unknown');assert.deepEqual(row.sources,[]);assert.ok(row.mtime);assert.deepEqual(filterProjectFiles(result.files),[]);assert.equal(filterProjectFiles(result.files,'unknown').length,1);assert.equal(result.coverage.complete,true);assert.equal(projectFilePath(e.wb,'p',row.id,user),file);
});
test('成果来源保留Task Run agent hash，同一路径保留多次交付',()=>{
  const e=env(),file=e.write('成果.txt');e.wb.put('tasks',{id:'t',project_id:'p'});e.wb.put('runs',{id:'r1',task_id:'t',agent_id:'agent1'});e.wb.put('runs',{id:'r2',task_id:'t',agent_id:'agent2'});
  e.wb.put('artifacts',{id:'a1',run_id:'r1',original_path:file,sha256:'h1',current:false});e.wb.put('artifacts',{id:'a2',run_id:'r2',original_path:file,sha256:'h2',current:true});
  const row=e.scan().files[0];assert.equal(row.category,'deliverable');assert.equal(row.validity,'current');assert.equal(row.sources.length,2);assert.deepEqual(row.sources[0],{artifact_id:'a1',task_id:'t',run_id:'r1',agent_id:'agent1',sha256:'h1',current:false,label:null});assert.equal(filterProjectFiles([row]).length,1);
});
test('分类必须显式保存，用途、效力、保留策略独立，重扫不覆盖',()=>{
  const e=env(),row=e.candidate();const scanned=e.scan().files[0];assert.equal(scanned.category,'process');assert.equal(scanned.validity,'invalid');assert.equal(scanned.retention,'cleanup_candidate');assert.equal(filterProjectFiles([scanned],'invalid').length,1);assert.equal(filterProjectFiles([scanned],'cleanup').length,1);
  assert.throws(()=>saveProjectFile(e.wb,'p',row.id,user,{category:'unknown',validity:'unknown',retention:'cleanup_candidate',purpose:'',cleanup_reason:''}),/理由/);
  assert.throws(()=>saveProjectFile(e.wb,'p',row.id,user,{category:'process',validity:'current',retention:'keep',purpose:'',path:e.data} as any),/仅接受/);
});
test('跳过内部data 凭据 node_modules 历史RUN 备份数据库，不读取内容',()=>{
  const e=env();for(const name of ['data/private.txt','.git/config','node_modules/pkg/a.txt','.codex/session.txt','.env','credentials.json','runs/RUN.md','secret.key','store.db'])e.write(name);
  e.write('visible.txt');const result=e.scan();assert.deepEqual(result.files.map(f=>path.basename(f.path)),['visible.txt']);assert.ok(result.coverage.skipped>=9);assert.match(result.coverage.scope,/未读取内容/);
});
test('目录links与悬空links均跳过，打开与扫描根拒绝junction',()=>{
  const e=env(),outside=path.join(e.home,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret.txt'),'x');
  const link=path.join(e.root,'link'),dangling=path.join(e.root,'dangling'),danglingTarget=path.join(e.home,'dangling-target');
  fs.mkdirSync(danglingTarget);fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');fs.symlinkSync(danglingTarget,dangling,process.platform==='win32'?'junction':'dir');
  // Windows junction creation can require an existing target. Move that target
  // afterwards to produce a real dangling entry without deleting any fixture.
  fs.renameSync(danglingTarget,danglingTarget+'-kept');assert.throws(()=>fs.realpathSync.native(dangling));assert.ok(fs.readdirSync(e.root).includes('dangling'));
  const row=e.candidate(),scanned=e.scan();for(const file of [link,dangling])assert.ok(scanned.coverage.issues.some(i=>i.path===file&&i.reason==='link_skipped'),file);
  assert.equal(scanned.coverage.visitedDirectories,1);assert.deepEqual(scanned.files.map(f=>f.path),[row.path]);
  e.wb.put('project_files',{...row,path:path.join(e.root,'link','secret.txt')},{project_id:'p'});assert.throws(()=>projectFilePath(e.wb,'p',row.id,user),/链接/);
  e.wb.put('projects',{id:'p',paths:[path.join(e.root,'link')]});assert.throws(()=>e.scan(),/链接/);
});
test('F6 同根junction在lstat与Dirent均漏标时仍link_skipped，打开和项目根均拒绝',()=>{
  const e=env(),actual=e.write('target/inside.tmp','must only be indexed at target'),link=path.join(e.root,'link');fs.symlinkSync(path.dirname(actual),link,process.platform==='win32'?'junction':'dir');
  const realLstat=fs.lstatSync,realOpendir=fs.opendirSync;
  const samePath=(input:fs.PathLike,file:string)=>{const value=path.resolve(String(input));return process.platform==='win32'?value.toLowerCase()===file.toLowerCase():value===file};
  // Reproduce the observed Windows API surface on every runtime: both flags
  // report an ordinary directory, while native realpath still resolves it.
  Object.assign(fs,{lstatSync:((input:fs.PathLike,...args:unknown[])=>{const stat=(realLstat as any)(input,...args);if(!samePath(input,link))return stat;const hidden=Object.create(stat);hidden.isSymbolicLink=()=>false;hidden.isDirectory=()=>true;return hidden}) as typeof fs.lstatSync});
  Object.assign(fs,{opendirSync:((input:fs.PathLike,...args:unknown[])=>{const dir=(realOpendir as any)(input,...args) as fs.Dir;if(samePath(input,e.root)){const read=dir.readSync.bind(dir);dir.readSync=()=>{const entry=read();if(!entry||entry.name!=='link')return entry;const hidden=Object.create(entry);hidden.isSymbolicLink=()=>false;hidden.isDirectory=()=>true;return hidden}}return dir}) as typeof fs.opendirSync});
  try{
    assert.equal(fs.lstatSync(link).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(link),fs.realpathSync.native(path.dirname(actual)));
    const result=e.scan();assert.equal(result.coverage.visitedDirectories,2);assert.deepEqual(result.files.map(f=>f.path),[actual]);assert.ok(result.coverage.issues.some(i=>i.path===link&&i.reason==='link_skipped'));assert.equal(result.coverage.unknown,0);
    const row=result.files[0];e.wb.put('project_files',{...row,path:path.join(link,'inside.tmp')},{project_id:'p'});assert.throws(()=>projectFilePath(e.wb,'p',row.id,user),/链接/);
    e.wb.put('projects',{id:'p',paths:[link]});assert.throws(()=>e.scan(),/链接/);assert.equal(fs.readFileSync(actual,'utf8'),'must only be indexed at target');
  }finally{Object.assign(fs,{lstatSync:realLstat,opendirSync:realOpendir})}
});
test('硬链接不进入可管理列表',()=>{
  const e=env(),original=e.write('original.txt');fs.linkSync(original,path.join(e.root,'alias.txt'));assert.equal(e.scan().files.length,0);assert.equal(e.scan().coverage.skipped,2);
});
test('条目 文件 深度 时间均有界，截断不自动认定失效',()=>{
  const e=env();for(let n=0;n<8;n++)e.write(`file-${n}.txt`);const first=e.scan();const partial=e.scan({maxEntries:2});assert.equal(partial.coverage.truncated,true);assert.equal(partial.coverage.visitedEntries,2);assert.equal(e.wb.all('project_files').length,first.files.length);
  assert.equal(e.scan({maxFiles:1}).files.length,1);e.write('nested/deeper/file.txt');const depth=e.scan({maxDepth:1});assert.equal(depth.coverage.complete,false);assert.ok(depth.coverage.reasons.includes('depth_limit'));assert.throws(()=>e.scan({maxEntries:-1}),/正整数/);
});
test('每次操作重验当前授权，不读取授权外路径',()=>{
  const e=env(),row=e.candidate();e.wb.config.authorizedRoots=[e.data];assert.throws(()=>projectFilePath(e.wb,'p',row.id,user),/授权/);assert.throws(()=>e.scan(),/授权/);
});
test('非user调用扫描 分类 打开 移动 恢复全部拒绝',()=>{
  const e=env(),row=e.candidate(),action={actor:'mcp'} as any;
  for(const operation of [()=>scanProjectFiles(e.wb,'p',action),()=>saveProjectFile(e.wb,'p',row.id,action,{} as any),()=>projectFilePath(e.wb,'p',row.id,action),()=>moveProjectFiles(e.wb,'p',action,[e.select(row)],e.options),()=>restoreProjectFile(e.wb,'p','missing',action,e.options)])assert.throws(operation,/仅允许用户/);
});
test('移动与恢复保留hash 原新位置manifest记录，不删除夹具',()=>{
  const e=env(),row=e.candidate('中文 空格, &.tmp'),result=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options),move=result.results[0];assert.equal(move.status,'moved',move.error);assert.equal(result.moved,1);assert.equal(fs.existsSync(row.path),false);assert.equal(fs.readFileSync(move.destination_path,'utf8'),'temporary fixture');assert.ok(fs.existsSync(move.manifest_path));assert.equal(JSON.parse(fs.readFileSync(move.manifest_path,'utf8')).sha256,move.sha256);assert.match(move.destination_path,/待清理/);
  assert.equal(e.wb.get('project_files',row.id).retention,'moved');const restored=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(restored.status,'restored',restored.error);assert.ok(fs.existsSync(row.path));assert.equal(e.wb.get('project_files',row.id).retention,'keep');assert.ok(fs.existsSync(restored.manifest_path));
});
test('未证明空闲与未声明来源的文件保留原地',()=>{
  const e=env(),row=e.candidate();const unknown=moveProjectFiles(e.wb,'p',user,[e.select(row)],{moveNoReplace:e.options.moveNoReplace});assert.equal(unknown.failed,1);assert.match(unknown.results[0].error!,/未被占用/);assert.ok(fs.existsSync(row.path));
  const missingNative=moveProjectFiles(e.wb,'p',user,[e.select(row)],{probeOccupancy:()=> 'available'});assert.equal(missingNative.failed,1);assert.match(missingNative.results[0].error!,/原生防覆盖/);
  const declaration=moveProjectFiles(e.wb,'p',user,[{...e.select(row),sourceDeclaration:'trust_me' as any}],e.options);assert.equal(declaration.failed,1);assert.ok(fs.existsSync(row.path));
});
test('源码 备份 成果 受审 历史Run 与任务引用不能通过改分类绕过',()=>{
  for(const protection of ['source','backup','artifact','review','run','task','runtime']){
    const e=env(),row=e.candidate(protection==='source'?'code.ts':protection==='backup'?'notes.bak':'notes.tmp');
    if(protection==='artifact')e.wb.put('artifacts',{id:'a',original_path:row.path});
    if(protection==='review')e.wb.put('reviews',{id:'rv',files:[{path:row.path}]});
    if(protection==='run')e.wb.put('runs',{id:'r',directory:e.root});
    if(protection==='task')e.wb.put('tasks',{id:'t',required_files:[row.path]});
    if(protection==='runtime')e.wb.put('projects',{id:'p',paths:[e.root],runtime_root:e.root});
    const result=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options);assert.equal(result.failed,1,protection);assert.ok(fs.existsSync(row.path),protection);
  }
});
test('可见引用检查明确全局未知，不能用用户complete跳过',()=>{
  const e=env(),row=e.candidate();e.wb.put('runs',{id:'r',cwd:e.root,directory:path.join(e.root,'history')});const report=checkProjectFileReferences(e.wb,'p',row.path);assert.equal(report.global,'unknown');assert.match(report.boundary,/外部工具/);assert.equal(report.references.length,0);
  e.tables.delete('reviews');const result=moveProjectFiles(e.wb,'p',user,[{...e.select(row),complete:true} as any],e.options);assert.equal(result.failed,1);assert.ok(fs.existsSync(row.path));
});
test('部分成功与locked失败分别记录，失败文件原地保留',()=>{
  const e=env(),one=e.candidate('one.tmp'),two=e.candidate('two.tmp');const result=moveProjectFiles(e.wb,'p',user,[e.select(one),e.select(two)],{...e.options,moveNoReplace:(from,to)=>{if(from===two.path)throw Object.assign(Error('locked'),{code:'EBUSY'});e.options.moveNoReplace!(from,to)}});assert.equal(result.moved,1);assert.equal(result.failed,1);assert.ok(fs.existsSync(two.path));assert.equal(result.results[1].status,'failed');assert.ok(fs.existsSync(result.results[1].manifest_path));
});
test('跨盘错误保留原文件及prepared manifest',()=>{
  const e=env(),row=e.candidate();const result=moveProjectFiles(e.wb,'p',user,[e.select(row)],{...e.options,moveNoReplace:()=>{throw Object.assign(Error('cross device'),{code:'EXDEV'})}});assert.equal(result.failed,1);assert.ok(fs.existsSync(row.path));assert.ok(fs.existsSync(result.results[0].manifest_path));
});
test('恢复拒绝原位置覆盖，恢复能力缺失保留副本，后续可重试',()=>{
  const e=env(),row=e.candidate(),move=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options).results[0];
  const missing=restoreProjectFile(e.wb,'p',move.id,user,{probeOccupancy:()=> 'available'});assert.equal(missing.status,'restore_failed');assert.ok(fs.existsSync(move.destination_path));e.write('notes.tmp','do not overwrite');
  const conflict=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(conflict.status,'restore_failed');assert.equal(fs.readFileSync(row.path,'utf8'),'do not overwrite');assert.ok(fs.existsSync(move.destination_path));
});
test('待清理内容变化或目录变成链接时拒绝恢复',()=>{
  const e=env(),row=e.candidate(),move=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options).results[0];fs.writeFileSync(move.destination_path,'changed');const result=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(result.status,'restore_failed');assert.match(result.error!,/内容已变化/);assert.ok(fs.existsSync(move.destination_path));
});
test('移动后持久化失败准确标记uncertain而不声称留原地',()=>{
  const e=env(),row=e.candidate(),put=e.wb.put.bind(e.wb);e.wb.put=(table,r,refs)=>{if(table==='file_moves'&&r.status==='moved')throw Error('db failed');put(table,r,refs)};
  const result=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options);assert.equal(result.results[0].status,'uncertain');assert.equal(fs.existsSync(row.path),false);assert.ok(fs.existsSync(result.results[0].destination_path));assert.ok(fs.existsSync(result.results[0].manifest_path));
});

function interruptedMove(e:ReturnType<typeof env>,row:ProjectFile,phase:'before'|'after',status:'prepared'|'uncertain'='prepared'){
  const result=moveProjectFiles(e.wb,'p',user,[e.select(row)],{...e.options,moveNoReplace:(from,to)=>{if(phase==='after')e.options.moveNoReplace!(from,to);throw Error('模拟进程在原生移动附近中断')}});
  const move:FileMove={...result.results[0],status,manifest_path:path.join(path.dirname(result.results[0].destination_path),'manifest.prepared.json')};
  // A real process death leaves the previously persisted prepared record; no
  // final status or project_files update has committed yet.
  delete move.error;e.wb.put('file_moves',move,{project_id:'p',file_id:row.id});return move;
}

test('F1 source_root是目录边界，用户明确授权且无引用的临时文件可移动和恢复',()=>{
  const e=env(),row=e.candidate('scratch/session.tmp');e.wb.put('projects',{id:'p',paths:[e.root],source_root:e.root});
  const check=checkProjectFileReferences(e.wb,'p',row.path);assert.equal(check.references.length,0);assert.equal(check.global,'unknown');
  const result=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options);assert.equal(result.moved,1,result.results[0].error);assert.equal(fs.existsSync(row.path),false);
  const restored=restoreProjectFile(e.wb,'p',result.results[0].id,user,e.options);assert.equal(restored.status,'restored',restored.error);assert.equal(fs.readFileSync(row.path,'utf8'),'temporary fixture');
});
test('F1 source_root内工程代码、工程说明、备份与正式安装目录仍受保护',()=>{
  for(const name of ['src/current.ts','README.md','Dockerfile','backups/session.tmp','runtime/session.tmp']){
    const e=env(),row=e.candidate(name);e.wb.put('projects',{id:'p',paths:[e.root],source_root:e.root,runtime_root:path.join(e.root,'runtime')});
    const result=moveProjectFiles(e.wb,'p',user,[e.select(row)],e.options);assert.equal(result.failed,1,name);assert.ok(fs.existsSync(row.path),name);
    if(name.startsWith('runtime/'))assert.ok(checkProjectFileReferences(e.wb,'p',row.path).references.some(r=>r.reason==='runtime_root'));
  }
});
test('F3 prepared在移动前中断：核对原文件和manifest，只修复登记，不搬动文件',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'before');let calls=0;
  const result=restoreProjectFile(e.wb,'p',move.id,user,{...e.options,moveNoReplace:()=>{calls++;throw Error('不应执行移动')}});
  assert.equal(result.status,'restored',result.error);assert.equal(result.reconciliation?.action,'already_original');assert.equal(calls,0);assert.equal(e.wb.get('project_files',row.id).retention,'keep');
  assert.equal(fs.readFileSync(row.path,'utf8'),'temporary fixture');assert.equal(fs.existsSync(move.destination_path),false);assert.ok(fs.existsSync(result.manifest_path));assert.ok(fs.existsSync(move.manifest_path));
});
test('F3 rename后prepared和uncertain都能从实物对账并恢复，项目行未写moved也可恢复',()=>{
  for(const status of ['prepared','uncertain'] as const){
    const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after',status);assert.equal(e.wb.get('project_files',row.id).retention,'cleanup_candidate');
    const result=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(result.status,'restored',result.error);assert.equal(result.reconciliation?.action,'moved_to_original');assert.equal(result.reconciliation?.location,'original_only');
    assert.equal(fs.readFileSync(row.path,'utf8'),'temporary fixture');assert.equal(fs.existsSync(move.destination_path),false);assert.equal(e.wb.get('project_files',row.id).retention,'keep');
  }
});
test('F3 原位置和待清理位置都存在：检查双方占用且保留双方，不选择或删除副本',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after');e.write('notes.tmp','new original');const probed:string[]=[];let calls=0;
  const result=restoreProjectFile(e.wb,'p',move.id,user,{probeOccupancy:file=>{probed.push(file);return 'available'},moveNoReplace:()=>{calls++}});
  assert.notEqual(result.status,'restored');assert.equal(result.reconciliation?.location,'both');assert.match(result.error!,/禁止覆盖或删除/);assert.equal(calls,0);assert.ok(probed.includes(row.path));assert.ok(probed.includes(move.destination_path));
  assert.equal(fs.readFileSync(row.path,'utf8'),'new original');assert.equal(fs.readFileSync(move.destination_path,'utf8'),'temporary fixture');
});
test('F3 两处均不存在：记录未知，不把其他位置的文件删除或猜作已恢复',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after'),held=path.join(e.root,'manual-relocation.tmp');fs.renameSync(move.destination_path,held);
  const result=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.notEqual(result.status,'restored');assert.equal(result.reconciliation?.location,'neither');assert.match(result.error!,/均不存在/);assert.equal(fs.readFileSync(held,'utf8'),'temporary fixture');
});
test('F3 任一唯一副本内容变化均拒绝，不能只根据存在位置修复登记',()=>{
  for(const phase of ['before','after'] as const){
    const e=env(),row=e.candidate(),move=interruptedMove(e,row,phase),actual=phase==='before'?row.path:move.destination_path;fs.writeFileSync(actual,'modified file');
    const result=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.notEqual(result.status,'restored');assert.match(result.error!,/内容已变化/);assert.equal(fs.readFileSync(actual,'utf8'),'modified file');assert.equal(e.wb.get('project_files',row.id).retention,'cleanup_candidate');
  }
});
test('F3 原位置或待清理副本被占用、占用未知时原样保留',()=>{
  for(const phase of ['before','after'] as const)for(const occupancy of ['busy','unknown'] as const){
    const e=env(),row=e.candidate(),move=interruptedMove(e,row,phase),actual=phase==='before'?row.path:move.destination_path;
    const result=restoreProjectFile(e.wb,'p',move.id,user,{...e.options,probeOccupancy:()=>occupancy});assert.notEqual(result.status,'restored');assert.match(result.error!,/占用/);assert.equal(fs.readFileSync(actual,'utf8'),'temporary fixture');
  }
});
test('F3 对账拒绝原路径junction且保留待清理副本与外部空目录',()=>{
  const linked=env(),linkedRow=linked.candidate('scratch/notes.tmp'),linkedMove=interruptedMove(linked,linkedRow,'after');
  const kept=path.join(linked.root,'scratch-kept'),outside=path.join(linked.home,'outside');fs.renameSync(path.dirname(linkedRow.path),kept);fs.mkdirSync(outside);fs.symlinkSync(outside,path.dirname(linkedRow.path),process.platform==='win32'?'junction':'dir');
  const denied=restoreProjectFile(linked.wb,'p',linkedMove.id,user,linked.options);assert.notEqual(denied.status,'restored');assert.match(denied.error!,/链接/);assert.ok(fs.existsSync(linkedMove.destination_path));assert.deepEqual(fs.readdirSync(outside),[]);
});
test('F3 伪造原始manifest单独拒绝且保留待清理副本',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after');const proof=JSON.parse(fs.readFileSync(move.manifest_path,'utf8'));proof.sha256='0'.repeat(64);fs.writeFileSync(move.manifest_path,JSON.stringify(proof));
  const tampered=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.notEqual(tampered.status,'restored');assert.match(tampered.error!,/凭据与记录不一致/);assert.ok(fs.existsSync(move.destination_path));
});
test('F3 伪造目的地单独拒绝且不碰无关文件',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after');
  const forged={...move,destination_path:e.write('unrelated.tmp','unrelated')};e.wb.put('file_moves',forged,{project_id:'p',file_id:row.id});const mismatch=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.notEqual(mismatch.status,'restored');assert.match(mismatch.error!,/位置与原移动凭据不符/);assert.equal(fs.readFileSync(forged.destination_path,'utf8'),'unrelated');
});
test('F3 恢复rename后项目行写入失败：uncertain可再次对账，不丢原文件或覆盖证据',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after'),put=e.wb.put.bind(e.wb);let fail=true;
  e.wb.put=(table,value,refs)=>{if(fail&&table==='project_files'&&value.retention==='keep')throw Error('模拟恢复后登记失败');put(table,value,refs)};
  const failed=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(failed.status,'uncertain');assert.equal(fs.readFileSync(row.path,'utf8'),'temporary fixture');assert.equal(fs.existsSync(move.destination_path),false);assert.ok(fs.existsSync(failed.manifest_path));
  fail=false;const retried=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(retried.status,'restored',retried.error);assert.equal(retried.reconciliation?.action,'already_original');assert.notEqual(retried.manifest_path,failed.manifest_path);assert.ok(fs.existsSync(failed.manifest_path));assert.equal(e.wb.get('project_files',row.id).retention,'keep');
});
test('F3 恢复后file_moves持续写入失败仍可由旧prepared再次核对，不能误报成功',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after'),put=e.wb.put.bind(e.wb);let fail=true;
  e.wb.put=(table,value,refs)=>{if(fail&&table==='file_moves')throw Error('模拟移动记录存储失败');put(table,value,refs)};
  const failed=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(failed.status,'uncertain');assert.ok(failed.persistence_error);assert.equal(e.wb.get('file_moves',move.id).status,'prepared');assert.equal(e.wb.get('project_files',row.id).retention,'keep');assert.ok(fs.existsSync(row.path));
  fail=false;const retried=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.equal(retried.status,'restored',retried.error);assert.equal(retried.reconciliation?.action,'already_original');assert.ok(fs.existsSync(row.path));
});
test('F3 原生恢复遇到检查后的目标重名，保留新原文件和待清理副本',()=>{
  const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after');
  const result=restoreProjectFile(e.wb,'p',move.id,user,{...e.options,moveNoReplace:()=>{e.write('notes.tmp','arrived during restore');throw Error('native target exists')}});
  assert.notEqual(result.status,'restored');assert.equal(fs.readFileSync(row.path,'utf8'),'arrived during restore');assert.equal(fs.readFileSync(move.destination_path,'utf8'),'temporary fixture');
  assert.notEqual(restoreProjectFile(e.wb,'p',move.id,user,e.options).status,'restored');
});
test('F3 对账后任一位置新增正式成果或受审引用，待清理副本继续保留',()=>{
  for(const location of ['original','destination'] as const)for(const entity of ['artifacts','reviews']){
    const e=env(),row=e.candidate(),move=interruptedMove(e,row,'after'),file=location==='original'?move.original_path:move.destination_path;
    e.wb.put(entity,entity==='artifacts'?{id:'a',original_path:file}:{id:'review',files:[{path:file}]});
    const result=restoreProjectFile(e.wb,'p',move.id,user,e.options);assert.notEqual(result.status,'restored');assert.match(result.error!,/引用/);assert.equal(fs.existsSync(row.path),false);assert.equal(fs.readFileSync(move.destination_path,'utf8'),'temporary fixture');
  }
});
