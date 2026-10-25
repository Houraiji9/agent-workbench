import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {delegationInput,delegationReportInput} from '../src/core/workflow-policy.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run='R-11111111-1111-4111-8111-111111111111';
const otherRun='R-22222222-2222-4222-8222-222222222222';
type Request={url:string;authorization:string|undefined;body:any};
type Reply={status?:number;body?:any;raw?:string};
type Result={code:number|null;stdout:string;stderr:string};

async function fixture(t:TestContext,reply:(request:Request)=>Reply=()=>({body:{ok:true}})){
  // Only synthetic credentials in a new project-local directory; never load a real config or ledger.
  const dir=path.join(process.env.WORKBENCH_TEST_OUTPUT_DIR||path.join(root,'.test-tmp'),'agent-cli-'+crypto.randomUUID());
  const data=path.join(dir,'data'),temp=path.join(dir,'temp'),token='synthetic-run-token-'+crypto.randomUUID();
  fs.mkdirSync(path.join(data,'run-keys'),{recursive:true});fs.mkdirSync(path.join(dir,'config'));fs.mkdirSync(temp);
  for(const id of [run,otherRun])fs.writeFileSync(path.join(data,'run-keys',id+'.json'),JSON.stringify({token}));
  const requests:Request[]=[];
  const server=createServer(async(req,res)=>{
    try{
      let text='';for await(const chunk of req)text+=chunk;
      const request={url:req.url||'',authorization:req.headers.authorization,body:JSON.parse(text)};requests.push(request);
      const result=reply(request);res.statusCode=result.status||200;res.setHeader('content-type','application/json');res.end(result.raw??JSON.stringify(result.body??{}));
    }catch(error){res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:(error as Error).message}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const port=(server.address() as AddressInfo).port;
  const env={...process.env,WORKBENCH_ROOT:dir,WORKBENCH_DATA_DIR:data,WORKBENCH_PORT:String(port),TEMP:temp,TMP:temp,CODEX_THREAD_ID:'synthetic-parent-session',CODEX_SESSION_ID:''};
  const invoke=(args:string[])=>new Promise<Result>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'node_modules/tsx/dist/loader.mjs')).href,path.join(root,'scripts/agent.ts'),...args],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('CLI mock test timed out'));},15000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
  const write=(name:string,input:any)=>{const file=path.join(dir,name+'.json');fs.writeFileSync(file,JSON.stringify(input));return file;};
  const registration={model:'model-from-run-policy',goal:'只检查本次合成材料',required_files:[],allowed_paths:[dir],output_dir:dir,context_bytes:4096};
  // Fixtures and evidence are retained; this test does not delete files.
  return {dir,data,token,requests,invoke,write,registration};
}

function success(result:Result){assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout);}
function noCredential(result:Result,token:string){assert(!result.stdout.includes(token));assert(!result.stderr.includes(token));}

test('runner CLI 帮助列出委派动作，帮助和无效命令不读取凭据或访问HTTP',async t=>{
  const f=await fixture(t);
  fs.writeFileSync(path.join(f.dir,'config/local.json'),'not valid JSON');
  for(const args of [['--help'],[run,'--help']]){
    const result=await f.invoke(args);assert.equal(result.code,0);assert.match(result.stdout,/register-delegation <JSON文件>/);assert.match(result.stdout,/report-delegation <JSON文件>/);
  }
  for(const args of [['invalid-run','register-delegation'],[run,'unknown-action']]){
    const result=await f.invoke(args);assert.equal(result.code,1);assert.match(result.stderr,/用法：agent.ts/);assert(!result.stderr.includes('SyntaxError'));
  }
  assert.equal(f.requests.length,0);
});

test('登记使用固定Run凭据，稳定UUID支持重试、字段重排和显式独立请求',async t=>{
  const registrations=new Map<string,string>();
  const f=await fixture(t,request=>{
    assert.equal(request.url,'/api/mcp/register_delegation');
    const input=delegationInput.parse(request.body);
    if(!registrations.has(input.request_id))registrations.set(input.request_id,'D-'+crypto.randomUUID());
    return {body:{id:registrations.get(input.request_id),run_id:input.run_id,request_id:input.request_id,status:'authorized'}};
  });
  const file=f.write('register',f.registration);
  const first=success(await f.invoke([run,'register-delegation',file]));
  const retry=success(await f.invoke([run,'register-delegation',file]));
  const reordered=f.write('register-reordered',Object.fromEntries(Object.entries(f.registration).reverse()));
  assert.equal(success(await f.invoke([run,'register-delegation',reordered])).id,first.id);
  assert.equal(retry.id,first.id);assert.equal(registrations.size,1);assert.equal(first.run_id,run);
  const explicit=crypto.randomUUID();
  const second=success(await f.invoke([run,'register-delegation',f.write('register-new',{...f.registration,request_id:explicit,run_id:run})]));
  assert.equal(second.request_id,explicit);assert.notEqual(second.id,first.id);
  const other=success(await f.invoke([otherRun,'register-delegation',file]));
  assert.equal(other.run_id,otherRun);assert.notEqual(other.request_id,first.request_id);
  for(const request of f.requests){assert.equal(request.authorization,'Bearer '+f.token);assert(!('session_id' in request.body));assert(!('actual_model' in request.body));}
});

test('两种委派入口拒绝JSON改换Run且不发送跨Run请求',async t=>{
  const f=await fixture(t);
  for(const action of ['register-delegation','report-delegation']){
    const result=await f.invoke([run,action,f.write(action,{...f.registration,run_id:otherRun})]);
    assert.equal(result.code,1);assert.match(result.stderr,/run_id 必须与命令中的当前 Run 一致/);noCredential(result,f.token);
  }
  assert.equal(f.requests.length,0);
});

test('回报使用后端schema，不添加request_id或伪造模型会话，重复内容保持一致',async t=>{
  const f=await fixture(t,request=>{
    assert.equal(request.url,'/api/mcp/report_delegation');
    const input=delegationReportInput.parse(request.body);
    return {body:{id:input.delegation_id,status:input.status,observed_by:'executor_reported'}};
  });
  const input={delegation_id:'D-synthetic',status:'running',summary:'只表示模拟会话已开始'};
  const file=f.write('report',input);
  success(await f.invoke([run,'report-delegation',file]));success(await f.invoke([run,'report-delegation',file]));
  assert.deepEqual(f.requests[0].body,{...input,run_id:run});assert.deepEqual(f.requests[0].body,f.requests[1].body);
  const completed={...input,status:'completed',session_id:'actual-child-session-from-client',actual_model:'actual-child-model-from-client',artifacts:[]};
  success(await f.invoke([run,'report-delegation',f.write('completed',completed)]));
  assert.deepEqual(f.requests[2].body,{...completed,run_id:run});assert.equal(f.requests[2].authorization,'Bearer '+f.token);
});

test('委派字段由HTTP后端校验，非法UUID和多余身份字段不会被CLI修补或丢弃',async t=>{
  const f=await fixture(t,request=>{(request.url.endsWith('register_delegation')?delegationInput:delegationReportInput).parse(request.body);return {body:{ok:true}};});
  const cases=[
    ['register-delegation',{...f.registration,request_id:'not-a-uuid'}],
    ['register-delegation',{...f.registration,role:'manager'}],
    ['report-delegation',{delegation_id:'D-synthetic',status:'completed',request_id:crypto.randomUUID()}],
  ] as const;
  for(const [action,input] of cases){const result=await f.invoke([run,action,f.write('bad-'+f.requests.length,input)]);assert.equal(result.code,1);assert.equal(result.stdout,'');noCredential(result,f.token);}
  assert.equal(f.requests.length,3);assert.equal(f.requests[0].body.request_id,'not-a-uuid');assert.equal(f.requests[1].body.role,'manager');assert('request_id' in f.requests[2].body);
});

test('HTTP拒绝、无效响应和成功回显都不输出Run凭据',async t=>{
  const f=await fixture(t,request=>{
    const secret=request.authorization!.slice('Bearer '.length);
    if(request.body.goal==='模拟权限拒绝')return {status:403,body:{error:'权限拒绝 '+secret}};
    if(request.body.goal==='模拟非JSON响应')return {status:502,raw:'upstream credential '+secret};
    return {body:{status:'authorized',debug_echo:secret}};
  });
  const denied=await f.invoke([run,'register-delegation',f.write('denied',{...f.registration,goal:'模拟权限拒绝'})]);
  assert.equal(denied.code,1);assert.match(denied.stderr,/权限拒绝 \[redacted\]/);noCredential(denied,f.token);
  const invalid=await f.invoke([run,'register-delegation',f.write('invalid-response',{...f.registration,goal:'模拟非JSON响应'})]);
  assert.equal(invalid.code,1);assert.match(invalid.stderr,/无效 JSON（HTTP 502）/);noCredential(invalid,f.token);
  const echoed=await f.invoke([run,'register-delegation',f.write('echoed',f.registration)]);
  assert.equal(success(echoed).debug_echo,'[redacted]');noCredential(echoed,f.token);
});

test('损坏凭据、缺少JSON和非法JSON以错误码退出，不泄露文件内容或发送请求',async t=>{
  const f=await fixture(t);
  const noFile=await f.invoke([run,'register-delegation']);assert.equal(noFile.code,1);assert.match(noFile.stderr,/请提供委派请求 JSON 文件/);
  const invalid=f.write('invalid-json',{});fs.writeFileSync(invalid,'{"token":"'+f.token+'",');
  const malformed=await f.invoke([run,'report-delegation',invalid]);assert.equal(malformed.code,1);noCredential(malformed,f.token);
  fs.writeFileSync(path.join(f.data,'run-keys',run+'.json'),'{"token":"'+f.token+'",');
  const credentials=await f.invoke([run,'register-delegation',f.write('valid',f.registration)]);
  assert.equal(credentials.code,1);assert.match(credentials.stderr,/无法读取当前 Run 的执行凭据/);noCredential(credentials,f.token);assert.equal(f.requests.length,0);
});
