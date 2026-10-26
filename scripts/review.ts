import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from '../src/core/config.ts';
import {reviewId,reviewResultInput} from '../src/core/review-workflow.ts';
import {readBounded,safePath} from '../src/core/security.ts';
import {reviewReportFile} from '../src/core/native-review-result.ts';

const c=loadConfig(),[assignment,action,arg,extra]=process.argv.slice(2);
reviewId.parse(assignment);
const credential=safePath(path.join(c.dataDir,'review-keys',assignment+'.json'),[c.dataDir]);
const {token}=JSON.parse(fs.readFileSync(credential,'utf8'));
const call=async(tool:string,input:unknown)=>{
  const response=await fetch(`http://127.0.0.1:${c.port}/api/mcp/${tool}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...input as object,review_id:assignment}),signal:AbortSignal.timeout(120000)});
  const body=await response.json();if(!response.ok)throw new Error((body as any).error||'回传失败');return body;
};
try{
  let result:unknown;
  if(action==='manage'){
    if(!arg||!extra)throw Error('用法：review.ts <审查单ID> manage <管理或读取工具名> <JSON文件>');
    result=await call(arg,JSON.parse(readBounded(path.resolve(extra),1024*1024).toString('utf8')));
  }else if(action==='context')result=await call('get_review_assignment',{review_id:assignment,...(arg?{mode:'delta',known_context_hash:arg}:{mode:'brief'})});
  else if(action==='ack')result=await call('ack_review_context',{review_id:assignment,context_hash:arg});
  else if(action==='read')result=await call('read_review_context_file',{...JSON.parse(readBounded(path.resolve(arg),64*1024).toString('utf8')),review_id:assignment});
  else if(action==='started'){
    const context:any=arg?null:await call('get_review_assignment',{review_id:assignment,mode:'brief'});
    result=await call('report_review_started',{review_id:assignment,identity:arg||context.assignment.reviewer_id,
      ...(process.env.WORKBENCH_NATIVE_SESSION_ID?{session_id:process.env.WORKBENCH_NATIVE_SESSION_ID}:{}),...(process.env.WORKBENCH_ACTUAL_MODEL?{actual_model:process.env.WORKBENCH_ACTUAL_MODEL}:{})});
  }
  else if(action==='submit'){
    const input=reviewReportFile(readBounded(path.resolve(arg),512*1024).toString('utf8')) as Record<string,unknown>;
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('结果文件必须包含一份审查报告');
    if(input.review_id&&input.review_id!==assignment)throw Error('结果文件属于另一张审查单');
    result=input.task_id||input.run_id?await call('submit_review_result',reviewResultInput.parse({...input,review_id:assignment})):await call('submit_review_report',{...input,review_id:assignment});
  }else throw Error('用法：review <审查单ID> context [known_hash] | ack <hash> | read <请求JSON路径> | started <AgentID> | submit <结果JSON路径>');
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error((error as Error).message);process.exitCode=1}
