import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {ROOT} from '../src/core/config.ts';import {managedCommand} from '../src/core/managed-command.ts';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
for(const mode of ['cancel','timeout'])test(`Grok 回归：${mode} 清理自己启动的整棵图解检查进程树`,{skip:process.platform!=='win32'},async()=>{
 const dir=path.join(ROOT,'.test-tmp','managed-'+randomUUID());fs.mkdirSync(dir,{recursive:true});
 const pidFile=path.join(dir,'child.json'),entry=path.join(dir,'parent.cjs');
 fs.writeFileSync(entry,`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`);
 const cmd=managedCommand(process.execPath,[entry],{cwd:dir},mode==='timeout'?1800:10000);
 const failed=assert.rejects(cmd.result,mode==='timeout'?/超时/:/取消/);
 for(let i=0;i<100&&!fs.existsSync(pidFile);i++)await delay(20);
 assert(fs.existsSync(pidFile));const child=JSON.parse(fs.readFileSync(pidFile,'utf8'));
 if(mode==='cancel')await cmd.cancel();await failed;
 assert.throws(()=>process.kill(child.pid,0));assert.throws(()=>process.kill(cmd.child.pid!,0));
});
