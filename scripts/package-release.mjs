// Build a portable Windows directory from an explicit allowlist, never from runtime data.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';import crypto from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Release version must be major.minor.patch');
const output=path.join(root,'releases','v'+version),stage=path.join(output,'windows','AgentWorkbench');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 build required');
if(fs.existsSync(stage))throw Error('Release staging already exists. Inspect and remove it before rebuilding.');
if(!fs.existsSync(path.join(root,'桌面版/工作台/工作台.exe')))throw Error('Run npm run desktop:build first');
fs.mkdirSync(stage,{recursive:true});
const entries=['src','dist','desktop','migrations','vendor','licenses','docs','scripts','config/example.json','package.json','package-lock.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md','AGENTS.md','启动工作台.ps1','停止工作台.ps1','关闭桌面工作台.ps1','桌面版','连接Token Monitor.cmd'];
function copy(from,to){const st=fs.lstatSync(from);if(st.isSymbolicLink())throw Error('No links allowed: '+from);if(st.isDirectory()){fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(from))copy(path.join(from,name),path.join(to,name));}else{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}}
for(const item of entries)copy(path.join(root,item),path.join(stage,item));
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
if(!fs.existsSync(npm))throw Error('Build using the official Node distribution with npm');
execFileSync(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit'],{cwd:stage,windowsHide:true,stdio:'inherit'});
// Runtime binary is copied by build-desktop; retain its exact upstream license.
const nodeVersion=execFileSync(path.join(stage,'桌面版/工作台/resources/runtime/node.exe'),['--version'],{encoding:'utf8',windowsHide:true}).trim();
const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);if(!license.ok)throw Error('Node license download failed');fs.writeFileSync(path.join(stage,'licenses/Node-LICENSE.txt'),await license.text());
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),files=[];
function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('Unexpected release link');if(st.isDirectory())walk(file);else files.push({path:path.relative(stage,file).split(path.sep).join('/'),bytes:st.size,sha256:hash(fs.readFileSync(file))});}}
walk(stage);fs.writeFileSync(path.join(output,'windows-manifest.json'),JSON.stringify({node:nodeVersion,files},null,2));
console.log(JSON.stringify({stage,files:files.length,bytes:files.reduce((s,f)=>s+f.bytes,0),node:nodeVersion}));
