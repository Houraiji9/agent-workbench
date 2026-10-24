// Run-scoped convenience client: credentials never appear in prompts or output.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {loadConfig} from '../src/core/config.ts';import {safePath,readBounded} from '../src/core/security.ts';
const config=loadConfig(),[run,action,arg]=process.argv.slice(2);
if(!/^R-[a-f0-9-]{36}$/.test(run||''))throw Error('用法：agent.ts <Run ID> context [known_hash] | start | report <JSON文件> | wait <revision> | closeout <JSON文件> | deployment <manifest_sha256>');
const {token}=JSON.parse(fs.readFileSync(safePath(path.join(config.dataDir,'run-keys',run+'.json'),[config.dataDir]),'utf8'));
async function call(tool:string,input:any){const r=await fetch(`http://127.0.0.1:${config.port}/api/mcp/${tool}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...input,run_id:run}),signal:AbortSignal.timeout(120000)});const data:any=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;}
try{
  let result:any;
  if(action==='context')result=await call('get_run_context',{mode:arg?'delta':'brief',...(arg?{known_context_hash:arg}:{})});
  else if(action==='start'){
    const context=await call('get_run_context',{mode:'brief'}),session=process.env.CODEX_THREAD_ID||process.env.CODEX_SESSION_ID;
    await call('ack_run_context',{context_hash:context.context_hash,...(session?{session_id:session}:{})});
    result=context.state.run_status==='running'?{already_started:true,context}:{receipt:await call('report_run_activity',{event_id:'agent-start-'+crypto.randomUUID(),event_type:'started',data:{message:'已获取当前任务上下文并接单',...(session?{session_id:session}:{})}}),context};
  }else if(action==='report'){
    const input=JSON.parse(readBounded(path.resolve(arg),1024*1024).toString('utf8'));
    const event_id=input.event_id||'agent-'+crypto.createHash('sha256').update(run+JSON.stringify(input)).digest('hex');
    result=await call('report_run_activity',{event_id,event_type:input.event_type,data:input.data});
  }else if(action==='wait')result=await call('wait_run_update',{after_revision:Number(arg)||0,timeout_ms:25000});
  else if(action==='closeout'){const input=JSON.parse(readBounded(path.resolve(arg),1024*1024).toString('utf8'));result=await call('complete_run_closeout',{...input,event_id:input.event_id||'closeout-'+crypto.createHash('sha256').update(run+JSON.stringify(input)).digest('hex')});}
  else if(action==='deployment')result=await call('report_runtime_deployment',{manifest_sha256:arg});
  else throw Error('不支持的动作');
  console.log(JSON.stringify(result,null,2));if(result.disposition&&result.disposition!=='applied')process.exitCode=1;
}catch(error){console.error((error as Error).message);process.exitCode=1;}
