// Maintainer-only refresh; runtime never downloads upstream code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const commit='ac4eeb2c4aea239dd94b67f074c73f69aafc46f8';
const dest=path.join(root,'vendor/token-monitor');
const files=new Map();
async function get(file){
 if(files.has(file))return;
 const response=await fetch(`https://raw.githubusercontent.com/Javis603/token-monitor/${commit}/${file}`);
 if(!response.ok)throw Error(`${file}: ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());files.set(file,bytes);
 if(file.endsWith('.js'))for(const match of bytes.toString('utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)){
  const name=match[1];if(!name.startsWith('.')){if(!name.startsWith('node:')&&name!=='dotenv')throw Error('Unexpected dependency '+name);continue;}
  let rel=path.posix.normalize(path.posix.join(path.posix.dirname(file),name));if(!path.posix.extname(rel))rel+='.js';await get(rel);
 }
}
await get('src/hub/server.js');await get('LICENSE');await get('package.json');
for(const [file,bytes]of files){fs.mkdirSync(path.dirname(path.join(dest,file)),{recursive:true});fs.writeFileSync(path.join(dest,file),bytes);}
fs.writeFileSync(path.join(dest,'source-manifest.json'),JSON.stringify({version:'0.70.0',commit,origin:'https://github.com/Javis603/token-monitor',note:'Unmodified upstream Hub dependency closure. dotenv is only used by the upstream standalone CLI; our wrapper calls createHub directly.',files:[...files].map(([file,bytes])=>({file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}))},null,2)+'\n');
console.log(`Vendored ${files.size} upstream files.`);
