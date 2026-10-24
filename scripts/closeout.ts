import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from '../src/core/config.ts';
import {closeoutInput} from '../src/core/closeout.ts';
import {eventSchema} from '../src/core/schema.ts';
import {safePath,readBounded} from '../src/core/security.ts';
const c=loadConfig(),[rid,action,arg]=process.argv.slice(2);
closeoutInput.parse({run_id:rid});
const {token}=JSON.parse(fs.readFileSync(safePath(path.join(c.dataDir,'run-keys',rid+'.json'),[c.dataDir]),'utf8'));
async function call(tool:string,input:unknown){
  const res=await fetch(`http://127.0.0.1:${c.port}/api/mcp/${tool}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
  const data:any=await res.json();if(!res.ok)throw Error(data.error||'回传失败');return data;
}
try{
  let result:any;
  if(action==='context')result=await call('get_closeout_context',{run_id:rid});
  else if(action==='started'){
    const ctx=await call('get_closeout_context',{run_id:rid});
    if(ctx.closeout.id!==arg)throw Error('收尾单已更新，请使用最新收尾单');
    result=await call('report_run_event',{schema_version:1,event_id:'EV-'+crypto.randomUUID(),task_id:ctx.task_id,run_id:rid,task_version:ctx.task_version,seq:ctx.next_seq,event_type:'closeout_started',occurred_at:new Date().toISOString(),data:{identity:ctx.agent_id,cwd:ctx.cwd,closeout_id:arg,message:'已读取收尾单，开始执行收尾'}});
  }else if(action==='submit'){
    const e=eventSchema.parse(JSON.parse(readBounded(path.resolve(arg),512*1024).toString('utf8')));
    if(e.run_id!==rid||!e.event_type.startsWith('closeout_'))throw Error('请提交当前执行的收尾回执');
    result=await call('report_run_event',e);
  }else throw Error('用法：closeout.ts <Run ID> context | started <收尾单ID> | submit <回执文件>');
  console.log(JSON.stringify(result,null,2));if(result.disposition&&result.disposition!=='applied')process.exitCode=1;
}catch(e){console.error((e as Error).message);process.exitCode=1}
