// Run-scoped convenience client: credentials never appear in prompts or output.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {loadConfig} from '../src/core/config.ts';import {cliHelp,cliSchema,cliExample,validateCliInput,cliDefinitions} from './agent-cli.ts';import {safePath,readBounded,atomicWrite} from '../src/core/security.ts';
let [run,action,arg,extra]=process.argv.slice(2);
const usage='用法：agent.ts <Run ID> context [known_hash] | context-section <plan|files|requirements|history> | read <JSON文件> | start | report <JSON文件> | register-delegation <JSON文件> | report-delegation <JSON文件> | review | continue | job <Job ID> | wait <revision> | closeout <JSON文件> | deployment <manifest_sha256> | deployment-context | deployment-evidence <JSON文件>；--help 查看帮助';
const actions=new Set(['context-section','context','read','start','report','register-delegation','report-delegation','review','continue','job','wait','closeout','deployment','deployment-context','deployment-evidence','manage','recover-review','closeout-context','get_closeout_context','mapping']);
let token='';
let credentialRun='',currentRun='';
const redact=(text:string)=>token?text.replaceAll(token,'[redacted]'):text;
// UUIDv5 gives retries of the same scoped registration a stable request ID.
function canonical(value:any):any{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
function delegationRequestId(input:any){const bytes=crypto.createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex')).update(JSON.stringify({tool:'register_delegation',run_id:run,input:canonical(input)})).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|0x50;bytes[8]=(bytes[8]&63)|0x80;const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
async function main(){
  if(run==='--help'||run==='help'||action==='--help'||action==='help'){console.log(cliHelp);return;}
  const local=run==='schema'||run==='example'||run==='examples'||run==='validate-only'||run==='bootstrap'?run:action==='schema'||action==='example'||action==='examples'||action==='validate-only'||action==='bootstrap'?action:null;
  if(local){
    const scoped=local===action,name=scoped?arg:action,file=scoped?extra:arg;
    if(local==='bootstrap'){console.log(JSON.stringify({schema_version:1,help:cliHelp,actions:Object.keys(cliDefinitions),steps:['help','schema report','example report','validate-only report input.json','<Run ID> context','<Run ID> start'],credential:'仅Run动作读取本地凭据；current根据当前会话映射，续接由服务端校验'},null,2));return;}
    if(local==='examples'&&!name){console.log(JSON.stringify({schema_version:1,examples:Object.fromEntries(Object.keys(cliDefinitions).map(k=>[k,cliExample(k)]))},null,2));return;}
    if(!name)throw Error('请指定动作，例如 node --import tsx scripts/agent.ts '+local+' report');
    if(local==='schema'||local==='example'||local==='examples'){console.log(JSON.stringify(local==='schema'?cliSchema(name):cliExample(name),null,2));return;}
    if(!file)throw Error('用法：agent.ts validate-only '+name+' input.json；先运行 example '+name);
    const checked=validateCliInput(name,JSON.parse(readBounded(path.resolve(file),1024*1024).toString('utf8')));console.log(JSON.stringify(checked,null,2));if(!checked.valid)process.exitCode=1;return;
  }
  if(run!=='current'&&!/^R-[a-f0-9-]{36}$/.test(run||''))throw Error(usage);
  if(!actions.has(action))throw Error('不支持的动作。'+usage);
  const config=loadConfig(),session=process.env.CODEX_THREAD_ID||process.env.CODEX_SESSION_ID;
  const mappingFile=session?path.join(config.dataDir,'agent-cli','session-'+crypto.createHash('sha256').update(session).digest('hex')+'.json'):null;
  let mapping:any=null;
  if(mappingFile){try{mapping=JSON.parse(readBounded(safePath(mappingFile,[config.dataDir]),4096).toString('utf8'));}catch{}}
  if(run==='current'){
    run=process.env.WORKBENCH_CREDENTIAL_RUN_ID||process.env.WORKBENCH_RUN_ID||mapping?.credential_run_id;
    if(!run)throw Error('current 无当前会话映射。先运行 agent.ts <Run ID> context，或设置 WORKBENCH_CREDENTIAL_RUN_ID=<Run ID>；凭据不会输出。');
  }
  credentialRun=run;currentRun=mapping?.credential_run_id===run?mapping.current_run_id:run;
  if(!/^R-[a-f0-9-]{36}$/.test(run||''))throw Error(usage);
  if(!actions.has(action))throw Error('不支持的动作。'+usage);
  try{const credentials=JSON.parse(fs.readFileSync(safePath(path.join(config.dataDir,'run-keys',run+'.json'),[config.dataDir]),'utf8'));if(typeof credentials.token!=='string'||!credentials.token)throw Error();token=credentials.token;}catch{throw Error('无法读取当前 Run 的执行凭据');}
  if(action==='mapping'){console.log(JSON.stringify({credential_run_id:credentialRun,current_run_id:currentRun,verified:false,reason:'仅本地成功调用映射；正式授权仍由服务端逐次验证'}));return;}
  async function call(tool:string,input:any){const r=await fetch(`http://127.0.0.1:${config.port}/api/mcp/${tool}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(process.env.WORKBENCH_EXECUTION_JOB_ID&&process.env.WORKBENCH_EXECUTION_JOB_TOKEN?{'x-workbench-execution-job-id':process.env.WORKBENCH_EXECUTION_JOB_ID,'x-workbench-execution-job-token':process.env.WORKBENCH_EXECUTION_JOB_TOKEN}:{})},body:JSON.stringify({...input,run_id:run}),signal:AbortSignal.timeout(120000)});let data:any;try{data=await r.json();}catch{throw Error(`工作台返回了无效 JSON（HTTP ${r.status}）`);}if(!r.ok)throw Error(data.error||'请求失败');
    const resolved=data.authority?.run_id||data.current_run_id||data.run_id;
    if(typeof resolved==='string'&&/^R-[a-f0-9-]{36}$/.test(resolved))currentRun=resolved;
    if(mappingFile){atomicWrite(safePath(mappingFile,[config.dataDir],true),JSON.stringify({schema_version:1,credential_run_id:credentialRun,current_run_id:currentRun,updated_at:new Date().toISOString()}));}
    return data;}
  let result:any;
  if(action==='manage'){
    if(!arg||!extra)throw Error('用法：agent.ts <Run ID> manage <管理或读取工具名> <JSON文件>');
    result=await call(arg,JSON.parse(readBounded(path.resolve(extra),1024*1024).toString('utf8')));
  }else if(action==='context-section')result=await call('get_run_context',{section:arg});
  else if(action==='context')result=await call('get_run_context',{mode:arg?'delta':'brief',...(arg?{known_context_hash:arg}:{})});
  else if(action==='start'){
    const context=await call('get_run_context',{mode:'brief'}),session=process.env.CODEX_THREAD_ID||process.env.CODEX_SESSION_ID;
    await call('ack_run_context',{context_hash:context.context_hash,...(session?{session_id:session}:{})});
    result=context.state.run_status==='running'?{already_started:true,context}:{receipt:await call('report_run_activity',{event_id:'agent-start-'+crypto.randomUUID(),event_type:'started',data:{message:'已获取当前任务上下文并接单',...(session?{session_id:session}:{})}}),context};
  }else if(action==='read')result=await call('read_run_context_file',JSON.parse(readBounded(path.resolve(arg),64*1024).toString('utf8')));
  else if(action==='review'||action==='continue'){
    const context=await call('get_run_context',{mode:'brief'});
    result=await call(action==='review'?'dispatch_review':'continue_run',{request_id:crypto.randomUUID(),expected_revision:context.task_revision});
    if(action==='continue'&&result.continuation?.mode==='same_session')result.next_command={credential_run_id:run,current_run_id:result.run_id,action:'context',reason:'保留当前凭据；服务端按正式同会话续接链解析当前Run'};
  }else if(action==='recover-review')result=await call('recover_native_review',{job_id:arg});
  else if(action==='job')result=await call('get_agent_job',{job_id:arg,timeout_ms:25000});
  else if(action==='report'){
    const input=JSON.parse(readBounded(path.resolve(arg),1024*1024).toString('utf8'));
    const event_id=input.event_id||'agent-'+crypto.createHash('sha256').update(run+JSON.stringify(input)).digest('hex');
    result=await call('report_run_activity',{event_id,event_type:input.event_type,data:input.data});
  }else if(action==='register-delegation'||action==='report-delegation'){
    if(!arg)throw Error('请提供委派请求 JSON 文件');
    const input=JSON.parse(readBounded(path.resolve(arg),1024*1024).toString('utf8'));
    if(input?.run_id!==undefined&&input.run_id!==run&&input.run_id!==currentRun)throw Error('JSON 中的 run_id 必须与命令中的当前 Run 一致');
    const payload={...input};delete payload.run_id;
    if(action==='register-delegation'&&payload.request_id===undefined)payload.request_id=delegationRequestId(payload);
    result=await call(action==='register-delegation'?'register_delegation':'report_delegation',payload);
  }else if(action==='wait')result=await call('wait_run_update',{after_revision:Number(arg)||0,timeout_ms:25000});
  else if(action==='closeout'){const input=JSON.parse(readBounded(path.resolve(arg),1024*1024).toString('utf8'));result=await call('complete_run_closeout',{...input,event_id:input.event_id||'closeout-'+crypto.createHash('sha256').update(run+JSON.stringify(input)).digest('hex')});}
  else if(action==='deployment')result=await call('report_runtime_deployment',{manifest_sha256:arg});
  else if(action==='closeout-context'||action==='get_closeout_context')result=await call('get_closeout_context',{detail:arg||'brief'});
  else if(action==='deployment-context')result=await call('get_deployment_context',{});
  else if(action==='deployment-evidence')result=await call('report_deployment_evidence',JSON.parse(readBounded(path.resolve(arg),1024*1024).toString('utf8')));
  else throw Error('不支持的动作');
  console.log(redact(JSON.stringify(result,null,2)));if(result.disposition&&result.disposition!=='applied')process.exitCode=1;
}
try{await main();}catch(error){console.error(redact((error as Error).message)+'\n参数帮助：node --import tsx scripts/agent.ts help；JSON示例：node --import tsx scripts/agent.ts example report；只校验：node --import tsx scripts/agent.ts validate-only report input.json');process.exitCode=1;}
