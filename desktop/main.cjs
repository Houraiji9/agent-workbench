const {stopBackend}=require('./lifecycle.cjs');
const {installExternalLinks}=require('./external-links.cjs');
const {installUpdater}=require('./updater.cjs');
const {app, BrowserWindow, Tray, Menu, nativeImage, dialog, screen, ipcMain, shell} = require('electron');
const {fork, spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The desktop runtime is replaceable; the project database always stays outside it.
const root = process.env.WORKBENCH_ROOT || (app.isPackaged
  ? path.resolve(__dirname, '../../../..')
  : path.resolve(__dirname, '..'));
const settings = fs.existsSync(path.join(root, 'config/local.json'))
  ? JSON.parse(fs.readFileSync(path.join(root, 'config/local.json'), 'utf8')) : {};
const dataDir = path.resolve(root, process.env.WORKBENCH_DATA_DIR || settings.dataDir || 'data');
const port = Number(process.env.WORKBENCH_PORT || settings.port || 4317);
const base = `http://127.0.0.1:${port}`;
const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime/node.exe') : process.env.WORKBENCH_NODE;
const owner = crypto.randomUUID();
let win, tray, trayMenu, backend, starting, booting, updater, quitting = false, ready = false;
app.setName('工作台');
app.setAppUserModelId('local.agent.workbench');
app.setPath('userData', path.join(dataDir, 'desktop-profile'));
const locked = app.requestSingleInstanceLock();
const log = (event, details = {}) => {
  fs.mkdirSync(dataDir, {recursive:true});
  fs.appendFileSync(path.join(dataDir, 'desktop-lifecycle.jsonl'), JSON.stringify({at:new Date().toISOString(),event,owner,...details})+'\n');
};

// 界面大小：大屏（宽度 ≥2300 逻辑像素）默认放大，Ctrl + 加号/减号/0 调整，并记在本机桌面配置里。
const zoomFile = path.join(dataDir, 'desktop-profile', 'ui-zoom.json');
let userZoom = (() => { try { const v = JSON.parse(fs.readFileSync(zoomFile, 'utf8')).zoom; return typeof v === 'number' && v >= 0.7 && v <= 2 ? v : null; } catch { return null; } })();
function autoZoom() {
  try { const w = (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()).workAreaSize.width; return w >= 3200 ? 1.35 : w >= 2300 ? 1.15 : 1; } catch { return 1; }
}
function applyZoom() { if (win && !win.isDestroyed()) win.webContents.setZoomFactor(userZoom ?? autoZoom()); }
function changeZoom(input) {
  const cur = userZoom ?? autoZoom(), k = input.key;
  let next;
  if (k === '=' || k === '+' || k === 'Add') next = Math.min(2, Math.round((cur + 0.1) * 10) / 10);
  else if (k === '-' || k === '_' || k === 'Subtract') next = Math.max(0.7, Math.round((cur - 0.1) * 10) / 10);
  else if (k === '0') next = null;
  else return false;
  userZoom = next;
  try { fs.mkdirSync(path.dirname(zoomFile), {recursive:true}); fs.writeFileSync(zoomFile, JSON.stringify({zoom:userZoom})); } catch {}
  applyZoom(); log('ui_zoom', {zoom: userZoom ?? autoZoom(), auto: userZoom === null});
  return true;
}
function restore() { if (!win || win.isDestroyed()) return; win.show(); if(win.isMinimized())win.restore(); win.focus(); }
function powershell(file, args = []) {
  return new Promise((resolve, reject) => {
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,file),...args],
      {cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,WORKBENCH_NODE:node,WORKBENCH_DATA_DIR:dataDir}});
    let error='';child.stderr.on('data', b=>error+=b.toString());
    child.on('error',reject);child.on('exit',code=>{child.stderr.destroy();code===0?resolve():reject(new Error(error.slice(-1500)||'本机数据服务未能启动'));});
  });
}
async function stop(afterStop) {
  if (quitting) return false;
  quitting=true;ready=false;log('exiting');
  if(win&&!win.isDestroyed())win.hide();
  // Explicit exit during indexing must wait before cleaning its owned children.
  await booting?.catch(()=>{});
  await starting?.catch(()=>{});
  try { await stopBackend(backend); }
  catch(e) { log('backend_cleanup_failed',{message:e.message});quitting=false;restore();dialog.showErrorBox('工作台尚未退出','后台未能结束，请稍后重试。现有进程未被当作退出成功。');return false; }
  if(!process.env.WORKBENCH_SKIP_INTEGRATIONS) {
    try { await powershell('scripts/停止数据服务.ps1',['-OwnerId',owner]); }
    catch(e) { log('cleanup_failed',{message:e.message});dialog.showErrorBox('部分数据服务未能退出', '为避免停止其他程序，工作台保留了无法确认身份的进程。请查看 data/desktop-lifecycle.jsonl。');if(afterStop){app.relaunch();tray?.destroy();app.exit(0);return false;} }
  }
  if(afterStop)try{await afterStop();}catch(e){log('update_launch_failed',{message:e.message});dialog.showErrorBox('更新未能启动','程序文件保持原样，将重新打开工作台。');app.relaunch();}
  tray?.destroy();log('exited');app.exit(0);
}
async function startBackend() {
  if(quitting)return;
  if(!node || !fs.existsSync(node))throw new Error('桌面运行环境缺失，请重新构建桌面版。');
  let occupied=false;
  try { const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1200)});occupied=r.ok; } catch {}
  if(occupied)throw new Error('工作台端口已被占用。请先关闭之前启动的独立后台，再打开桌面版。');
  if(quitting)return;
  const out=fs.openSync(path.join(dataDir,'desktop-server.log'),'a');
  backend=fork(path.join(root,'src/server/index.ts'),[],{execPath:node,execArgv:['--import','tsx'],cwd:root,
    env:{...process.env,WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:dataDir,WORKBENCH_PORT:String(port)},
    windowsHide:true,stdio:['ignore',out,out,'ipc']});fs.closeSync(out);
  backend.on('error',e=>log('backend_error',{message:e.message}));
  backend.on('exit',(code)=>{log('backend_exit',{code});if(ready&&!quitting){dialog.showErrorBox('工作台服务已退出','请重新打开工作台。项目数据保存在原目录。');void stop();}});
  // Cold starts and migrations can take longer on a busy disk. Bound elapsed
  // time, not the number of fast connection refusals, while preserving PID checks.
  const startupDeadline=Date.now()+60000;
  while(true) {
    if(quitting)return;
    if(backend.exitCode!==null)throw new Error('工作台服务启动失败，详情见 data/desktop-server.log。');
    try { const h=await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(700)})).json();
      if(h.app==='agent-workbench'&&h.pid===backend.pid){log('backend_ready',{pid:h.pid,port});break;}
    }catch{}
    if(Date.now()>=startupDeadline)throw new Error('启动超过 60 秒，详情见 data/desktop-server.log。');
    await new Promise(r=>setTimeout(r,200));
  }
  if(quitting)return;
  await win.loadURL(base);if(quitting)return;ready=true;log('window_ready');
  updater?.markReady();
  if(!process.env.WORKBENCH_SKIP_INTEGRATIONS) {
    // Optional sources never prevent access to the local ledger.
    starting=powershell('scripts/启动数据服务.ps1',['-OwnerId',owner]);
    starting.catch(e=>log('integrations_error',{message:e.message}));
  }
}
if(!locked || process.argv.includes('--quit')) app.quit();
else {
  app.on('second-instance',(_event,argv)=>{if(argv.includes('--quit'))void stop();else restore()});
  app.on('before-quit',e=>{e.preventDefault();void stop();});
  app.on('window-all-closed',()=>void stop());
  app.whenReady().then(async()=>{
    fs.mkdirSync(dataDir,{recursive:true});
    if(fs.existsSync(path.join(dataDir,'updates/install.lock'))){dialog.showErrorBox('更新尚未结束','请等待安装完成后再打开工作台。如果上次更新被中断，请保留程序文件夹，按 docs/UPDATES.md 恢复。');app.exit(0);return;}
    const icon=nativeImage.createFromPath(path.join(__dirname,'icon.png'));
    tray=new Tray(icon);tray.setToolTip('工作台');
    trayMenu=Menu.buildFromTemplate([{id:'open-workbench',label:'打开工作台',click:restore},{type:'separator'},{id:'quit-workbench',label:'退出工作台',click:()=>void stop()}]);
    tray.setContextMenu(trayMenu);
    tray.on('click',restore);tray.on('double-click',restore);
    win=new BrowserWindow({width:1360,height:900,minWidth:880,minHeight:600,title:'工作台',icon,
      backgroundColor:'#eef1f4',autoHideMenuBar:true,
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false,preload:path.join(__dirname,'preload.cjs')}});
    Menu.setApplicationMenu(null);
    win.on('minimize',()=>log('minimized_to_taskbar'));
    win.on('close',e=>{if(quitting)return;e.preventDefault();win.hide();log('closed_to_tray');});
    installExternalLinks({win,ipcMain,shell,dialog,base});
    updater=installUpdater({win,ipcMain,base,root,dataDir,packaged:app.isPackaged,node,stop,openFolder:async folder=>{const error=await shell.openPath(folder);if(error)throw Error('文件夹未能打开');}});
    win.webContents.on('did-finish-load',applyZoom);
    win.on('moved',()=>{if(userZoom===null)applyZoom()});
    win.webContents.on('before-input-event',(e,input)=>{if(input.type==='keyDown'&&(input.control||input.meta)&&!input.alt&&changeZoom(input))e.preventDefault();});
    win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==base)e.preventDefault();});
    const trustedMain=(wc,details)=>{try{return wc?.id===win.webContents.id&&details.isMainFrame&&new URL(details.requestingUrl).origin===base&&new URL(details.requestingUrl).pathname==='/'}catch{return false}};
    win.webContents.session.setPermissionRequestHandler((wc,permission,callback,details)=>callback(permission==='clipboard-sanitized-write'&&trustedMain(wc,details)));
    win.webContents.session.setPermissionCheckHandler((wc,permission,_origin,details)=>permission==='clipboard-sanitized-write'&&trustedMain(wc,details));
    await win.loadFile(path.join(__dirname,'loading.html'));
    try { booting=startBackend();await booting; } catch(e) { if(quitting)return;log('startup_failed',{message:e.message});dialog.showErrorBox('工作台未能打开',e.message);await stop(); }
  });
}

// Main-process diagnostics only; never exposed to the renderer.
module.exports={getTray:()=>tray,getTrayMenu:()=>trayMenu,stopForUpdate:stop};
