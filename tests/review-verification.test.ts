import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareReviewVerification,validatePreparedReviewVerification,REVIEW_VERIFICATION_LIMITS,type PreparedReviewVerification} from '../src/core/review-verification.ts';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha=(value:string|Buffer)=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(){
  // Deliberately retained under the project, including on failed assertions. No global TEMP or real review data.
  const base=path.join(ROOT,'.test-tmp','review-verification-'+crypto.randomUUID());
  const workspace=path.join(base,"中文 项目 ' quote");fs.mkdirSync(workspace,{recursive:true});
  const jobId='AJ-'+crypto.randomUUID();
  const write=(name:string,value:string|Buffer)=>{const file=path.join(workspace,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);return {path:file,sha256:sha(value)};};
  return {base,workspace,jobId,write,prepare:(files:{path:string;sha256:string}[])=>prepareReviewVerification({workspace,jobId,files,allowedRoots:[workspace]})};
}
function run(prepared:PreparedReviewVerification,extra:string[]=[]){
  const p=spawnSync(process.execPath,[prepared.helperPath,...extra],{cwd:prepared.workspace,encoding:'utf8',timeout:45000,windowsHide:true,env:{...process.env,TEMP:prepared.workspace,TMP:prepared.workspace},maxBuffer:4*1024*1024});
  assert.equal(p.error,undefined);assert.equal(p.stderr,'');
  return {exitCode:p.status,stdout:p.stdout,result:JSON.parse(p.stdout)};
}

test('fixed ASCII command and exact Cursor permission token verify bytes, UTF-8 and BOM using standalone Node',()=>{
  const f=fixture(),plain=Buffer.from('中文\r\n'),bom=Buffer.concat([Buffer.from([239,187,191]),plain]),binary=Buffer.from([0xff,0x00,0x81]);
  const files=[f.write('说明 UTF8.txt',plain),f.write('有 BOM.txt',bom),f.write('binary.bin',binary),f.write('UTF16.txt',Buffer.from([255,254,65,0]))];
  const prepared=f.prepare(files);validatePreparedReviewVerification(prepared);
  assert.equal(prepared.command,`node .workbench-review-checks/${f.jobId}/verify.mjs`);
  assert.equal(prepared.permissionToken,`Shell(node:.workbench-review-checks/${f.jobId}/verify.mjs)`);
  assert.match(prepared.command,/^[\x20-\x7e]+$/);assert.equal(prepared.fileCount,4);
  assert.equal(sha(fs.readFileSync(prepared.helperPath)),prepared.expectedHelperSha256);assert.equal(sha(fs.readFileSync(prepared.payloadPath)),prepared.expectedPayloadSha256);
  assert.deepEqual(f.prepare(files),prepared,'same frozen job is idempotent');
  const {result,exitCode,stdout}=run(prepared);assert.equal(exitCode,0);assert.equal(result.status,'verified');assert.equal(result.verifiedCount,4);
  assert.equal(result.files[0].bytes,plain.length);assert.equal(result.files[0].sha256,sha(plain));assert.equal(result.files[0].utf8Valid,true);assert.equal(result.files[0].bom,'none');
  assert.equal(result.files[1].bom,'utf8');assert.equal(result.files[1].withoutBomSha256,sha(plain));assert.equal(result.files[1].matchesExpected,true);
  assert.equal(result.files[2].utf8Valid,false);assert.equal(result.files[2].withoutBomSha256,sha(binary));
  assert.equal(result.files[3].bom,'utf16le');assert.equal(result.files[3].withoutBomSha256,sha(Buffer.from([65,0])));
  assert(!stdout.includes('中文\\r\\n'));assert(!fs.existsSync(path.join(prepared.workspace,'node_modules')));
});

test('missing and changed files are not verified and report the current hash without exposing bytes',()=>{
  const f=fixture(),changed=f.write('changed.txt','original-content'),missing=f.write('missing.txt','missing-content');
  const prepared=f.prepare([changed,missing]);fs.writeFileSync(changed.path,'DO-NOT-PRINT-CURRENT-BYTES');fs.renameSync(missing.path,missing.path+'.retained');
  const {result,exitCode,stdout}=run(prepared);assert.equal(exitCode,1);assert.equal(result.status,'not_verified');assert.equal(result.verifiedCount,0);
  assert.equal(result.files[0].reason,'hash_mismatch');assert.equal(result.files[0].sha256,sha('DO-NOT-PRINT-CURRENT-BYTES'));assert.equal(result.files[0].matchesExpected,false);
  assert.equal(result.files[1].reason,'missing_file');assert(!stdout.includes('DO-NOT-PRINT-CURRENT-BYTES'));assert(!stdout.includes('original-content'));
});

test('real Windows PowerShell 5.1 parser only parses target scripts, reports PS7 grammar errors, and handles Unicode paths',{skip:process.platform!=='win32'},()=>{
  const f=fixture(),marker=path.join(f.workspace,'must-not-be-written.txt');
  const valid=f.write('检查 valid.ps1',Buffer.concat([Buffer.from([239,187,191]),Buffer.from(`Set-Content -LiteralPath '${marker.replaceAll("'","''")}' -Value 'must-not-execute'\nWrite-Output '中文'\n`)]));
  const invalid=f.write('PS7-only.ps1',"$value = $null ?? 'DO-NOT-PRINT-PARSER-EXCERPT'\n");
  const {result,exitCode,stdout}=run(f.prepare([valid,invalid]));assert.equal(exitCode,1);
  assert.equal(result.files[0].status,'verified');assert.deepEqual(result.files[0].powershell,{status:'parsed',version:'5.1',errorCount:0});
  assert.equal(result.files[1].reason,'powershell_parse_errors');assert.equal(result.files[1].powershell.version,'5.1');assert(result.files[1].powershell.errorCount>0);
  assert(!stdout.includes('DO-NOT-PRINT-PARSER-EXCERPT'));assert(!fs.existsSync(marker),'Parser.ParseFile must never execute its target');
});

test('extra argv is refused before reading review files',()=>{
  const f=fixture(),prepared=f.prepare([f.write('test.txt','fixture')]);
  const {result,exitCode}=run(prepared,['--arbitrary-code=not-allowed']);assert.equal(exitCode,1);assert.equal(result.reason,'unexpected_arguments');assert.deepEqual(result.files,[]);
});

test('payload tampering is rejected by the host and the standalone helper',()=>{
  const f=fixture(),prepared=f.prepare([f.write('source.ts','export const original = true;')]);
  fs.appendFileSync(prepared.payloadPath,' ');
  assert.throws(()=>validatePreparedReviewVerification(prepared),/payload_hash_mismatch/);
  const {result,exitCode}=run(prepared);assert.equal(exitCode,1);assert.equal(result.reason,'payload_hash_mismatch');assert.deepEqual(result.files,[]);
  assert.throws(()=>f.prepare([{path:path.join(f.workspace,'source.ts'),sha256:sha('export const original = true;')}]),/frozen_file_changed/);
});

test('host detects modified helper, command, token and location before granting or reusing permission',()=>{
  const f=fixture(),prepared=f.prepare([f.write('ok.txt','fixture')]);
  assert.throws(()=>validatePreparedReviewVerification({...prepared,command:prepared.command+' --extra'}),/command_changed/);
  assert.throws(()=>validatePreparedReviewVerification({...prepared,permissionToken:'Shell(node)'}),/command_changed/);
  assert.throws(()=>validatePreparedReviewVerification({...prepared,helperPath:path.join(f.workspace,'other.mjs')}),/helper_location_mismatch/);
  fs.appendFileSync(prepared.helperPath,'\n// changed synthetic fixture\n');
  assert.throws(()=>validatePreparedReviewVerification(prepared),/helper_hash_mismatch/);
});

test('prepare rejects traversal, external paths, credential stores, malformed identifiers and duplicate entries',()=>{
  const f=fixture(),good=f.write('ok.txt','fixture'),outside=path.join(f.base,'outside.txt');fs.writeFileSync(outside,'synthetic-outside');
  assert.throws(()=>f.prepare([{path:outside,sha256:sha('synthetic-outside')}]),/outside_scope/);
  assert.throws(()=>f.prepare([{path:path.join(f.workspace,'..','outside.txt'),sha256:sha('synthetic-outside')}]),/outside_scope/);
  for(const name of ['.env','.env.local','credentials.json','auth.json','keys.json','.ssh/id_ed25519','.agent-workbench/data.json','.npmrc','settings.local.json']){
    assert.throws(()=>f.prepare([{path:path.join(f.workspace,name),sha256:sha('synthetic')}]),/protected_path/,name);
  }
  assert.throws(()=>f.prepare([good,good]),/duplicate_file/);
  assert.throws(()=>f.prepare([{...good,sha256:'not-a-hash'}]),/invalid_sha256/);
  assert.throws(()=>prepareReviewVerification({workspace:f.workspace,jobId:'AJ-evil;echo',files:[good],allowedRoots:[f.workspace]}),/invalid_job_id/);
  assert.throws(()=>prepareReviewVerification({workspace:f.workspace,jobId:f.jobId,files:[good],allowedRoots:[path.join(f.base,'nonexistent')]}),/missing_path/);
  assert.throws(()=>f.prepare([]),/invalid_file_count/);
});

test('links and junctions cannot escape or substitute even another allowed file',{skip:process.platform!=='win32'},()=>{
  const f=fixture(),outside=path.join(f.base,'outside'),link=path.join(f.workspace,'linked');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'target.txt'),'synthetic');
  fs.symlinkSync(outside,link,'junction');
  assert.throws(()=>f.prepare([{path:path.join(link,'target.txt'),sha256:sha('synthetic')}]),/linked_path/);
  const target=f.write('replaceable/target.txt','synthetic');const prepared=f.prepare([target]);
  fs.renameSync(path.dirname(target.path),path.dirname(target.path)+'.retained');fs.symlinkSync(outside,path.dirname(target.path),'junction');
  const {result,exitCode}=run(prepared);assert.equal(exitCode,1);assert.equal(result.files[0].reason,'linked_path');
});

test('existing linked helper directories are rejected instead of followed',{skip:process.platform!=='win32'},()=>{
  const f=fixture(),good=f.write('file.txt','synthetic'),destination=path.join(f.base,'helper-destination');fs.mkdirSync(destination);fs.symlinkSync(destination,path.join(f.workspace,'.workbench-review-checks'),'junction');
  assert.throws(()=>f.prepare([good]),/linked_path/);assert.deepEqual(fs.readdirSync(destination),[]);
});

test('hard-linked review files are not read even when their names look authorized',()=>{
  const f=fixture(),original=f.write('original.txt','synthetic hardlink target'),alias=path.join(f.workspace,'alias.txt');fs.linkSync(original.path,alias);
  const {result,exitCode}=run(f.prepare([{path:alias,sha256:original.sha256}]));assert.equal(exitCode,1);assert.equal(result.files[0].reason,'linked_file');assert.equal(result.files[0].sha256,undefined);
});

test('count and byte limits are enforced without reading oversized content',()=>{
  const f=fixture(),large=f.write('large.bin','');fs.truncateSync(large.path,REVIEW_VERIFICATION_LIMITS.fileBytes+1);
  const {result,exitCode}=run(f.prepare([large]));assert.equal(exitCode,1);assert.equal(result.files[0].reason,'too_large');assert.equal(result.files[0].sha256,undefined);assert.equal(result.totalBytes,0);
  assert.throws(()=>prepareReviewVerification({workspace:f.workspace,jobId:'AJ-'+crypto.randomUUID(),allowedRoots:[f.workspace],files:Array.from({length:REVIEW_VERIFICATION_LIMITS.fileCount+1},(_,i)=>({path:path.join(f.workspace,`${i}.txt`),sha256:sha('x')}))}),/invalid_file_count/);
});

test('aggregate byte limit stops additional reads after the allowed total',()=>{
  const f=fixture(),zeroHash=sha(Buffer.alloc(REVIEW_VERIFICATION_LIMITS.fileBytes)),files=[];
  for(let i=0;i<REVIEW_VERIFICATION_LIMITS.totalBytes/REVIEW_VERIFICATION_LIMITS.fileBytes;i++){
    const file=f.write(`bounded-${i}.bin`,'');fs.truncateSync(file.path,REVIEW_VERIFICATION_LIMITS.fileBytes);files.push({...file,sha256:zeroHash});
  }
  files.push(f.write('would-exceed-total.txt','x'));
  const {result,exitCode}=run(f.prepare(files));assert.equal(exitCode,1);assert.equal(result.totalBytes,REVIEW_VERIFICATION_LIMITS.totalBytes);
  assert.equal(result.verifiedCount,files.length-1);assert.equal(result.files.at(-1).reason,'too_large');assert.equal(result.files.at(-1).sha256,undefined);
});
