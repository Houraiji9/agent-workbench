import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture,setup,event} from './helpers.ts';import {createApp} from '../src/server/app.ts';

async function env(){
 const f=fixture();f.wb.close();const calls:string[]=[];const {app,wb}=await createApp(f.config,{background:false,revealArtifact:async file=>{calls.push(file)}});
 const t=setup(wb,f.root),folder=path.join(f.root,'设计 成果, v1 & 截图');fs.mkdirSync(folder);const file=path.join(folder,'示例 图.png');fs.writeFileSync(file,'test');
 wb.event(event(f.root,t.tid,t.rid,1));wb.event(event(f.root,t.tid,t.rid,2,'submitted',{result:'测试成果文件夹打开，验证原始文件和归档副本的路径。',artifacts:[{path:file,label:'示例 图.png'}]}));
 const a=wb.all('artifacts').find(x=>x.original_path===file)!;
 const host='127.0.0.1:'+f.config.port,b=await app.inject({method:'GET',url:'/api/bootstrap',headers:{host}}),cookie=String(b.headers['set-cookie']).split(';')[0],csrf=b.json().csrf;
 const post=(body:object,id=a.id,headers:Record<string,string>={cookie,'x-workbench-csrf':csrf})=>app.inject({method:'POST',url:'/api/artifacts/'+id+'/open-folder',headers:{host,...headers},payload:body});
 return {...f,app,wb,calls,file,folder,a,t,post,host,cookie,csrf};
}
test('按成果ID打开原目录和归档目录，保留中文空格与特殊字符，历史成果同样可用',async()=>{
 const e=await env();try{const before=JSON.stringify(e.wb.get('artifacts',e.a.id));const r=await e.post({target:'original'});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().folder,e.folder);assert.deepEqual(e.calls,[e.file]);assert.equal((await e.post({target:'archive'})).json().file,e.a.archive_path);assert.equal(JSON.stringify(e.wb.get('artifacts',e.a.id)),before);e.wb.put('artifacts',{...e.a,current:false},{run_id:e.t.rid});assert.equal((await e.post({target:'original'})).statusCode,200)}finally{await e.app.close()}
});
test('原文件删除、缺少原路径和归档丢失均给出实际结果，仍可打开存在的归档',async()=>{
 const e=await env();try{fs.unlinkSync(e.file);assert.equal((await e.post({target:'original'})).statusCode,404);assert.equal(e.calls.length,0);assert.equal((await e.post({target:'archive'})).statusCode,200);e.wb.put('artifacts',{...e.a,original_path:null},{run_id:e.t.rid});assert.match((await e.post({target:'original'})).json().error,/只有归档副本/);fs.unlinkSync(e.a.archive_path);assert.notEqual((await e.post({target:'archive'})).statusCode,200);assert.equal(e.calls.length,1)}finally{await e.app.close()}
});
test('目录打开要求页面会话与CSRF，只接受original/archive，拒绝附带任意路径',async()=>{
 const e=await env();try{assert.equal((await e.post({target:'original'},e.a.id,{})).statusCode,401);assert.equal((await e.post({target:'original'},e.a.id,{cookie:e.cookie})).statusCode,403);for(const body of [{target:'other'},{target:'original',path:'C:\\Windows'},{}])assert.equal((await e.post(body)).statusCode,400);assert.equal((await e.post({target:'original'},'A-missing')).statusCode,404);assert.equal((await e.post({target:'original'},e.a.id,{cookie:e.cookie,'x-workbench-csrf':e.csrf,origin:'https://example.com'})).statusCode,403);assert.equal(e.calls.length,0)}finally{await e.app.close()}
});
test('重验当前授权、任务范围、保护目录和路径重定向，归档不能指向其他位置',async()=>{
 const e=await env();try{
  const guarded=path.join(e.root,'.ssh','secret.txt');fs.mkdirSync(path.dirname(guarded));fs.writeFileSync(guarded,'test');e.wb.put('artifacts',{...e.a,original_path:guarded},{run_id:e.t.rid});assert.equal((await e.post({target:'original'})).statusCode,403);
  e.wb.put('artifacts',{...e.a,archive_path:e.file},{run_id:e.t.rid});assert.equal((await e.post({target:'archive'})).statusCode,403);e.wb.put('artifacts',e.a,{run_id:e.t.rid});
  const allowed=e.config.authorizedRoots;e.config.authorizedRoots=[e.config.dataDir];assert.equal((await e.post({target:'original'})).statusCode,403);assert.equal((await e.post({target:'archive'})).statusCode,200);e.config.authorizedRoots=allowed;
  const task=e.wb.get('tasks',e.t.tid);e.wb.put('tasks',{...task,allowed_paths:[e.wb.get('runs',e.t.rid).directory]},{project_id:task.project_id});assert.equal((await e.post({target:'original'})).statusCode,403);e.wb.put('tasks',task,{project_id:task.project_id});
  const outside=path.join(path.dirname(e.root),'跳转目录-'+Date.now());fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,path.basename(e.file)),'outside');fs.renameSync(e.folder,e.folder+'-旧');fs.symlinkSync(outside,e.folder,process.platform==='win32'?'junction':'dir');assert.equal((await e.post({target:'original'})).statusCode,403);assert.equal(e.calls.length,1);
 }finally{await e.app.close()}
});
test('系统打开失败返回错误，后台仍可响应',async()=>{
 const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false,revealArtifact:async()=>{throw Error('文件夹未能打开')}});try{const t=setup(wb,f.root);wb.event(event(f.root,t.tid,t.rid,1));wb.event(event(f.root,t.tid,t.rid,2,'submitted',{result:'测试系统打开失败后的错误提示与服务保持正常响应'}));const a=wb.all('artifacts')[0],host='127.0.0.1:'+f.config.port,b=await app.inject({method:'GET',url:'/api/bootstrap',headers:{host}});const r=await app.inject({method:'POST',url:'/api/artifacts/'+a.id+'/open-folder',headers:{host,cookie:String(b.headers['set-cookie']).split(';')[0],'x-workbench-csrf':b.json().csrf},payload:{target:'archive'}});assert.equal(r.statusCode,500);assert.equal((await app.inject({method:'GET',url:'/api/health',headers:{host}})).statusCode,200)}finally{await app.close()}
});
