import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from '../src/core/config.ts';
import {reviewId,reviewResultInput} from '../src/core/review-workflow.ts';
import {readBounded,safePath} from '../src/core/security.ts';

const c=loadConfig(),[assignment,action,arg]=process.argv.slice(2);
reviewId.parse(assignment);
const credential=safePath(path.join(c.dataDir,'review-keys',assignment+'.json'),[c.dataDir]);
const {token}=JSON.parse(fs.readFileSync(credential,'utf8'));
const call=async(tool:string,input:unknown)=>{
  const response=await fetch(`http://127.0.0.1:${c.port}/api/mcp/${tool}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
  const body=await response.json();if(!response.ok)throw new Error((body as any).error||'回传失败');return body;
};
try{
  let result:unknown;
  if(action==='context')result=await call('get_review_assignment',{review_id:assignment});
  else if(action==='started')result=await call('report_review_started',{review_id:assignment,identity:arg});
  else if(action==='submit'){
    const parsed=reviewResultInput.parse(JSON.parse(readBounded(path.resolve(arg),512*1024).toString('utf8')));
    if(parsed.review_id!==assignment)throw Error('结果文件属于另一张审查单');
    result=await call('submit_review_result',parsed);
  }else throw Error('用法：npm run review -- <审查单ID> context | started <AgentID> | submit <结果JSON路径>');
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error((error as Error).message);process.exitCode=1}
