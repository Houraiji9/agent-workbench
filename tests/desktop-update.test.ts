import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
import {ROOT} from '../src/core/config.ts';
const require=createRequire(import.meta.url);
const {PRODUCT,MANAGED,newer,relativeFile,validateStage,checkInstallRoot}=require('../desktop/update-files.cjs');
const {allowedUrl,releaseInfo,checksum,download,createUpdater,installUpdater}=require('../desktop/updater.cjs');
const {replaceProgram}=require('../desktop/update-install.cjs');
const hash=(b:any)=>crypto.createHash('sha256').update(b).digest('hex');
const temp=()=>{const p=path.join(ROOT,'.test-tmp','updates-'+crypto.randomUUID());fs.mkdirSync(p,{recursive:true});return p};
function put(root:string,file:string,text:string){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);}
function stage(root:string,v='0.1.5') {
  const dirs=['src','dist','desktop','migrations','vendor','licenses','docs','scripts','node_modules','桌面版'];
  for(const m of MANAGED)if(m!=='update-manifest.json')put(root,dirs.includes(m)?m+'/sample.txt':m,'test program '+v);
  put(root,'package.json',JSON.stringify({version:v}));put(root,'portable-release.json',JSON.stringify({schema:1,product:PRODUCT,version:v}));
  for(const f of ['桌面版/工作台/工作台.exe','桌面版/工作台/resources/runtime/node.exe','桌面版/工作台/resources/app/main.cjs','dist/index.html'])put(root,f,'test fixture '+v);
  const files:any[]=[];
  function walk(dir:string){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else{const b=fs.readFileSync(f);files.push({path:path.relative(root,f).split(path.sep).join('/'),bytes:b.length,sha256:hash(b)});}}}
  walk(root);put(root,'update-manifest.json',JSON.stringify({schema:1,product:PRODUCT,version:v,files}));
}
function fixture() {
  const root=temp(),dataDir=path.join(root,'data'),jobDir=path.join(dataDir,'updates','test');
  stage(root,'0.1.4');
  const staged=path.join(jobDir,'extracted','AgentWorkbench');stage(staged);
  for(const f of ['data/workbench.sqlite','data/keys.json','config/local.json','.agent-workbench/tasks/keep.txt','.codex/config.toml','我的项目/原稿.txt'])put(root,f,'private original '+f);
  return {root,dataDir,stage:staged,backup:path.join(jobDir,'previous-program'),version:'0.1.5'};
}
test('版本只比较正式三段数字，不降级、不接受测试标签',()=>{
  assert(newer('0.1.10','0.1.9'));assert(!newer('0.1.4','0.1.4'));assert(!newer('0.1.3','0.1.4'));assert.throws(()=>newer('0.2.0-beta','0.1.4'));
});
test('仅官方 HTTPS 与受限 GitHub 附件跳转，拒绝私人文件和 Windows 路径别名',()=>{
  for(const u of ['http://github.com/Houraiji9/agent-workbench/releases/download/v0.1.5/a','https://evil.invalid/a','https://github.com/another/repo/releases/download/a','file:///C:/secret','https://user:pass@api.github.com/'])assert.throws(()=>allowedUrl(u));
  assert(allowedUrl('https://release-assets.githubusercontent.com/a?signature=example'));
  for(const f of ['../x','src/../x','C:/x','src/a:secret','src/a.','src/CON.txt','data/keys.json','config/local.json','.codex/config.toml','src\\x','src//x','src/a/../../data'])assert.throws(()=>relativeFile(f));
});
test('GitHub 元信息与 SHA 校验要求完整正式包',()=>{
  const base='https://github.com/'+PRODUCT+'/releases/download/v0.1.5/';
  const r={tag_name:'v0.1.5',assets:[{name:'AgentWorkbench-v0.1.5-portable.zip',size:3,browser_download_url:base+'AgentWorkbench-v0.1.5-portable.zip'},{name:'SHA256SUMS.txt',browser_download_url:base+'SHA256SUMS.txt'}]};
  assert.equal(releaseInfo(r).version,'0.1.5');assert.throws(()=>releaseInfo({...r,prerelease:true}));assert.throws(()=>releaseInfo({...r,assets:[]}));
  assert.throws(()=>checksum('no sha','a'));assert.throws(()=>checksum(`${'a'.repeat(64)}  a\n${'b'.repeat(64)}  a`,'a'));
});
test('下载检查大小与SHA，失败清除残片，可重试',async()=>{
  const file=path.join(temp(),'release.zip'),b=Buffer.from('test zip bytes');
  const r={zip:{name:'portable.zip',browser_download_url:'https://github.com/'+PRODUCT+'/releases/download/v0.1.5/portable.zip',size:b.length},sums:{browser_download_url:'https://github.com/'+PRODUCT+'/releases/download/v0.1.5/SHA256SUMS.txt'}};
  const fetcher=async(url:string)=>new Response(url.endsWith('.txt')?hash(b)+'  portable.zip':b);
  const progress:number[]=[];await download(r,file,(p:number)=>progress.push(p),fetcher);assert.equal(fs.readFileSync(file,'utf8'),b.toString());assert.equal(progress.at(-1),100);
  fs.unlinkSync(file);
  await assert.rejects(download(r,file,()=>{},async(url:string)=>new Response(url.endsWith('.txt')?'0'.repeat(64)+'  portable.zip':b)),/校验/);
  assert(!fs.existsSync(file+'.partial'));assert(!fs.existsSync(file));
  await assert.rejects(download(r,file,()=>{},async(url:string)=>new Response(url.endsWith('.txt')?hash(b)+'  portable.zip':b.subarray(1))),/校验/);
});
test('正常更新替换旧程序，保留数据库、凭据、配置、执行包和自有项目',async()=>{
  const j=fixture();await replaceProgram(j);
  assert.equal(JSON.parse(fs.readFileSync(path.join(j.root,'package.json'),'utf8')).version,'0.1.5');
  assert.equal(JSON.parse(fs.readFileSync(path.join(j.backup,'package.json'),'utf8')).version,'0.1.4');
  for(const f of ['data/workbench.sqlite','data/keys.json','config/local.json','.agent-workbench/tasks/keep.txt','.codex/config.toml','我的项目/原稿.txt'])assert.equal(fs.readFileSync(path.join(j.root,f),'utf8'),'private original '+f);
  assert(!fs.existsSync(path.join(j.root,'src/obsolete.txt')));
});
test('替换中途失败恢复已移动的目录和文件，不动数据',async()=>{
  const j=fixture();put(j.root,'src/obsolete.txt','old only');
  await assert.rejects(replaceProgram(j,{beforeMove:(item:string)=>{if(item==='vendor')throw Error('模拟文件占用')}}),/原程序已恢复/);
  assert.equal(fs.readFileSync(path.join(j.root,'src/obsolete.txt'),'utf8'),'old only');
  assert.equal(JSON.parse(fs.readFileSync(path.join(j.root,'package.json'),'utf8')).version,'0.1.4');
  assert.equal(fs.readFileSync(path.join(j.root,'data/workbench.sqlite'),'utf8'),'private original data/workbench.sqlite');
});
test('拒绝包内多余文件、被修改的文件、数据重叠与链接目录',async()=>{
  const j=fixture();await validateStage(j.stage,j.version);
  put(j.stage,'config/local.json','unexpected');await assert.rejects(validateStage(j.stage,j.version),/清单外/);fs.unlinkSync(path.join(j.stage,'config/local.json'));
  put(j.stage,'dist/index.html','tampered');await assert.rejects(validateStage(j.stage,j.version),/校验失败/);
  assert.throws(()=>checkInstallRoot(j.root,path.join(j.root,'src/data')),/重叠/);
  const outside=temp();fs.symlinkSync(outside,path.join(j.root,'src/link'),'junction');assert.throws(()=>checkInstallRoot(j.root,j.dataDir),/链接/);
});
test('开发工程可检查更新但不能安装；网络失败后可重新检查',async()=>{
  const root=temp();put(root,'package.json',JSON.stringify({version:'0.1.4'}));
  let fail=true;
  const url='https://github.com/'+PRODUCT+'/releases/download/v0.1.5/';
  const updater=createUpdater({root,dataDir:path.join(root,'data'),packaged:false,fetcher:async()=>{if(fail)throw Error('offline');return new Response(JSON.stringify({tag_name:'v0.1.5',assets:[{name:'AgentWorkbench-v0.1.5-portable.zip',size:3,browser_download_url:url+'AgentWorkbench-v0.1.5-portable.zip'},{name:'SHA256SUMS.txt',browser_download_url:url+'SHA256SUMS.txt'}]}));}});
  assert.equal((await updater.action('check')).status,'error');fail=false;assert.equal((await updater.action('check')).status,'available');assert.equal(updater.get().canInstall,false);assert.equal((await updater.action('install')).status,'error');
});
test('更新 IPC 只接受工作台主页面与固定操作，嵌入成果无法调用',async()=>{
  const root=temp();put(root,'package.json',JSON.stringify({version:'0.1.4'}));let handler:any;
  const frame={url:'http://127.0.0.1:4317/'},contents={mainFrame:frame},win={isDestroyed:()=>false,webContents:contents};
  installUpdater({win,ipcMain:{handle:(_name:string,fn:any)=>handler=fn},base:'http://127.0.0.1:4317',root,dataDir:path.join(root,'data'),packaged:false});
  assert.equal((await handler({sender:contents,senderFrame:frame},'status')).currentVersion,'0.1.4');
  for(const e of [{sender:contents,senderFrame:{url:'http://127.0.0.1:4317/'}},{sender:contents,senderFrame:{url:'http://127.0.0.1:4317/api/artifacts/example'}},{sender:{},senderFrame:frame}])await assert.rejects(handler(e,'check'),/不可用/);
  await assert.rejects(handler({sender:contents,senderFrame:frame},'https://evil.invalid/update.zip'),/未知/);
});
test('PowerShell 解包拒绝目录穿越、ADS、重复大小写和链接', {skip:process.platform!=='win32'},()=>{
  const root=temp(),script=path.join(root,'make.ps1');
  // Generate adversarial ZIPs without third-party dependencies.
  fs.writeFileSync(script,`param([string]$Out,[string]$Name,[string]$Second,[int]$Attributes=0)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$z=[IO.Compression.ZipFile]::Open($Out,'Create');try{$e=$z.CreateEntry($Name);$e.ExternalAttributes=$Attributes;if($Second){$z.CreateEntry($Second)|Out-Null}}finally{$z.Dispose()}`);
  let n=0;
  for(const [name,second,attr] of [['AgentWorkbench/../evil','','0'],['AgentWorkbench/src/a:stream','','0'],['AgentWorkbench/src/A','AgentWorkbench/src/a','0'],['AgentWorkbench/src/link','','-1577058304']]){
    const zip=path.join(root,`${n}.zip`),dest=path.join(root,'out'+n++);
    execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Out',zip,'-Name',name,...(second?['-Second',second]:[]),'-Attributes',attr],{windowsHide:true,stdio:'pipe'});
    assert.throws(()=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'desktop/update-extract.ps1'),'-Archive',zip,'-Destination',dest],{windowsHide:true,stdio:'pipe'}));assert(!fs.existsSync(dest));
  }
  const name='AgentWorkbench/src/'+'long-directory/'.repeat(18)+'fixture.txt',zip=path.join(root,'long.zip'),dest=path.join(root,'long-destination');
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Out',zip,'-Name',name],{windowsHide:true,stdio:'pipe'});
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'desktop/update-extract.ps1'),'-Archive',zip,'-Destination',dest],{windowsHide:true,stdio:'pipe'});
  assert(fs.existsSync(path.join(dest,name)),'Windows 长路径应能完整解压');
});
