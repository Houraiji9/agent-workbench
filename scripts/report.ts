import fs from 'node:fs';import path from 'node:path';import {loadConfig} from '../src/core/config.ts';import {atomicWrite,signReceipt,hash,assert} from '../src/core/security.ts';import {eventSchema} from '../src/core/schema.ts';
const c=loadConfig();if(!process.argv[2])throw new Error('用法：npm run report -- <事件 JSON 文件>');
const e=eventSchema.parse(JSON.parse(fs.readFileSync(path.resolve(process.argv[2]),'utf8')));
assert(/^R-[a-f0-9-]{36}$/.test(e.run_id),'Run ID 格式无效');
const key=JSON.parse(fs.readFileSync(path.join(c.dataDir,'run-keys',e.run_id+'.json'),'utf8'));
if(process.argv.includes('--file')){if(!key.receipt_directory)throw new Error('此 Run 为旧版，请使用 HTTP 回报或新建 Run');atomicWrite(path.join(key.receipt_directory,hash(e.event_id)+'.json'),JSON.stringify({event:e,signature:signReceipt(e,key.token)},null,2));console.log('已生成带 Run 签名的原子回执文件。')}else{const res=await fetch(`http://127.0.0.1:${c.port}/api/mcp/report_run_event`,{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json'},body:JSON.stringify(e)});console.log(await res.text());if(!res.ok)process.exitCode=1;

}
