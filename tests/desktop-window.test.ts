import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from 'playwright';
import {ROOT} from '../src/core/config.ts';

test('桌面最小化到任务栏、关闭到托盘、恢复同一窗口、托盘退出释放后台', {skip:process.platform!=='win32',timeout:180000}, async()=>{
  const root=path.join(ROOT,'.test-tmp','desktop-window-'+randomUUID());
  fs.mkdirSync(path.join(root,'config'),{recursive:true});
  for(const name of ['src','scripts','migrations','dist','desktop'])fs.cpSync(path.join(ROOT,name),path.join(root,name),{recursive:true});
  fs.copyFileSync(path.join(ROOT,'package.json'),path.join(root,'package.json'));
  fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(root,'node_modules'),'junction');
  const socket=net.createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));
  const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
  fs.writeFileSync(path.join(root,'config/local.json'),JSON.stringify({dataDir:'data',port,authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}}));
  const executablePath=process.env.WORKBENCH_DESKTOP_EXECUTABLE||path.join(ROOT,'node_modules/electron/dist/electron.exe');
  const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:path.join(root,'data'),WORKBENCH_PORT:String(port),WORKBENCH_NODE:process.execPath,WORKBENCH_SKIP_INTEGRATIONS:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop=await electron.launch({executablePath,args:process.env.WORKBENCH_DESKTOP_EXECUTABLE?[]:[path.join(ROOT,'desktop/main.cjs')],cwd:ROOT,env:env as Record<string,string>,timeout:20000});
  const health=async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(2000)});assert(r.ok);return r.json() as Promise<{pid:number}>};
  const waitFor=async(fn:()=>Promise<boolean>)=>{for(let i=0;i<60;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}assert.fail('Desktop state did not settle')};
  let exited=false;
  try{
    const page=await desktop.firstWindow();await page.waitForURL(`http://127.0.0.1:${port}/`,{timeout:70000});
    await page.locator('nav').getByRole('button',{name:'今天',exact:true}).waitFor();
    const first=await desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {id:w.id,visible:w.isVisible()}});
    assert(first.visible);const backend=await health();
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
    await waitFor(()=>desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()));
    // On Windows isVisible() is false for a normal minimized window too.
    assert.deepEqual(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>w.id)),[first.id]);
    assert.equal((await health()).pid,backend.pid);
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
    await waitFor(()=>desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return !w.isMinimized()&&w.isVisible()}));
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await waitFor(()=>desktop.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isVisible()));
    assert.equal((await health()).pid,backend.pid);
    assert(await desktop.evaluate(({app})=>!process.getBuiltinModule('module').createRequire(app.getAppPath()+'/main.cjs')('./main.cjs').getTray().isDestroyed()));
    await desktop.evaluate(({app})=>process.getBuiltinModule('module').createRequire(app.getAppPath()+'/main.cjs')('./main.cjs').getTrayMenu().getMenuItemById('open-workbench').click());
    await waitFor(()=>desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
    assert.deepEqual(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>w.id)),[first.id]);
    await page.goto(`http://127.0.0.1:${port}/#/requests`);
    await page.getByRole('heading',{name:'需求箱',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'提需求',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'新建需求',exact:true}).count(),0);
    await page.getByRole('button',{name:'提需求',exact:true}).click();
    await page.getByRole('dialog',{name:'提一个需求'}).getByRole('button',{name:'取消',exact:true}).click();
    const evidence=process.env.WORKBENCH_EVIDENCE_DIR;
    if(evidence){
      fs.mkdirSync(evidence,{recursive:true});
      const pixels=await desktop.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(evidence,'隔离桌面-需求箱单一入口.png'),Buffer.from(pixels,'base64'));
    }
    const closed=desktop.waitForEvent('close');
    await desktop.evaluate(({app})=>{setTimeout(()=>process.getBuiltinModule('module').createRequire(app.getAppPath()+'/main.cjs')('./main.cjs').getTrayMenu().getMenuItemById('quit-workbench').click(),50)});
    await closed;exited=true;
    await assert.rejects(health());assert.throws(()=>process.kill(backend.pid,0));
    const events=fs.readFileSync(path.join(root,'data/desktop-lifecycle.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).event);
    assert(events.includes('minimized_to_taskbar'));assert(events.includes('closed_to_tray'));assert.equal(events.at(-1),'exited');
    if(evidence)fs.copyFileSync(path.join(root,'data/desktop-lifecycle.jsonl'),path.join(evidence,'隔离桌面-生命周期.jsonl'));
  }finally{if(!exited)await desktop.close();}
});
