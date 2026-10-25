import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeFileOperations} from '../src/core/project-native-files.ts';
import {scanProjectFiles,saveProjectFile,projectFilePath,moveProjectFiles,restoreProjectFile,type ProjectFilesWorkbench} from '../src/core/project-files.ts';
import {inside,protectedName} from '../src/core/security.ts';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.test-tmp/project-native-files');
fs.mkdirSync(base,{recursive:true});process.env.TEMP=base;process.env.TMP=base;
const windowsTest=process.platform==='win32'?test:test.skip;
const user={actor:'user' as const};
const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
// Every fixture stays under this project. No fixture or manifest is deleted.
function fixture(){
  const home=path.join(base,crypto.randomUUID()),root=path.join(home,'project'),data=path.join(home,'internal');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(data);
  const tables=new Map<string,Map<string,any>>();for(const name of ['projects','project_files','file_moves','tasks','runs','artifacts','reviews','review_assignments'])tables.set(name,new Map());
  const wb:ProjectFilesWorkbench={config:{authorizedRoots:[home],dataDir:data},all(table){assert.ok(tables.has(table));return [...tables.get(table)!.values()].map(row=>structuredClone(row))},get(table,id){const value=tables.get(table)?.get(id);assert.ok(value,'missing record');return structuredClone(value)},put(table,row){assert.ok(tables.has(table));tables.get(table)!.set(row.id,structuredClone(row))},roots(project){return project.paths},privatePath(file){return inside(data,file)||protectedName(file)}};
  wb.put('projects',{id:'p',paths:[root]});
  const write=(name:string,content='合成夹具 synthetic file')=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file};
  const candidate=(name='temporary.tmp')=>{const file=write(name),row=scanProjectFiles(wb,'p',user).files.find(f=>f.path===file)!;return saveProjectFile(wb,'p',row.id,user,{category:'process',validity:'invalid',retention:'cleanup_candidate',purpose:'本测试创建的合成临时文件',cleanup_reason:'合成夹具，无后续用途'})};
  const selection=(id:string)=>({id,sourceDeclaration:'user_created_temporary' as const,reason:'本人创建的临时文件，无其他用途或引用'});
  return {home,root,wb,write,candidate,selection};
}
async function holdExclusive(file:string){
  const code="$ErrorActionPreference='Stop'; $stream=[IO.File]::Open($env:WORKBENCH_TEST_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try { [Console]::WriteLine('held'); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { $stream.Dispose() }";
  const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,WORKBENCH_TEST_LOCK_PATH:file}});
  let stderr='';child.stderr.on('data',data=>{stderr+=data.toString()});
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(Error('fixture lock did not become ready: '+stderr))},10000);let output='';
    child.stdout.on('data',data=>{output+=data.toString();if(output.includes('held')){clearTimeout(timeout);resolve()}});
    child.once('error',error=>{clearTimeout(timeout);reject(error)});child.once('exit',code=>{clearTimeout(timeout);if(!output.includes('held'))reject(Error('fixture lock exited '+code+': '+stderr))});
  });
  return async()=>{await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('fixture lock did not release'))},10000);child.once('exit',()=>{clearTimeout(timeout);resolve()});child.stdin.end('\n')})};
}

windowsTest('Windows原生独占探测：空闲可用、缺失未知，未生成目的地',()=>{
  const e=fixture(),file=e.write('中文 空格, &.tmp');assert.equal(nativeFileOperations.probeOccupancy!(file),'available');assert.equal(nativeFileOperations.probeOccupancy!(path.join(e.root,'missing.tmp')),'unknown');assert.equal(fs.readFileSync(file,'utf8'),'合成夹具 synthetic file');
});
windowsTest('Windows原生不覆盖移动拒绝已存在目标，源与目标内容均保留',()=>{
  const e=fixture(),source=e.write('source.tmp','original'),destination=e.write('destination.tmp','existing');assert.throws(()=>nativeFileOperations.moveNoReplace!(source,destination));assert.equal(fs.readFileSync(source,'utf8'),'original');assert.equal(fs.readFileSync(destination,'utf8'),'existing');
});
windowsTest('真实原生移动与恢复经core保留hash manifest与登记状态',()=>{
  const e=fixture(),row=e.candidate('中文 空格, &.tmp'),result=moveProjectFiles(e.wb,'p',user,[e.selection(row.id)],nativeFileOperations),move=result.results[0];assert.equal(move.status,'moved',move.error);assert.equal(fs.existsSync(row.path),false);assert.equal(fs.readFileSync(move.destination_path,'utf8'),'合成夹具 synthetic file');assert.ok(fs.existsSync(move.manifest_path));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(move.destination_path)).digest('hex'),move.sha256);
  const restored=restoreProjectFile(e.wb,'p',move.id,user,nativeFileOperations);assert.equal(restored.status,'restored',restored.error);assert.equal(fs.readFileSync(row.path,'utf8'),'合成夹具 synthetic file');assert.equal(e.wb.get('project_files',row.id).retention,'keep');assert.ok(fs.existsSync(restored.manifest_path));
});
windowsTest('子进程真实持有FileShare.None时探测busy、原生移动及core移动拒绝',async()=>{
  const e=fixture(),row=e.candidate(),release=await holdExclusive(row.path),destination=path.join(e.root,'blocked.tmp');
  try{
    assert.equal(nativeFileOperations.probeOccupancy!(row.path),'busy');assert.throws(()=>nativeFileOperations.moveNoReplace!(row.path,destination));assert.equal(fs.existsSync(row.path),true);assert.equal(fs.existsSync(destination),false);
    const result=moveProjectFiles(e.wb,'p',user,[e.selection(row.id)],nativeFileOperations);assert.equal(result.failed,1);assert.match(result.results[0].error!,/占用/);assert.equal(fs.existsSync(row.path),true);assert.equal(fs.existsSync(destination),false);
  }finally{await release()}
  assert.equal(nativeFileOperations.probeOccupancy!(row.path),'available');assert.equal(fs.readFileSync(row.path,'utf8'),'合成夹具 synthetic file');
});
windowsTest('持有待清理副本时恢复拒绝，副本保留且释放后可恢复',async()=>{
  const e=fixture(),row=e.candidate(),move=moveProjectFiles(e.wb,'p',user,[e.selection(row.id)],nativeFileOperations).results[0];assert.equal(move.status,'moved',move.error);const release=await holdExclusive(move.destination_path);
  try{const result=restoreProjectFile(e.wb,'p',move.id,user,nativeFileOperations);assert.equal(result.status,'restore_failed');assert.equal(fs.existsSync(move.destination_path),true);assert.equal(fs.existsSync(row.path),false)}finally{await release()}
  assert.equal(restoreProjectFile(e.wb,'p',move.id,user,nativeFileOperations).status,'restored');assert.ok(fs.existsSync(row.path));
});
windowsTest('junction经core拒绝，原生适配器亦拒绝目标目录重定向，外部夹具保留',()=>{
  const e=fixture(),row=e.candidate(),outside=path.join(e.home,'outside');fs.mkdirSync(outside);const link=path.join(e.root,'redirect');fs.symlinkSync(outside,link,'junction');
  assert.throws(()=>nativeFileOperations.moveNoReplace!(row.path,path.join(link,'leak.tmp')));assert.ok(fs.existsSync(row.path));assert.deepEqual(fs.readdirSync(outside),[]);
  e.wb.put('project_files',{...row,path:path.join(link,'leak.tmp')});assert.throws(()=>projectFilePath(e.wb,'p',row.id,user),/链接/);const result=moveProjectFiles(e.wb,'p',user,[e.selection(row.id)],nativeFileOperations);assert.equal(result.failed,1);assert.ok(fs.existsSync(row.path));
});
windowsTest('恢复原位存在真实文件时不覆盖，原位与待清理副本保留',()=>{
  const e=fixture(),row=e.candidate(),move=moveProjectFiles(e.wb,'p',user,[e.selection(row.id)],nativeFileOperations).results[0];assert.equal(move.status,'moved',move.error);e.write(path.basename(row.path),'existing replacement');const result=restoreProjectFile(e.wb,'p',move.id,user,nativeFileOperations);assert.equal(result.status,'restore_failed');assert.equal(fs.readFileSync(row.path,'utf8'),'existing replacement');assert.equal(fs.readFileSync(move.destination_path,'utf8'),'合成夹具 synthetic file');
});
