import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import net from 'node:net';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {_electron as electron} from 'playwright';
import {ROOT} from '../src/core/config.ts';
const source=process.env.WORKBENCH_PORTABLE_STAGE,archive=process.env.WORKBENCH_UPDATE_ZIP;
test('完整便携包：模拟旧版检查、下载校验、退出换包、重启及数据保留', {skip:!source||!archive,timeout:240000},async()=>{
  const root=path.join(ROOT,'.test-tmp','便携升级 空格 '+crypto.randomUUID());fs.cpSync(source!,root,{recursive:true});
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  // This is explicitly a synthetic previous version using the same update protocol.
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));pkg.version='0.1.3';fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(pkg));
  fs.writeFileSync(path.join(root,'portable-release.json'),JSON.stringify({schema:1,product:'Houraiji9/agent-workbench',version:'0.1.3'}));
  fs.writeFileSync(path.join(root,'src','obsolete-update-test.txt'),'fixture old file');
  const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));
  const config=JSON.stringify({port,dataDir:'data',timezone:'UTC',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}});
  fs.writeFileSync(path.join(root,'config/local.json'),config);
  fs.mkdirSync(path.join(root,'.agent-workbench','fixture'),{recursive:true});fs.writeFileSync(path.join(root,'.agent-workbench/fixture/keep.txt'),'preserve execution fixture');
  fs.mkdirSync(path.join(root,'.codex'));fs.writeFileSync(path.join(root,'.codex/config.toml'),'# preserve project MCP fixture');
  const env={...process.env,WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:path.join(root,'data'),WORKBENCH_PORT:String(port),WORKBENCH_SKIP_INTEGRATIONS:'1',PATH:process.env.SystemRoot+'\\System32'};delete (env as any).ELECTRON_RUN_AS_NODE;
  const exe=path.join(root,'桌面版/工作台/工作台.exe'),base=`http://127.0.0.1:${port}`;
  const desktop=await electron.launch({executablePath:exe,args:[],cwd:root,env:env as Record<string,string>,timeout:30000});
  let quit=false;
  const evidence=process.env.WORKBENCH_EVIDENCE_DIR||path.join(ROOT,'.test-tmp','update-evidence');fs.mkdirSync(evidence,{recursive:true});
  try{
    const page=await desktop.firstWindow();await page.waitForURL(base+'/',{timeout:30000});
    const bootResponse=await fetch(base+'/api/bootstrap'),boot:any=await bootResponse.json();const headers={'Cookie':bootResponse.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'Origin':base,'x-workbench-csrf':boot.csrf,'Content-Type':'application/json'};
    const res=await fetch(base+'/api/requests',{method:'POST',headers,body:JSON.stringify({project_id:'P-workbench',text:'隔离升级测试：这条需求需要保留'})});assert(res.ok);const request:any=await res.json();
    const keyHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'data/keys.json'))).digest('hex');
    const bytes=fs.statSync(archive!).size;const hash=crypto.createHash('sha256');for await(const b of fs.createReadStream(archive!))hash.update(b);const sha=hash.digest('hex');
    // Replace only network transport in the main-process test harness. Production has no endpoint override.
    await desktop.evaluate('globalThis.__name = (fn) => fn'); // tsx named-function helper used by serialized test callbacks.
    await desktop.evaluate(async({app,BrowserWindow,ipcMain},{root,base,archive,bytes,sha,version})=>{
      const req=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/main.cjs'),fs=req('node:fs'),path=req('node:path');
      const main=req('./main.cjs');ipcMain.removeHandler('workbench:update');
      const name=`AgentWorkbench-v${version}-portable.zip`,prefix=`https://github.com/Houraiji9/agent-workbench/releases/download/v${version}/`;
      req('./updater.cjs').installUpdater({win:BrowserWindow.getAllWindows()[0],ipcMain,root,base,dataDir:path.join(root,'data'),packaged:true,node:path.join(process.resourcesPath,'runtime/node.exe'),stop:main.stopForUpdate,openFolder:async()=>{},fetcher:async(url:string)=>{
        if(url.endsWith('/latest'))return new Response(JSON.stringify({tag_name:'v'+version,body:'隔离测试：使用本次真实候选包更新',assets:[{name,size:bytes,browser_download_url:prefix+name,digest:'sha256:'+sha},{name:'SHA256SUMS.txt',browser_download_url:prefix+'SHA256SUMS.txt'}]}));
        if(url.endsWith('.txt'))return new Response(sha+'  '+name);
        return new Response(req('node:stream').Readable.toWeb(fs.createReadStream(archive)));
      }});
    },{root,base,archive:archive!,bytes,sha,version});
    await page.locator('nav').getByRole('button',{name:'设置',exact:true}).click();
    const card=page.getByRole('region',{name:'软件更新'});await card.getByRole('button',{name:'检查更新'}).click();await card.getByRole('button',{name:'下载新版'}).click();
    for(let i=0;i<240;i++){const s:any=await page.evaluate(()=>(window as any).workbenchUpdates.status());if(s.status==='error')assert.fail(s.message);if(s.status==='downloaded')break;await new Promise(r=>setTimeout(r,500));}
    await card.getByRole('button',{name:'重启并更新'}).waitFor({timeout:3000});
    const captured=await desktop.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(evidence,'便携升级-下载核验完成.png'),Buffer.from(captured,'base64'));
    // The detached installer may outlive inherited diagnostic pipes on Windows; wait for process exit, not pipe closure.
    await card.getByRole('button',{name:'重启并更新'}).click();
    await page.getByRole('button',{name:'现在重启更新'}).click({noWaitAfter:true,timeout:10000}).catch(e=>{if(!String(e).includes('closed'))throw e;});quit=true;
    for(let i=0;i<120;i++){try{process.kill(desktop.process().pid!,0);}catch{break;}await new Promise(r=>setTimeout(r,250));}
    desktop.process().stdout?.destroy();desktop.process().stderr?.destroy();
    let result:any;
    for(let i=0;i<180;i++){try{result=JSON.parse(fs.readFileSync(path.join(root,'data/updates/last-result.json'),'utf8'));if(result.status==='error')assert.fail(result.message);if(result.status==='ready')break;}catch(e){if(!(e as any).code)throw e;}await new Promise(r=>setTimeout(r,500));}
    assert.equal(result?.status,'ready');assert.equal(result.version,version);
    const state:any=await(await fetch(base+'/api/bootstrap')).json();assert(state.requests.some((q:any)=>q.id===request.id));
    assert.equal(fs.readFileSync(path.join(root,'config/local.json'),'utf8'),config);
    assert.equal(fs.readFileSync(path.join(root,'.agent-workbench/fixture/keep.txt'),'utf8'),'preserve execution fixture');assert.equal(fs.readFileSync(path.join(root,'.codex/config.toml'),'utf8'),'# preserve project MCP fixture');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'data/keys.json'))).digest('hex'),keyHash);
    assert(!fs.existsSync(path.join(root,'src/obsolete-update-test.txt')));assert(fs.existsSync(path.join(result.jobDir,'before-update-data/workbench.sqlite')));
    fs.writeFileSync(path.join(evidence,'portable-update-result.json'),JSON.stringify({syntheticPreviousVersion:'0.1.3',installed:version,realPortableArchive:true,archiveSha256:sha,restarted:true,requestRetained:true,configRetained:true,keysRetained:true,executionPackageRetained:true,mcpRetained:true,obsoleteProgramRemoved:true,databaseSnapshot:true},null,2));
  }finally{
    if(!quit)await desktop.close();
    else{await promisify(execFile)(exe,['--quit'],{cwd:root,env,windowsHide:true});for(let i=0;i<50;i++){try{await fetch(base+'/api/health');}catch{break;}await new Promise(r=>setTimeout(r,100));}}
  }
});
