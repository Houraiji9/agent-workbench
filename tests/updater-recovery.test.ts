import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createUpdater}=require('../desktop/updater.cjs');
const hash=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex');
const base=path.resolve('.test-tmp/updater-recovery');fs.mkdirSync(base,{recursive:true});
process.env.TEMP=base;process.env.TMP=base;
async function fixture(){
 const root=fs.mkdtempSync(path.join(base,'case-')),dataDir=path.join(root,'data');fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.1.0'}));
 const bytes=Buffer.from('synthetic local portable bytes'),name='AgentWorkbench-v0.2.0-portable.zip',prefix='https://github.com/Houraiji9/agent-workbench/releases/download/v0.2.0/';let calls=0,opens=0;
 const options={root,dataDir,packaged:false,openFolder:async()=>{opens++},fetcher:async(url:string)=>{calls++;return new Response(url.endsWith('/latest')?JSON.stringify({tag_name:'v0.2.0',body:'fixture',assets:[{name,size:bytes.length,digest:'sha256:'+hash(bytes),browser_download_url:prefix+name},{name:'SHA256SUMS.txt',browser_download_url:prefix+'SHA256SUMS.txt'}]}):url.endsWith('.txt')?hash(bytes)+'  '+name:bytes)}};
 const u=createUpdater(options);assert.equal((await u.action('check')).status,'available');assert.equal((await u.action('download')).status,'downloaded');
 const pointer=path.join(dataDir,'updates/download-recovery.json'),record=JSON.parse(fs.readFileSync(pointer,'utf8')),file=path.join(dataDir,'updates',record.job,name);
 const restart=async()=>{const next=createUpdater({...options,fetcher:async()=>{throw Error('unexpected network')}});await next.ready;return next};
 return {options,pointer,record,file,restart,calls:()=>calls,opens:()=>opens};
}
test('real updater instance restart restores verified download without network and retains previous results',async()=>{
 const f=await fixture();const result=path.join(path.dirname(f.pointer),'last-result.json');fs.writeFileSync(result,'{"status":"error","message":"old evidence"}');
 const u=await f.restart();assert.equal(u.get().status,'downloaded');assert.equal(u.get().latestVersion,'0.2.0');assert.equal((await u.action('open-download')).status,'downloaded');assert.equal(f.opens(),1);assert.equal(f.calls(),3);assert.match(fs.readFileSync(result,'utf8'),/old evidence/);assert(fs.existsSync(f.file));
});
for(const kind of ['corrupt','missing','escape','source','phase','hash','package','stage','link'])test('recovery refuses '+kind+' and retains evidence',async()=>{
 const f=await fixture();
 if(kind==='corrupt')fs.writeFileSync(f.pointer,'{');
 else if(kind==='missing')fs.renameSync(f.pointer,f.pointer+'.retained');
 else if(kind==='package')fs.appendFileSync(f.file,'modified');
 else if(kind==='link'){const dir=path.dirname(f.file),original=dir+'-retained';fs.renameSync(dir,original);fs.symlinkSync(original,dir,'junction');}
 else{if(kind==='escape')f.record.job='../escape';if(kind==='source')f.record.source='https://evil.invalid';if(kind==='phase')f.record.phase='installing';if(kind==='hash')f.record.sha256='0'.repeat(64);if(kind==='stage')f.record.stage='../stage';fs.writeFileSync(f.pointer,JSON.stringify(f.record));}
 const u=await f.restart();assert.equal(u.get().status,'error');assert.match(u.get().message,/恢复失败/);assert.equal(f.calls(),3);assert.equal(f.opens(),0);assert(fs.existsSync(f.file));
});
test('open-download revalidates bytes after successful restart',async()=>{const f=await fixture(),u=await f.restart();fs.appendFileSync(f.file,'tamper');assert.equal((await u.action('open-download')).status,'error');assert.equal(f.opens(),0)});

test('supported portable stage recovers, rejects stage corruption and reaches explicit install stop without network',{skip:process.platform!=='win32'},async()=>{
 const {crc32}=require('node:zlib');const {MANAGED,PRODUCT}=require('../desktop/update-files.cjs');
 const root=fs.mkdtempSync(path.join(base,'portable-')),dataDir=path.join(root,'data'),source=path.join(root,'fixture/AgentWorkbench');
 function put(file:string,text:string){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
 put(path.join(root,'package.json'),JSON.stringify({version:'0.1.0'}));put(path.join(root,'portable-release.json'),JSON.stringify({schema:1,product:PRODUCT,version:'0.1.0'}));
 const dirs=['src','dist','desktop','migrations','vendor','licenses','docs','scripts','node_modules','桌面版'];
 for(const m of MANAGED)if(m!=='update-manifest.json')put(path.join(source,dirs.includes(m)?m+'/sample.txt':m),'fixture');
 put(path.join(source,'package.json'),JSON.stringify({version:'0.2.0'}));put(path.join(source,'portable-release.json'),JSON.stringify({schema:1,product:PRODUCT,version:'0.2.0'}));
 for(const m of ['桌面版/工作台/工作台.exe','桌面版/工作台/resources/runtime/node.exe','桌面版/工作台/resources/app/main.cjs','dist/index.html'])put(path.join(source,m),'fixture');
 const files:any[]=[];function walk(dir:string){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else{const b=fs.readFileSync(f);files.push({path:path.relative(source,f).split(path.sep).join('/'),bytes:b.length,sha256:hash(b)})}}}walk(source);
 put(path.join(source,'update-manifest.json'),JSON.stringify({schema:1,product:PRODUCT,version:'0.2.0',files}));
 const archive=path.join(root,'fixture.zip'),local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const f of [...files,{path:'update-manifest.json'}]){
  const content=fs.readFileSync(path.join(source,f.path)),name=Buffer.from('AgentWorkbench/'+f.path),checksum=crc32(content),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(checksum,14);header.writeUInt32LE(content.length,18);header.writeUInt32LE(content.length,22);header.writeUInt16LE(name.length,26);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(checksum,16);entry.writeUInt32LE(content.length,20);entry.writeUInt32LE(content.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);local.push(header,name,content);offset+=header.length+name.length+content.length;
 }
 const directory=Buffer.concat(central),endRecord=Buffer.alloc(22);endRecord.writeUInt32LE(0x06054b50);endRecord.writeUInt16LE(files.length+1,8);endRecord.writeUInt16LE(files.length+1,10);endRecord.writeUInt32LE(directory.length,12);endRecord.writeUInt32LE(offset,16);fs.writeFileSync(archive,Buffer.concat([...local,directory,endRecord]));
 const bytes=fs.readFileSync(archive),name='AgentWorkbench-v0.2.0-portable.zip',prefix='https://github.com/'+PRODUCT+'/releases/download/v0.2.0/';let stops=0,calls=0;
 const options={root,dataDir,packaged:true,platform:'win32',arch:'x64',node:process.execPath,stop:async()=>{stops++;return false},openFolder:async()=>{},fetcher:async(url:string)=>{calls++;return new Response(url.endsWith('/latest')?JSON.stringify({tag_name:'v0.2.0',assets:[{name,size:bytes.length,digest:'sha256:'+hash(bytes),browser_download_url:prefix+name},{name:'SHA256SUMS.txt',browser_download_url:prefix+'SHA256SUMS.txt'}]}):url.endsWith('.txt')?hash(bytes)+'  '+name:bytes)}};
 const first=createUpdater(options);assert.equal(first.get().canInstall,true);await first.action('check');assert.equal((await first.action('download')).status,'downloaded');
 const pointer=path.join(dataDir,'updates/download-recovery.json'),record=JSON.parse(fs.readFileSync(pointer,'utf8'));
 const second=createUpdater({...options,fetcher:async()=>{throw Error('unexpected network')}});await second.ready;assert.equal(second.get().status,'downloaded');assert.equal((await second.action('install')).status,'error');assert.equal(stops,1);assert.equal(calls,3);
 // Restore the retained downloaded descriptor to independently exercise staged content validation.
 fs.writeFileSync(pointer,JSON.stringify(record));put(path.join(dataDir,'updates',record.job,record.stage,'dist/index.html'),'tampered');
 const third=createUpdater(options);await third.ready;assert.equal(third.get().status,'error');assert.match(third.get().message,/校验/);assert.equal(calls,3);
});
