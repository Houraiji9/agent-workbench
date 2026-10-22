import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {createRequire} from 'node:module';
import {configure,inside} from '../scripts/configure-live-integrations.mjs';
import {ROOT} from '../src/core/config.ts';
import {fixture} from './helpers.ts';
import {Integrations} from '../src/integrations/adapters.ts';
const require=createRequire(import.meta.url);
const {createHub}=require('../vendor/token-monitor/src/hub/server.js');
function temp(){const root=path.join(ROOT,'.test-tmp','portable-'+crypto.randomUUID());fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.copyFileSync(path.join(ROOT,'config/example.json'),path.join(root,'config/example.json'));return root;}
const freePort=()=>new Promise<number>(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=(s.address() as net.AddressInfo).port;s.close(()=>resolve(p));});});
test('portable setup: nondefault install path, existing fields, stable key, no upstream settings or credentials access',async()=>{
 const root=temp(),desktopExe=path.join(root,'另一盘安装 空格','Token Monitor.exe');fs.mkdirSync(path.dirname(desktopExe));fs.writeFileSync(desktopExe,'Synthetic executable path fixture only');
 const original={port:14555,timezone:'UTC',integrations:{agentsView:{baseUrl:'https://example.invalid'}}};fs.writeFileSync(path.join(root,'config/local.json'),JSON.stringify(original));
 const result=await configure({root,desktopExe,port:await freePort()});assert.equal(result.settingsChanged,false);assert(!JSON.stringify(result).includes(fs.readFileSync(result.secretFile,'utf8')));
 const config=JSON.parse(fs.readFileSync(path.join(root,'config/local.json'),'utf8'));assert.equal(config.port,14555);assert.deepEqual(config.integrations.agentsView,original.integrations.agentsView);assert.equal(config.integrations.tokenMonitor.desktopExe,desktopExe);
 const key=fs.readFileSync(result.secretFile,'utf8');assert.equal(key.length,64);const repeat=await configure({root,desktopExe});assert.equal(repeat.baseUrl,result.baseUrl);assert.equal(fs.readFileSync(result.secretFile,'utf8'),key);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'data/integrations/private/workbench-config.before.json'),'utf8')),original);
});
test('portable setup: existing external connection and occupied requested port leave configuration intact',async()=>{
 const root=temp(),file=path.join(root,'config/local.json'),original=JSON.stringify({integrations:{tokenMonitor:{baseUrl:'http://127.0.0.1:17321',managed:false}}});fs.writeFileSync(file,original);
 await assert.rejects(()=>configure({root}),/已有 Token Monitor/);assert.equal(fs.readFileSync(file,'utf8'),original);assert(!fs.existsSync(path.join(root,'data')));
 const other=temp(),s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));try{await assert.rejects(()=>configure({root:other,port:(s.address() as net.AddressInfo).port}),/端口正在使用/);assert(!fs.existsSync(path.join(other,'config/local.json')));}finally{s.close();}
});
test('portable key boundary: outside files and directory junctions are rejected; adapter gives actionable message',async()=>{
 const root=temp(),data=path.join(root,'data'),outside=path.join(root,'outside');fs.mkdirSync(data);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'key'),'fixture');
 assert.throws(()=>inside(path.join(outside,'key'),data),/data/);fs.symlinkSync(outside,path.join(data,'redirect'),'junction');assert.throws(()=>inside(path.join(data,'redirect/key'),data),/data/);
 const {wb}=fixture();try{const file=path.join(wb.config.root,'key.txt');fs.writeFileSync(file,'test');wb.config.integrations.tokenMonitor={baseUrl:'http://127.0.0.1:1',secretFile:'key.txt'};assert.throws(()=>new Integrations(wb).headers('tokenMonitor'),/data.*secretFile/);}finally{wb.close();}
});
test('bundled official Hub: authenticated HTTP, subscriptions, SSE, persistence and loopback (synthetic upload)',async()=>{
 const {wb}=fixture(),port=await freePort(),secret=crypto.randomBytes(32).toString('hex'),dataFile=path.join(wb.config.dataDir,'integration-fixture/devices.json');
 const hub=createHub({host:'127.0.0.1',port,secret,syncSessionTitles:false,dataFile,logger:{log(){},warn(){},error(){}}});await hub.start();
 const baseUrl=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${secret}`,'content-type':'application/json'};
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  assert.equal((await fetch(baseUrl+'/api/stats')).status,401);
  const stream=await fetch(baseUrl+'/api/stats/stream',{headers,signal:controller.signal});assert.equal(stream.status,200);reader=stream.body!.getReader();const first=await reader.read();assert(Buffer.from(first.value!).toString().includes('event: snapshot'));
  const stamp=new Date().toISOString();const upload=await fetch(baseUrl+'/api/ingest',{method:'POST',headers,body:JSON.stringify({deviceId:'synthetic-release-test',updatedAt:stamp,limits:{updatedAt:stamp,providers:[{provider:'kimi',accountKey:'fixture-only',status:'ok',updatedAt:stamp,windows:[{kind:'weekly',usedPercent:40}]}]}})});assert.equal(upload.status,200);
  const event=await reader.read();assert(Buffer.from(event.value!).toString().includes('event: stats'));
  assert.equal((await fetch(baseUrl+'/api/subscriptions',{headers})).status,200);
  const key=path.join(wb.config.dataDir,'hub.key');fs.writeFileSync(key,secret);wb.config.integrations.tokenMonitor={baseUrl,secretFile:key};const i=new Integrations(wb);await i.refresh('tokenMonitor');assert.equal(wb.get('integrations','tokenMonitor').status,'connected');assert(wb.all('quota_windows').some(w=>w.remaining_percent===60));i.stop();
 }finally{controller.abort();await reader?.cancel().catch(()=>{});await hub.stop();wb.close();}
 const saved=JSON.parse(fs.readFileSync(dataFile,'utf8'));assert(saved.devices['synthetic-release-test']);
});
test('vendored official source and brand assets match their recorded hashes',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'vendor/token-monitor/source-manifest.json'),'utf8'));
 for(const entry of manifest.files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'vendor/token-monitor',entry.file))).digest('hex'),entry.sha256,entry.file);
 const icons=JSON.parse(fs.readFileSync(path.join(ROOT,'licenses/agent-icons.json'),'utf8'));
 for(const name of ['bolt','glm','grok-bot','lingma','zcode']){const entry=icons.files.find((i:any)=>i.name===name);const file=fs.readFileSync(path.join(ROOT,`src/web/assets/agents/${name}.${entry.ext}`));assert.equal(crypto.createHash('sha256').update(file).digest('hex'),entry.sha256);assert(!file.toString().includes('<text'));}
});
