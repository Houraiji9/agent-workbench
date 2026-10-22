// Reproducible vendor provisioning; does not start listeners or touch accounts.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const vendor=path.join(root,'data/integrations/token-monitor/upstream-0.70.0');
const asar=path.join(process.env.LOCALAPPDATA,'Programs/Token Monitor/resources/app.asar');
const fd=fs.openSync(asar,'r');
try{
 const h=Buffer.alloc(16);fs.readSync(fd,h,0,16,0);const headerSize=h.readUInt32LE(12);if(headerSize>32*1024*1024)throw new Error('ASAR header too large');
 const b=Buffer.alloc(headerSize);fs.readSync(fd,b,0,b.length,16);const tree=JSON.parse(b.toString('utf8'));const start=8+h.readUInt32LE(4);
 const read=e=>{if(!Number.isSafeInteger(e.size)||e.size<0||e.size>16*1024*1024)throw new Error('Unexpected vendor file size');const b=Buffer.alloc(e.size);fs.readSync(fd,b,0,b.length,start+Number(e.offset));return b};
 if(JSON.parse(read(tree.files['package.json']).toString('utf8')).version!=='0.70.0')throw new Error('Installed Token Monitor version is not the verified 0.70.0; verify its contract before changing the managed Hub.');
 const files=[];
 const walk=(nodes,prefix='')=>{for(const [name,e]of Object.entries(nodes)){const rel=prefix+name;if(e.files){if(['src','src/shared','src/hub'].includes(rel)||rel.startsWith('src/shared/')||rel.startsWith('src/hub/'))walk(e.files,rel+'/');continue}if(!(rel.startsWith('src/shared/')||rel.startsWith('src/hub/')||rel==='package.json'||/^LICENSE/i.test(rel)))continue;if(e.unpacked||e.link)throw new Error('Unexpected external vendor entry');const dest=path.resolve(vendor,rel);if(!dest.startsWith(vendor+path.sep))throw new Error('Unsafe vendor path');const bytes=read(e);fs.mkdirSync(path.dirname(dest),{recursive:true});if(fs.existsSync(dest)&&digest(fs.readFileSync(dest))!==digest(bytes))throw new Error('Vendor source mismatch: '+rel);fs.writeFileSync(dest,bytes);files.push({file:rel,sha256:digest(bytes)})}};
 walk(tree.files);fs.writeFileSync(path.join(vendor,'source-manifest.json'),JSON.stringify({version:'0.70.0',origin:'Installed official Token Monitor app.asar',files},null,2));
}finally{fs.closeSync(fd)}
const av=path.join(root,'data/integrations/agentsview'),bin=path.join(av,'bin/agentsview.exe');
const expectedExe='917672651193d86017c24e8d05de3355b313ade04b29f66d88bb38dabaecf305';
if(!fs.existsSync(bin)){
 fs.mkdirSync(av,{recursive:true});const url='https://github.com/kenn-io/agentsview/releases/download/v0.45.0/agentsview_0.45.0_windows_amd64.zip';
 const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Official download failed');const bytes=Buffer.from(await response.arrayBuffer());
 if(digest(bytes)!=='d977fa9ecae42f5594997be06d48222a5882c41ac0f19ef8a761ae7f47f3e906')throw new Error('Official archive checksum mismatch');
 const zip=path.join(av,'agentsview_0.45.0_windows_amd64.zip');fs.writeFileSync(zip,bytes);
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(path.dirname(bin))}`],{windowsHide:true,stdio:'pipe'});
}
if(digest(fs.readFileSync(bin))!==expectedExe)throw new Error('AgentsView executable checksum mismatch');
console.log('Verified official Token Monitor 0.70.0 Hub and AgentsView 0.45.0 are ready. No listeners started.');
