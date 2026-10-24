import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ROOT} from '../src/core/config.ts';

test('工程与正式数据分开：相对配置基于工程目录，环境变量优先，调用目录不影响结果',()=>{
 const folder=path.join(ROOT,'.test-tmp','layout-'+crypto.randomUUID()),engine=path.join(folder,'工程');
 fs.mkdirSync(path.join(engine,'config'),{recursive:true});
 fs.writeFileSync(path.join(engine,'config/local.json'),JSON.stringify({dataDir:'../正式数据'}));
 const script=`import {loadConfig} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'src/core/config.ts')).href)};console.log(JSON.stringify(loadConfig()));`;
 const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_ROOT:engine};delete env.WORKBENCH_DATA_DIR;
 const read=(extra:Record<string,string>={})=>JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:ROOT,env:{...env,...extra},windowsHide:true,encoding:'utf8'}));
 assert.equal(read().dataDir,path.join(folder,'正式数据'));
 assert.equal(read({WORKBENCH_DATA_DIR:'../隔离数据'}).dataDir,path.join(folder,'隔离数据'));
 assert(!fs.existsSync(path.join(engine,'data')));
});

test('PowerShell 5 与 7 的 JSON 时间类型都能验证受管进程时间',()=>{
 const dir=path.join(ROOT,'.test-tmp','owner-time-'+crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
 const script=path.join(dir,'verify.ps1');
 fs.writeFileSync(script,"$record = '{\"created\":\"2026-10-21T10:19:48.5793800Z\"}' | ConvertFrom-Json\n$expected = [DateTime]::Parse('2026-10-21T10:19:48.5793800Z').ToUniversalTime()\nif ($expected.Ticks -ne ([DateTimeOffset]$record.created).UtcDateTime.Ticks) { throw 'Identity mismatch' }\nWrite-Output 'ok'\n");
 for(const shell of ['powershell.exe','pwsh.exe'])assert.equal(execFileSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,encoding:'utf8'}).trim(),'ok');
});
