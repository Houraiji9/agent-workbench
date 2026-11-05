// Build a portable Windows directory from an explicit allowlist, never from runtime data.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {PRODUCT,validateStage}=createRequire(import.meta.url)('../desktop/update-files.cjs');
const {copyReleaseEntries,quarantineExcludedReleaseEntries,assertReleaseTreeClean}=createRequire(import.meta.url)('./release-files.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Release version must be major.minor.patch');
const label=process.argv[2]||'';
if(label&&!/^[a-z0-9-]{1,40}$/.test(label))throw Error('Invalid candidate label');
const output=path.join(root,'releases','v'+version+(label?'-'+label:'')),stage=path.join(output,'windows','AgentWorkbench');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 build required');
if(fs.existsSync(stage))throw Error('Release staging already exists. Inspect and remove it before rebuilding.');
if(!fs.existsSync(path.join(root,'桌面版/工作台/工作台.exe')))throw Error('Run npm run desktop:build first');
fs.mkdirSync(stage,{recursive:true});
const sourceCopy=copyReleaseEntries(root,stage);
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
if(!fs.existsSync(npm))throw Error('Build using the official Node distribution with npm');
// Build dependencies must not write to another app's/user-wide npm cache.
const npmCache=path.join(root,'.tmp','npm-release-cache');fs.mkdirSync(npmCache,{recursive:true});
execFileSync(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit'],{cwd:stage,env:{...process.env,npm_config_cache:npmCache},windowsHide:true,stdio:'inherit'});
// Runtime binary is copied by build-desktop; retain its exact upstream license.
const nodeVersion=execFileSync(path.join(stage,'桌面版/工作台/resources/runtime/node.exe'),['--version'],{encoding:'utf8',windowsHide:true}).trim();
const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);if(!license.ok)throw Error('Node license download failed');fs.writeFileSync(path.join(stage,'licenses/Node-LICENSE.txt'),await license.text());
fs.writeFileSync(path.join(stage,'portable-release.json'),JSON.stringify({schema:1,product:PRODUCT,version},null,2));
const generatedExclusions=quarantineExcludedReleaseEntries(stage,path.join(root,'.tmp','release-excluded',`${version}${label?'-'+label:''}-${crypto.randomUUID()}`));
assertReleaseTreeClean(stage);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),files=[];
function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('Unexpected release link');if(st.isDirectory())walk(file);else files.push({path:path.relative(stage,file).split(path.sep).join('/'),bytes:st.size,sha256:hash(fs.readFileSync(file))});}}
walk(stage);fs.writeFileSync(path.join(output,'windows-manifest.json'),JSON.stringify({node:nodeVersion,files},null,2));
fs.writeFileSync(path.join(stage,'update-manifest.json'),JSON.stringify({schema:1,product:PRODUCT,version,files},null,2));
await validateStage(stage,version);
console.log(JSON.stringify({stage,files:files.length,bytes:files.reduce((s,f)=>s+f.bytes,0),node:nodeVersion,excluded_source_entries:sourceCopy.excluded.length,excluded_generated_entries:generatedExclusions.length}));
