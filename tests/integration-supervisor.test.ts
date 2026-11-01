import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import vm from 'node:vm';
import {ROOT} from '../src/core/config.ts';

const {createIntegrationSupervisor}=createRequire(import.meta.url)('../desktop/lifecycle.cjs');
function supervisor(run:()=>Promise<string>) {
  const powerMonitor=new EventEmitter(), logs:any[]=[];
  let tick:()=>void=()=>{},cleared=false,delay=0;
  const control=createIntegrationSupervisor({run,powerMonitor,log:(...args:any[])=>logs.push(args),
    setIntervalFn:(fn:()=>void,ms:number)=>{tick=fn;delay=ms;return {unref(){}}},clearIntervalFn:()=>{cleared=true}});
  return {control,powerMonitor,logs,tick:()=>tick(),cleared:()=>cleared,delay:()=>delay};
}
test('常驻巡检为60秒单flight，resume复用当前启动，退出撤销触发并等待启动结束',async()=>{
  let release!:(v:string)=>void,calls=0;
  const s=supervisor(()=>{calls++;return new Promise(resolve=>{release=resolve})});
  assert.equal(s.delay(),60000);
  const first=s.control.poll();await Promise.resolve();
  s.tick();s.powerMonitor.emit('resume');assert.equal(s.control.poll(),first);assert.equal(calls,1);
  let stopped=false;const stopping=s.control.stop().then(()=>{stopped=true});
  assert(s.cleared());assert.equal(s.powerMonitor.listenerCount('resume'),0);
  s.tick();s.powerMonitor.emit('resume');await s.control.poll();assert.equal(calls,1);assert.equal(stopped,false);
  release('ready');await stopping;assert(stopped);await s.control.poll();assert.equal(calls,1);
});
test('重复失败不刷日志，成功恢复与再次失败保留各自变化',async()=>{
  let broken=true,calls=0;
  const s=supervisor(async()=>{calls++;if(broken)throw new Error('same synthetic failure');return 'ready'});
  await s.control.poll();s.tick();await s.control.poll();s.powerMonitor.emit('resume');await s.control.poll();
  assert.equal(calls,3);assert.equal(s.logs.length,1);
  broken=false;await s.control.poll();await s.control.poll();assert.equal(s.logs.length,2);
  broken=true;await s.control.poll();assert.equal(s.logs.length,3);await s.control.stop();
});
test('桌面退出先撤销resume并等当前启动，然后才清理自管服务，之后不能复活',async()=>{
  const root=path.join(ROOT,'.test-tmp','integration-main-'+randomUUID()),powerMonitor=new EventEmitter(),order:string[]=[],children:any[]=[];
  const app:any=new EventEmitter();Object.assign(app,{isPackaged:false,setName(){},setAppUserModelId(){},setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),exit:()=>order.push('app-exit')});
  const backend:any=new EventEmitter();Object.assign(backend,{pid:12001,exitCode:null});
  class Window extends EventEmitter {
    webContents:any=Object.assign(new EventEmitter(),{session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}}});
    async loadFile(){}async loadURL(){}isDestroyed(){return false}hide(){}isMinimized(){return false}show(){}focus(){}
  }
  class Tray extends EventEmitter {setToolTip(){}setContextMenu(){}destroy(){order.push('tray-destroy')}}
  const shell={openPath:async()=>''},electron={app,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:()=>({}),setApplicationMenu(){}},nativeImage:{createFromPath(){}},dialog:{showErrorBox(){assert.fail('unexpected desktop error')}},screen:{},ipcMain:{},shell,powerMonitor};
  let healthCalls=0;
  const module={exports:{} as any};
  const dependencies:any={electron,'./lifecycle.cjs':{createIntegrationSupervisor,stopBackend:async()=>order.push('backend-stop')},'./external-links.cjs':{installExternalLinks(){}},'./updater.cjs':{installUpdater:()=>({markReady(){}})},'node:child_process':{
    fork:()=>backend,spawn:(_exe:string,args:string[])=>{const child:any=new EventEmitter();child.stderr=new PassThrough();child.stdout=new PassThrough();child.args=args;children.push(child);order.push(args.some(a=>a.endsWith('停止数据服务.ps1'))?'cleanup-spawn':'startup-spawn');return child;}
  }};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT,'desktop/main.cjs'),'utf8'),{require:(id:string)=>dependencies[id]||createRequire(import.meta.url)(id),module,__dirname:path.join(ROOT,'desktop'),process:{env:{WORKBENCH_ROOT:root,WORKBENCH_NODE:process.execPath},argv:[]},fetch:async()=>++healthCalls===1?{ok:false}:{json:async()=>({app:'agent-workbench',pid:backend.pid})},AbortSignal,setTimeout});
  for(let i=0;i<30&&!children.length;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(children.length,1);assert.equal(powerMonitor.listenerCount('resume'),1);
  const stopping=module.exports.stopForUpdate();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(powerMonitor.listenerCount('resume'),0);assert.deepEqual(order,['startup-spawn']);
  powerMonitor.emit('resume');assert.equal(children.length,1);
  children[0].emit('close',0);
  for(let i=0;i<30&&children.length<2;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(children.length,2);assert.deepEqual(order,['startup-spawn','backend-stop','cleanup-spawn']);
  assert(children[1].args.includes('-OwnerId'));children[1].emit('close',0);await stopping;
  powerMonitor.emit('resume');await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,2);assert.equal(order.at(-1),'app-exit');
});

// Every PowerShell command that could touch processes or connections is replaced
// by a fixture function. The script itself is copied to a project-local temp root.
const mock=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fixture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$global:fixtureProcesses=@{}
foreach($item in $fixture.processes) { $global:fixtureProcesses[[int]$item.pid]=[pscustomobject]@{ProcessId=$item.pid;ExecutablePath=$item.exe;CommandLine=$item.command;CreationDate=[datetime]::Parse($item.created).ToUniversalTime()} }
function Add-Call($value) { $value | ConvertTo-Json -Compress -Depth 6 | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.jsonl') -Encoding UTF8 }
function Get-NetTCPConnection { [CmdletBinding()]param($State,$LocalPort)
  Add-Call @{op='listeners';port=$LocalPort}
  foreach($item in $fixture.listeners) { if($item.port -eq $LocalPort) { [pscustomobject]@{OwningProcess=$item.pid;LocalAddress=$item.address} } }
}
function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter)
  $processId=[int]($Filter -replace '^ProcessId = ','');Add-Call @{op='process';pid=$processId};$global:fixtureProcesses[$processId]
}
function Stop-Process { throw 'TEST FAILURE: no service may be killed' }
function Start-Process { [CmdletBinding()]param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
  Add-Call @{op='start';exe=$FilePath;arguments=$ArgumentList;stdout=$RedirectStandardOutput;stderr=$RedirectStandardError;hidden=$WindowStyle;auth=$env:AGENTSVIEW_AUTH_TOKEN;telemetry=$env:AGENTSVIEW_TELEMETRY_ENABLED}
  if(($fixture.failToken -and $FilePath -eq $env:WORKBENCH_NODE) -or ($fixture.failAgents -and $FilePath -like '*agentsview.exe')) { throw 'synthetic spawn failure' }
  $processId=7000+$global:fixtureProcesses.Count
  $global:fixtureProcesses[$processId]=[pscustomobject]@{ProcessId=$processId;ExecutablePath=$FilePath;CommandLine=($ArgumentList -join ' ');CreationDate=[datetime]::Parse('2026-11-01T00:00:00Z').ToUniversalTime()}
  [IO.File]::WriteAllText($RedirectStandardOutput,'synthetic stdout');[IO.File]::WriteAllText($RedirectStandardError,'synthetic stderr')
  [pscustomobject]@{Id=$processId}
}
& (Join-Path $PSScriptRoot 'scripts\启动数据服务.ps1') -OwnerId 'fixture-owner'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
`;
const readJson=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function fixture(options:any={}) {
  const root=path.join(ROOT,'.test-tmp','integration-supervisor-'+randomUUID()),data=path.join(root,'data'),integrations=path.join(data,'integrations');
  fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(path.join(root,'scripts'));
  fs.mkdirSync(integrations,{recursive:true});
  fs.copyFileSync(path.join(ROOT,'scripts/启动数据服务.ps1'),path.join(root,'scripts/启动数据服务.ps1'));
  fs.writeFileSync(path.join(root,'fixture.ps1'),'\uFEFF'+mock);
  fs.writeFileSync(path.join(root,'fixture-secret.txt'),'synthetic-test-secret');
  const settings={integrations:{tokenMonitor:{managed:true,baseUrl:'http://127.0.0.1:48123'},agentsView:{managed:true,baseUrl:'http://127.0.0.1:48124',secretFile:'fixture-secret.txt'}}};
  const writeSettings=()=>fs.writeFileSync(path.join(root,'config/local.json'),JSON.stringify(settings));writeSettings();
  let state:any={processes:[],listeners:[],...options};
  const node=path.join(root,'fixture-node.exe');
  const calls=()=>fs.existsSync(path.join(root,'calls.jsonl'))?fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').replace(/\uFEFF/g,'').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[];
  const run=(patch:any={})=>{
    state={...state,...patch};fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify(state));writeSettings();
    return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'fixture.ps1')],{
      cwd:root,windowsHide:true,encoding:'utf8',timeout:15000,env:{...process.env,TEMP:root,TMP:root,WORKBENCH_NODE:node,WORKBENCH_DATA_DIR:data}});
  };
  const record=(name='token-monitor',patch:any={})=>{
    const value={owner:'previous-desktop',pid:6000,root,exe:name==='token-monitor'?node:path.join(integrations,'agentsview/bin/agentsview.exe'),identity:name==='token-monitor'?path.join(root,'scripts/token-monitor-hub.cjs'):'serve --host 127.0.0.1',created:'2026-11-01T00:00:00Z',port:name==='token-monitor'?48123:48124,...patch};
    fs.writeFileSync(path.join(integrations,name+'-process.json'),JSON.stringify(value));return value;
  };
  return {root,integrations,settings,run,calls,record};
}
const windows={skip:process.platform!=='win32',timeout:120000};
test('两源各自启动：首源异常仍启动第二源；第二源异常不撤销第一源',windows,()=>{
  for(const failed of ['failToken','failAgents']) {
    const f=fixture({[failed]:true}),r=f.run();assert.equal(r.status,1,r.stderr);
    const starts=f.calls().filter(c=>c.op==='start');assert.equal(starts.length,2);
    assert(starts.every(c=>c.hidden==='Hidden'));assert.match(r.stderr,/synthetic spawn failure/);
    const successful=failed==='failToken'?'agentsview':'token-monitor';
    assert.equal(readJson(path.join(f.integrations,successful+'-process.json')).owner,'fixture-owner');
    assert.equal(starts[1].auth,'synthetic-test-secret');assert.equal(starts[1].telemetry,'0');
  }
});
test('非managed源不查询端口、不启动、不读取凭据或接管已有记录',windows,()=>{
  const f=fixture();f.settings.integrations.tokenMonitor.managed=false;f.settings.integrations.agentsView.managed=false;
  fs.writeFileSync(path.join(f.integrations,'token-monitor-process.json'),'malformed record');
  f.settings.integrations.agentsView.secretFile='missing-secret';
  const r=f.run();assert.equal(r.status,0,r.stderr);assert.deepEqual(f.calls(),[]);
});
test('跨桌面重启可恢复合法死owned记录，保留前owner、PID和既有日志',windows,()=>{
  const f=fixture();f.settings.integrations.agentsView.managed=false;
  const previous=f.record();fs.mkdirSync(path.join(f.integrations,'logs'));fs.writeFileSync(path.join(f.integrations,'logs/token-monitor.log'),'old log preserved');
  const r=f.run();assert.equal(r.status,0,r.stderr);
  const next=readJson(path.join(f.integrations,'token-monitor-process.json'));
  assert.equal(next.owner,'fixture-owner');assert.equal(next.previousOwner,previous.owner);
  assert.equal(fs.readFileSync(path.join(f.integrations,'logs/token-monitor.log'),'utf8'),'old log preserved');
  const log=readJson(path.join(f.integrations,'service-lifecycle.jsonl'));assert.equal(log.previousOwner,previous.owner);assert.equal(log.previousPid,previous.pid);
});
test('活服务无listener仍保留、异owner不接管；合法listener也不重复启动',windows,()=>{
  for(const listening of [false,true]) {
    const f=fixture();f.settings.integrations.agentsView.managed=false;
    const record=f.record(),before=fs.readFileSync(path.join(f.integrations,'token-monitor-process.json'),'utf8');
    const r=f.run({processes:[{pid:record.pid,exe:record.exe,command:record.identity,created:record.created}],listeners:listening?[{port:48123,pid:record.pid,address:'127.0.0.1'}]:[]});
    assert.equal(r.status,0,r.stderr);assert.equal(f.calls().filter(c=>c.op==='start').length,0);
    assert.equal(fs.readFileSync(path.join(f.integrations,'token-monitor-process.json'),'utf8'),before);assert.match(r.stdout,/未接管/);
  }
});
test('root/exe/identity/port/created不匹配及PID复用、未知或非loopback监听一律拒绝',windows,()=>{
  for(const kind of ['root','exe','identity','port','created','pid-reused','unknown-listener','wrong-address','wrong-listener-pid']) {
    const f=fixture();f.settings.integrations.agentsView.managed=false;
    const patch:any={};if(['root','exe','identity'].includes(kind))patch[kind]='unexpected';if(kind==='port')patch.port=9999;if(kind==='created')patch.created='malformed';
    const record=kind==='unknown-listener'?null:f.record('token-monitor',patch);
    let processes:any[]=[],listeners:any[]=[];
    if(['pid-reused','wrong-address','wrong-listener-pid'].includes(kind))processes=[{pid:6000,exe:record!.exe,command:record!.identity,created:kind==='pid-reused'?'2026-11-01T01:00:00Z':record!.created}];
    if(['unknown-listener','wrong-address','wrong-listener-pid'].includes(kind))listeners=[{port:48123,pid:kind==='wrong-listener-pid'?7777:6000,address:kind==='wrong-address'?'0.0.0.0':'127.0.0.1'}];
    const r=f.run({processes,listeners});assert.equal(r.status,1,kind+': '+r.stderr);assert.equal(f.calls().filter(c=>c.op==='start').length,0,kind);
  }
});
test('每源5分钟最多3次启动，失败亦计数；冷却后恢复，重启日志各自保留',windows,()=>{
  const f=fixture();f.settings.integrations.agentsView.managed=false;
  for(let i=0;i<3;i++){const r=f.run();assert.equal(r.status,0,r.stderr)}
  const refused=f.run();assert.equal(refused.status,1);assert.match(refused.stderr,/5 分钟最多 3 次/);assert.equal(f.calls().filter(c=>c.op==='start').length,3);
  const budgetFile=path.join(f.integrations,'token-monitor-recovery.json'),budget=readJson(budgetFile);
  assert.equal(budget.attempts.length,3);budget.attempts=budget.attempts.map(()=>new Date(Date.now()-301000).toISOString());fs.writeFileSync(budgetFile,JSON.stringify(budget));
  const recovered=f.run();assert.equal(recovered.status,0,recovered.stderr);assert.equal(f.calls().filter(c=>c.op==='start').length,4);
  assert.equal(fs.readdirSync(path.join(f.integrations,'logs')).length,8);
  const failing=fixture({failToken:true});failing.settings.integrations.agentsView.managed=false;
  for(let i=0;i<4;i++)assert.equal(failing.run().status,1);
  assert.equal(failing.calls().filter(c=>c.op==='start').length,3);
});
