import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fork} from 'node:child_process';import {createRequire} from 'node:module';
import {ROOT} from '../src/core/config.ts';
const {stopBackend}=createRequire(import.meta.url)('../desktop/lifecycle.cjs');
test('Grok 第二轮回归：后台不响应 IPC 时，退出兜底清理整棵子进程树并等待退出',{skip:process.platform!=='win32'},async()=>{
 const dir=path.join(ROOT,'.test-tmp','desktop-timeout-'+randomUUID());fs.mkdirSync(dir,{recursive:true});
 const pidFile=path.join(dir,'child.json'),entry=path.join(dir,'unresponsive.cjs');
 fs.writeFileSync(entry,`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`);
 const backend=fork(entry,[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 for(let i=0;i<100&&!fs.existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,20));assert(fs.existsSync(pidFile));
 const child=JSON.parse(fs.readFileSync(pidFile,'utf8'));await stopBackend(backend,100);
 assert.throws(()=>process.kill(backend.pid!,0));assert.throws(()=>process.kill(child.pid,0));
});
