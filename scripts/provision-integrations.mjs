// Reproducible vendor provisioning; does not start listeners or touch accounts.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
if(!process.argv.includes('--agentsview')){console.log('Token Monitor 本机 Hub 已随包提供，无需提取或下载。可双击根目录的连接入口。AgentsView 可选：添加 --agentsview。');process.exit(0);}
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
console.log('Verified official AgentsView 0.45.0 is ready. No listeners started.');
