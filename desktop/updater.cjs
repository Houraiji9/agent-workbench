const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const {trustedPage}=require('./external-links.cjs');
const {PRODUCT,version,newer,plain,digest,writeJson,validateStage,checkInstallRoot}=require('./update-files.cjs');
const API='https://api.github.com/repos/'+PRODUCT+'/releases/latest';
const RELEASES='https://github.com/'+PRODUCT+'/releases';
const MAX_ZIP=1024*1024*1024;
function allowedUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('更新下载地址无效');
  if(u.hostname==='api.github.com'&&u.pathname===new URL(API).pathname)return u.href;
  if(u.hostname==='github.com'&&u.pathname.startsWith('/'+PRODUCT+'/releases/download/'))return u.href;
  if(['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))return u.href;
  throw Error('更新来源不是官方发布地址');
}
async function response(url,{fetcher=fetch,signal}={}) {
  for(let n=0;n<6;n++) {
    allowedUrl(url);
    const r=await fetcher(url,{redirect:'manual',signal,headers:{'User-Agent':'AgentWorkbench-Updater','Accept':'application/vnd.github+json'}});
    if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();url=new URL(r.headers.get('location'),url).href;continue;}
    if(!r.ok){await r.body?.cancel();throw Error(r.status===403||r.status===429?'GitHub 暂时限制检查次数，请稍后重试':'暂时无法连接 GitHub，请检查网络后重试');}
    return r;
  }throw Error('下载跳转次数过多');
}
async function small(url,limit,fetcher=fetch) {
  const r=await response(url,{fetcher,signal:AbortSignal.timeout(20000)});const chunks=[];let bytes=0;
  for await(const b of r.body){bytes+=b.length;if(bytes>limit)throw Error('更新信息过大');chunks.push(b);}
  return Buffer.concat(chunks).toString('utf8');
}
function releaseInfo(r) {
  if(r.draft||r.prerelease||typeof r.tag_name!=='string'||!/^v\d+\.\d+\.\d+$/.test(r.tag_name))throw Error('没有找到正式版更新');
  const v=r.tag_name.slice(1);version(v);
  const name=`AgentWorkbench-v${v}-portable.zip`,zip=r.assets?.find(a=>a.name===name),sums=r.assets?.find(a=>a.name==='SHA256SUMS.txt');
  for(const a of [zip,sums])if(!a||a.browser_download_url!==`${RELEASES}/download/v${v}/${a.name}`)throw Error('发布包尚未准备好，请稍后再试');
  if(!Number.isSafeInteger(zip.size)||zip.size<=0||zip.size>MAX_ZIP)throw Error('发布包大小无效');
  return {version:v,url:`${RELEASES}/tag/v${v}`,notes:typeof r.body==='string'?r.body.slice(0,8000):'',zip,sums};
}
function checksum(text,name) {
  const matches=text.split(/\r?\n/).map(l=>l.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).filter(m=>m&&m[2]===name);
  if(matches.length!==1)throw Error('发布包缺少有效校验值');return matches[0][1].toLowerCase();
}
async function download(release,file,onProgress,fetcher=fetch) {
  plain(file);const expected=checksum(await small(release.sums.browser_download_url,65536,fetcher),release.zip.name);
  const githubDigest=release.zip.digest;
  if(githubDigest&&githubDigest!=='sha256:'+expected)throw Error('发布校验值不一致');
  const part=file+'.partial';let bytes=0;const hash=crypto.createHash('sha256');
  try {
    const r=await response(release.zip.browser_download_url,{fetcher,signal:AbortSignal.timeout(20*60*1000)});
    const handle=await fs.promises.open(part,'wx');
    try { for await(const b of r.body){bytes+=b.length;if(bytes>release.zip.size)throw Error('下载包大小异常');hash.update(b);await handle.writeFile(b);onProgress(Math.floor(bytes/release.zip.size*100));} }finally{await handle.close();}
    if(bytes!==release.zip.size||hash.digest('hex')!==expected)throw Error('下载校验未通过，请重新下载');
    fs.renameSync(part,file);return expected;
  }catch(e){if(fs.existsSync(part))fs.unlinkSync(part);throw e;}
}
async function extract(archive,dest) {
  plain(archive);plain(dest);
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'update-extract.ps1'),'-Archive',archive,'-Destination',dest],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('更新包解压失败，请重新下载或检查磁盘空间')));});
}
function createUpdater({root,dataDir,packaged,platform=process.platform,arch=process.arch,node,stop,openFolder,fetcher=fetch}) {
  const current=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;version(current);
  const dir=path.join(dataDir,'updates');let supported=false;
  try { supported=packaged&&platform==='win32'&&arch==='x64'&&checkInstallRoot(root,dataDir).version===current; }catch{}
  let state={status:'idle',currentVersion:current,canInstall:supported,latestVersion:null,progress:0,message:'',releaseUrl:RELEASES,notes:''};
  let release=null,job=null,zipHash=null,busy=false;
  const get=()=>({...state});const set=patch=>{state={...state,...patch};return get();};
  const result=path.join(dir,'last-result.json');
  try{plain(result);const r=JSON.parse(fs.readFileSync(result,'utf8'));if(r.status==='ready'&&r.version===current)state.message='已更新至 v'+current;else if(r.status==='error')state.message=r.message;}catch{}
  async function action(kind) {
    if(busy)return get();busy=true;
    try {
      if(kind==='check') {
        set({status:'checking',message:'正在检查新版…',progress:0});release=null;job=null;zipHash=null;
        const info=releaseInfo(JSON.parse(await small(API,1024*1024,fetcher)));
        release=info;
        return set({status:newer(info.version,current)?'available':'current',latestVersion:info.version,releaseUrl:info.url,notes:info.notes,message:newer(info.version,current)?`发现新版本 v${info.version}`:'已经是最新版本'});
      }
      if(kind==='download') {
        if(!release||!newer(release.version,current))throw Error('请先检查更新');
        plain(dir);fs.mkdirSync(dir,{recursive:true});
        const jobDir=path.join(dir,crypto.randomUUID());fs.mkdirSync(jobDir);job={dir:jobDir,file:path.join(jobDir,release.zip.name)};
        set({status:'downloading',message:'正在下载新版…',progress:0});
        zipHash=await download(release,job.file,p=>set({progress:p}),fetcher);
        if(supported){set({status:'preparing',message:'正在检查安装文件…',progress:100});await extract(job.file,path.join(jobDir,'extracted'));await validateStage(path.join(jobDir,'extracted/AgentWorkbench'),release.version);}
        return set({status:'downloaded',message:supported?'新版已准备好':'便携包已下载，可在文件夹中查看',progress:100});
      }
      if(kind==='open-download') {
        if(!job||state.status!=='downloaded')throw Error('请先下载新版');plain(job.dir);await openFolder(job.dir);return get();
      }
      if(kind==='install') {
        if(!supported||state.status!=='downloaded'||!job)throw Error('请先下载官方便携版');
        checkInstallRoot(root,dataDir);if(await digest(job.file)!==zipHash)throw Error('下载文件已改变，请重新下载');
        const stage=path.join(job.dir,'extracted/AgentWorkbench');await validateStage(stage,release.version);
        for(const name of ['update-install.cjs','update-files.cjs'])fs.copyFileSync(path.join(__dirname,name),path.join(job.dir,name));
        fs.copyFileSync(node,path.join(job.dir,'node.exe'));
        writeJson(path.join(job.dir,'job.json'),{root,dataDir,stage,backup:path.join(job.dir,'previous-program'),version:release.version,parentPid:process.pid});
        set({status:'installing',message:'正在退出并安装更新…'});
        const ok=await stop(async()=>{
          const out=fs.openSync(path.join(job.dir,'install.log'),'a');
          const child=spawn(path.join(job.dir,'node.exe'),[path.join(job.dir,'update-install.cjs'),path.join(job.dir,'job.json')],{cwd:job.dir,detached:true,windowsHide:true,stdio:['ignore',out,out]});fs.closeSync(out);
          await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});child.unref();
        });
        if(ok===false)throw Error('工作台尚未完成退出，请稍后重试');return get();
      }
      throw Error('未知更新操作');
    }catch(e){return set({status:'error',message:e.message?.includes('fetch')||e.name==='TimeoutError'?'连接超时，请检查网络后重试':e.message||'更新未完成，请稍后重试'});}
    finally{busy=false;}
  }
  function markReady(){try{plain(result);if(fs.existsSync(result)){const r=JSON.parse(fs.readFileSync(result,'utf8'));if(r.status==='installed'&&r.version===current){writeJson(result,{...r,status:'ready'});set({message:'已更新至 v'+current});}}}catch{}}
  return {get,action,markReady};
}
function installUpdater({win,ipcMain,base,...options}) {
  const updater=createUpdater(options);
  ipcMain.handle('workbench:update',async(event,kind)=>{
    if(win.isDestroyed()||!trustedPage(event,win.webContents,base))throw Error('更新入口不可用');
    if(kind==='status')return updater.get();
    if(!['check','download','install','open-download'].includes(kind))throw Error('未知更新操作');
    return updater.action(kind);
  });return updater;
}
module.exports={allowedUrl,response,releaseInfo,checksum,download,createUpdater,installUpdater};
