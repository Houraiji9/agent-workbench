// Shared by the desktop and the detached installer; no application dependencies.
// Electron's patched fs treats *.asar as virtual folders. Update hashes cover the actual archive bytes.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PRODUCT = 'Houraiji9/agent-workbench';
const MANAGED = ['src','dist','desktop','migrations','vendor','licenses','docs','scripts','node_modules',
  'config/example.json','package.json','package-lock.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md',
  'SECURITY.md','AGENTS.md','启动工作台.ps1','停止工作台.ps1','关闭桌面工作台.ps1','桌面版',
  '连接Token Monitor.cmd','portable-release.json','update-manifest.json'];
const HASH = /^[a-f0-9]{64}$/;
function version(v) {
  if (typeof v !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v)) throw Error('版本信息无效');
  return v.split('.').map(Number);
}
function newer(a,b) { const x=version(a),y=version(b); for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];} return false; }
function inside(file,dir) { const r=path.relative(dir,file); return r==='' || (!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)); }
function plain(file) {
  let p=path.resolve(file);
  while(true) { if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('更新目录中有链接，请使用普通文件夹'); const parent=path.dirname(p);if(parent===p)break;p=parent; }
}
function tree(dir) {
  plain(dir);if(!fs.existsSync(dir))return;
  for(const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('程序目录中有链接，已停止更新');if(e.isDirectory())tree(p); }
}
function relativeFile(p) {
  if(typeof p!=='string'||p.length>400||p.includes('\\')||p.includes(':')||p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)||/[\x00-\x1f<>"|?*]/.test(s)))throw Error('更新包路径无效');
  if(!MANAGED.some(m=>p===m||p.startsWith(m+'/')))throw Error('更新包含非程序文件');
  return p;
}
async function digest(file) { const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex'); }
function writeJson(file,v) { plain(file);fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2));fs.renameSync(tmp,file); }
async function validateStage(stage,expectedVersion) {
  tree(stage);
  const manifestFile=path.join(stage,'update-manifest.json');
  if(fs.statSync(manifestFile).size>8*1024*1024)throw Error('更新清单过大');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.schema!==1||manifest.product!==PRODUCT||manifest.version!==expectedVersion||!Array.isArray(manifest.files)||manifest.files.length>60000)throw Error('更新清单不匹配');
  version(expectedVersion);const seen=new Set();
  for(const f of manifest.files) {
    relativeFile(f.path);const k=f.path.toLowerCase();if(seen.has(k)||!HASH.test(f.sha256))throw Error('更新清单存在重复或无效文件');seen.add(k);
    const file=path.join(stage,f.path),st=fs.statSync(file);if(!st.isFile()||st.size!==f.bytes||await digest(file)!==f.sha256)throw Error('更新文件校验失败：'+f.path);
  }
  function walk(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else{const r=path.relative(stage,p).split(path.sep).join('/');if(r!=='update-manifest.json'&&!seen.has(r.toLowerCase()))throw Error('更新包包含清单外文件');}} }
  walk(stage);
  for(const m of MANAGED)if(!fs.existsSync(path.join(stage,m)))throw Error('更新包缺少程序文件');
  const release=JSON.parse(fs.readFileSync(path.join(stage,'portable-release.json'),'utf8'));
  const pkg=JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8'));
  if(release.product!==PRODUCT||release.version!==expectedVersion||release.schema!==1||pkg.version!==expectedVersion)throw Error('更新版本不一致');
  for(const file of ['桌面版/工作台/工作台.exe','桌面版/工作台/resources/runtime/node.exe','桌面版/工作台/resources/app/main.cjs','dist/index.html'])if(!seen.has(file.toLowerCase()))throw Error('缺少桌面运行文件');
  return manifest;
}
function checkInstallRoot(root,dataDir) {
  plain(root);plain(dataDir);const r=JSON.parse(fs.readFileSync(path.join(root,'portable-release.json'),'utf8'));
  if(r.product!==PRODUCT||r.schema!==1)throw Error('请使用官方便携版安装更新');version(r.version);
  if(fs.existsSync(path.join(root,'.git')))throw Error('源码工程请按开发方式更新');
  for(const m of MANAGED) {const p=path.join(root,m);if(inside(dataDir,p)||inside(p,dataDir))throw Error('数据目录与程序文件重叠');plain(p);if(fs.existsSync(p)&&fs.statSync(p).isDirectory())tree(p);}
  return r;
}
module.exports={PRODUCT,MANAGED,version,newer,inside,plain,tree,relativeFile,digest,writeJson,validateStage,checkInstallRoot};
