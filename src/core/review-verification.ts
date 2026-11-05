import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** This verifier is not a general shell runner. Its exact command and two hashes belong in the review lease. */
export const REVIEW_VERIFICATION_LIMITS = Object.freeze({fileCount:512, fileBytes:32*1024*1024, totalBytes:256*1024*1024, payloadBytes:2*1024*1024});
const JOB_ID = /^AJ-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Keep the core protected names, and additionally exclude local client/session credential stores.
const PROTECTED_COMPONENT = /^(?:\.env(?:\..*)?|\.?credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|auth\.json|config\.toml|keys\.json|api[-_]keys?(?:\..*)?|vault(?:\..*)?|run-keys|review-keys|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|node_modules|\.git|\.codex|\.ssh|\.aws|\.gnupg|\.kube|\.agent-workbench|\.workbench-review-checks|\.npmrc|\.pypirc|settings\.local\.json)$/i;
export interface ReviewVerificationFile {path:string; sha256:string}
export interface PrepareReviewVerificationInput {workspace:string; jobId:string; files:ReviewVerificationFile[]; allowedRoots:string[]}
export interface PreparedReviewVerification {
  schemaVersion:1; workspace:string; jobId:string; command:string; permissionToken:string;
  helperPath:string; payloadPath:string; expectedHelperSha256:string; expectedPayloadSha256:string; fileCount:number;
}
const digest = (v:Buffer|string)=>crypto.createHash('sha256').update(v).digest('hex');
function requireCondition(ok:unknown,code:string):asserts ok {if(!ok)throw new Error(`review_verification:${code}`);}
function inside(root:string,target:string){const r=path.relative(root,target);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));}
function localAbsolute(value:string){requireCondition(typeof value==='string'&&path.isAbsolute(value)&&!/^[/\\]{2}/.test(value)&&!/[\x00-\x1f]/.test(value)&&!value.slice(2).includes(':'),'invalid_path');return path.resolve(value);}
function protectedPath(value:string){return value.split(/[\\/]/).some(part=>PROTECTED_COMPONENT.test(part));}
export const isReviewVerificationProtectedPath=protectedPath;
/** Refuse links in every existing component, including junctions, even when their destination is in range. */
function noLinks(value:string){let current=localAbsolute(value);for(;;){try{const stat=fs.lstatSync(current),real=path.resolve(fs.realpathSync.native(current));requireCondition(!stat.isSymbolicLink()&&(process.platform==='win32'?real.toLowerCase()===current.toLowerCase():real===current),'linked_path');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function canonical(value:string,allowMissing=false){const absolute=localAbsolute(value);noLinks(absolute);let ancestor=absolute;const tail:string[]=[];while(!fs.existsSync(ancestor)){requireCondition(allowMissing,'missing_path');tail.unshift(path.basename(ancestor));const parent=path.dirname(ancestor);requireCondition(parent!==ancestor,'missing_path');ancestor=parent;}return path.resolve(fs.realpathSync.native(ancestor),...tail);}
function commandFor(jobId:string){return `node .workbench-review-checks/${jobId}/verify.mjs`;}
function tokenFor(jobId:string){return `Shell(node:.workbench-review-checks/${jobId}/verify.mjs)`;}
function readSmall(file:string,max:number){
  noLinks(file);const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const before=fs.fstatSync(descriptor);requireCondition(before.isFile()&&before.nlink===1&&before.size<=max,'invalid_frozen_file');
    const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(descriptor,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}
    noLinks(file);const after=fs.fstatSync(descriptor),current=fs.statSync(file);
    requireCondition(offset===bytes.length&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&before.dev===current.dev&&before.ino===current.ino&&current.nlink===1&&before.size===current.size&&before.mtimeMs===current.mtimeMs&&before.ctimeMs===current.ctimeMs,'frozen_file_changed');
    return bytes;
  }finally{fs.closeSync(descriptor);}
}

// Fixed script. It never evaluates the payload, executes target files, or prints source/error excerpts.
// The helper authenticates its payload; its own hash MUST be checked by the host immediately before spawning.
const HELPER_SOURCE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const LIMITS = {fileCount:512,fileBytes:33554432,totalBytes:268435456,payloadBytes:2097152};
const BAD_COMPONENT = new RegExp(PROTECTED_SOURCE, 'i');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
const fail = code => {const e=new Error(code);e.safeCode=code;throw e;};
const inside = (root,target) => {const r=path.relative(root,target);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
function local(value){if(typeof value!=='string'||!path.isAbsolute(value)||/^[/\\]{2}/.test(value)||/[\x00-\x1f]/.test(value)||value.slice(2).includes(':'))fail('invalid_path');return path.resolve(value);}
function noLinks(value){let current=local(value);for(;;){try{const stat=fs.lstatSync(current),real=path.resolve(fs.realpathSync.native(current));if(stat.isSymbolicLink()||(process.platform==='win32'?real.toLowerCase()!==current.toLowerCase():real!==current))fail('linked_path');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function isProtected(value){return value.split(/[\\/]/).some(part=>BAD_COMPONENT.test(part));}
function checkedPath(value,roots){const absolute=local(value);if(isProtected(absolute))fail('protected_path');noLinks(absolute);const real=fs.realpathSync.native(absolute);if(isProtected(real)||!roots.some(root=>inside(root,real)))fail('outside_scope');return real;}
function readFile(value,roots,max){const real=checkedPath(value,roots);const descriptor=fs.openSync(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const before=fs.fstatSync(descriptor);if(!before.isFile())fail('not_regular_file');if(before.nlink!==1)fail('linked_file');if(before.size>max)fail('too_large');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const read=fs.readSync(descriptor,bytes,offset,bytes.length-offset,null);if(!read)break;offset+=read;}const after=fs.fstatSync(descriptor);if(offset!==bytes.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('changed_during_read');if(checkedPath(value,roots)!==real)fail('changed_during_read');const current=fs.statSync(real);if(current.dev!==before.dev||current.ino!==before.ino||current.nlink!==1||current.size!==before.size||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs)fail('changed_during_read');return {bytes,real};}finally{fs.closeSync(descriptor);}}
function safeCode(error){return error.safeCode||({ENOENT:'missing_file',ENOTDIR:'missing_file',EACCES:'unreadable_file',EPERM:'unreadable_file',ELOOP:'linked_path'}[error.code])||'read_failed';}
function readPayload(file){
  noLinks(file);const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const before=fs.fstatSync(descriptor);if(!before.isFile()||before.nlink!==1||before.size>LIMITS.payloadBytes)fail('invalid_payload');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const count=fs.readSync(descriptor,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}noLinks(file);const after=fs.fstatSync(descriptor),current=fs.statSync(file);if(offset!==bytes.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.dev!==current.dev||before.ino!==current.ino||current.nlink!==1||before.size!==current.size||before.mtimeMs!==current.mtimeMs||before.ctimeMs!==current.ctimeMs)fail('payload_changed');return bytes;}finally{fs.closeSync(descriptor);}
}
const PS_SCRIPT = String.raw` + '`' + String.raw`
$ErrorActionPreference = 'Stop'
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') {
    [Console]::Out.Write('{"status":"unavailable","reason":"requires_windows_powershell_5_1"}')
    exit 0
  }
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $tokens = $null
  $parseErrors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile([string]$request.path, [ref]$tokens, [ref]$parseErrors)
  $count = @($parseErrors).Count
  [Console]::Out.Write(([ordered]@{ status = 'parsed'; version = '5.1'; errorCount = $count } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write('{"status":"unavailable","reason":"parser_failed"}')
}
` + '`' + String.raw`;
function powershellParse(file){
  if(process.platform!=='win32')return {status:'unavailable',reason:'requires_windows_powershell_5_1'};
  // No PATH lookup, shell, profile, execution-policy override, or target-script execution.
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{
    noLinks(executable);
    const result=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(PS_SCRIPT,'utf16le').toString('base64')],{input:JSON.stringify({path:file}),encoding:'utf8',timeout:20000,maxBuffer:65536,windowsHide:true,stdio:['pipe','pipe','pipe']}));
    if(result.status==='parsed'&&result.version==='5.1'&&Number.isSafeInteger(result.errorCount)&&result.errorCount>=0)return {status:'parsed',version:'5.1',errorCount:result.errorCount};
    return {status:'unavailable',reason:'parser_failed'};
  }catch{return {status:'unavailable',reason:'parser_failed'};}
}
function verifyFile(file,roots,remaining){
  const result={path:file.path,expectedSha256:file.sha256,status:'not_verified'};
  try{
    const {bytes,real}=readFile(file.path,roots,Math.min(LIMITS.fileBytes,remaining));
    result.bytes=bytes.length; result.sha256=sha(bytes);result.matchesExpected=result.sha256===file.sha256;
    let bom='none',bomBytes=0;
    if(bytes.length>=4&&bytes[0]===255&&bytes[1]===254&&bytes[2]===0&&bytes[3]===0){bom='utf32le';bomBytes=4;}
    else if(bytes.length>=4&&bytes[0]===0&&bytes[1]===0&&bytes[2]===254&&bytes[3]===255){bom='utf32be';bomBytes=4;}
    else if(bytes.length>=3&&bytes[0]===239&&bytes[1]===187&&bytes[2]===191){bom='utf8';bomBytes=3;}
    else if(bytes.length>=2&&bytes[0]===255&&bytes[1]===254){bom='utf16le';bomBytes=2;}
    else if(bytes.length>=2&&bytes[0]===254&&bytes[1]===255){bom='utf16be';bomBytes=2;}
    result.bom=bom;result.withoutBomSha256=sha(bytes.subarray(bomBytes));
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);result.utf8Valid=true;}catch{result.utf8Valid=false;}
    if(!result.matchesExpected){result.reason='hash_mismatch';return result;}
    if(path.extname(real).toLowerCase()==='.ps1'){
      result.powershell=powershellParse(real);
      if(result.powershell.status!=='parsed'){result.reason='powershell_unavailable';return result;}
      // ParseFile reads the file itself: ensure it still names the same bytes after parsing.
      if(sha(readFile(file.path,roots,Math.min(LIMITS.fileBytes,remaining)).bytes)!==result.sha256){result.reason='changed_during_parse';return result;}
      if(result.powershell.errorCount){result.reason='powershell_parse_errors';return result;}
    }
    result.status='verified';return result;
  }catch(error){result.reason=safeCode(error);return result;}
}
function run(){
  if(process.argv.length!==2)fail('unexpected_arguments');
  const helper=fileURLToPath(import.meta.url),dir=path.dirname(helper),payloadFile=path.join(dir,'payload.json');
  noLinks(helper);noLinks(payloadFile);
  const payloadBytes=readPayload(payloadFile);if(sha(payloadBytes)!==EXPECTED_PAYLOAD_SHA256)fail('payload_hash_mismatch');
  const payload=JSON.parse(payloadBytes.toString('utf8'));
  if(payload.schemaVersion!==1||!/^AJ-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.jobId)||!Array.isArray(payload.files)||!payload.files.length||payload.files.length>LIMITS.fileCount||!Array.isArray(payload.allowedRoots)||!payload.allowedRoots.length||payload.allowedRoots.length>32)fail('invalid_payload');
  const workspace=local(payload.workspace);noLinks(workspace);
  if(fs.realpathSync.native(workspace)!==workspace||path.join(workspace,'.workbench-review-checks',payload.jobId,'verify.mjs')!==helper)fail('helper_location_mismatch');
  const roots=payload.allowedRoots.map(root=>{const absolute=local(root);noLinks(absolute);if(fs.realpathSync.native(absolute)!==absolute||!fs.statSync(absolute).isDirectory()||isProtected(absolute))fail('invalid_root');return absolute;});
  if(!roots.some(root=>inside(root,workspace)))fail('outside_scope');
  const seen=new Set();
  for(const file of payload.files){if(!file||typeof file.path!=='string'||!(/^[0-9a-f]{64}$/).test(file.sha256))fail('invalid_payload');const absolute=local(file.path);const key=process.platform==='win32'?absolute.toLowerCase():absolute;if(isProtected(absolute)||!roots.some(root=>inside(root,absolute))||seen.has(key))fail('invalid_payload');seen.add(key);}
  const files=[];let total=0;
  for(const file of payload.files){const result=verifyFile(file,roots,LIMITS.totalBytes-total);files.push(result);total+=result.bytes||0;}
  const verified=files.every(file=>file.status==='verified');
  output({schemaVersion:1,jobId:payload.jobId,status:verified?'verified':'not_verified',fileCount:files.length,verifiedCount:files.filter(file=>file.status==='verified').length,totalBytes:total,files});
  process.exitCode=verified?0:1;
}
try{run();}catch(error){output({schemaVersion:1,status:'not_verified',reason:safeCode(error),files:[]});process.exitCode=1;}
`;

export function prepareReviewVerification(input:PrepareReviewVerificationInput):PreparedReviewVerification {
  requireCondition(JOB_ID.test(input.jobId),'invalid_job_id');
  requireCondition(Array.isArray(input.files)&&input.files.length>0&&input.files.length<=REVIEW_VERIFICATION_LIMITS.fileCount,'invalid_file_count');
  requireCondition(Array.isArray(input.allowedRoots)&&input.allowedRoots.length>0&&input.allowedRoots.length<=32,'invalid_roots');
  const roots=[...new Set(input.allowedRoots.map(root=>{requireCondition(!protectedPath(root),'protected_path');const real=canonical(root);requireCondition(fs.statSync(real).isDirectory(),'invalid_root');return real;}))];
  const workspace=canonical(input.workspace);requireCondition(!protectedPath(workspace)&&fs.statSync(workspace).isDirectory()&&roots.some(root=>inside(root,workspace)),'invalid_workspace');
  const seen=new Set<string>();
  const files=input.files.map(file=>{requireCondition(file&&SHA256.test(file.sha256),'invalid_sha256');requireCondition(!protectedPath(file.path),'protected_path');const real=canonical(file.path,true);requireCondition(!protectedPath(real)&&roots.some(root=>inside(root,real)),'outside_scope');const key=process.platform==='win32'?real.toLowerCase():real;requireCondition(!seen.has(key),'duplicate_file');seen.add(key);return {path:real,sha256:file.sha256};});
  const directory=path.join(workspace,'.workbench-review-checks',input.jobId);
  noLinks(directory);
  const payloadPath=path.join(directory,'payload.json'),helperPath=path.join(directory,'verify.mjs');
  const payload=JSON.stringify({schemaVersion:1,workspace,jobId:input.jobId,allowedRoots:roots,files});
  requireCondition(Buffer.byteLength(payload)<=REVIEW_VERIFICATION_LIMITS.payloadBytes,'payload_too_large');
  const expectedPayloadSha256=digest(payload);
  const helper=`const EXPECTED_PAYLOAD_SHA256=${JSON.stringify(expectedPayloadSha256)};\nconst PROTECTED_SOURCE=${JSON.stringify(PROTECTED_COMPONENT.source)};\n${HELPER_SOURCE}`;
  const prepared:PreparedReviewVerification={schemaVersion:1,workspace,jobId:input.jobId,command:commandFor(input.jobId),permissionToken:tokenFor(input.jobId),helperPath,payloadPath,expectedHelperSha256:digest(helper),expectedPayloadSha256,fileCount:files.length};
  // Freeze once. A reused job can only recover identical content; never overwrite a different lease's helper.
  fs.mkdirSync(directory,{recursive:true});noLinks(directory);
  for(const [file,content] of [[payloadPath,payload],[helperPath,helper]]){
    try{fs.writeFileSync(file,content,{encoding:'utf8',flag:'wx',mode:0o600});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;requireCondition(digest(readSmall(file,REVIEW_VERIFICATION_LIMITS.payloadBytes))===digest(content),'frozen_file_changed');}
  }
  validatePreparedReviewVerification(prepared);
  return prepared;
}

/** Run at permission issuance and again immediately before spawn. The lease must retain the trusted expected hashes. */
export function validatePreparedReviewVerification(prepared:PreparedReviewVerification):void {
  requireCondition(prepared.schemaVersion===1&&JOB_ID.test(prepared.jobId)&&SHA256.test(prepared.expectedHelperSha256)&&SHA256.test(prepared.expectedPayloadSha256),'invalid_prepared');
  const workspace=canonical(prepared.workspace);
  requireCondition(!protectedPath(workspace)&&workspace===prepared.workspace,'invalid_workspace');
  requireCondition(prepared.command===commandFor(prepared.jobId)&&prepared.permissionToken===tokenFor(prepared.jobId),'command_changed');
  requireCondition(prepared.helperPath===path.join(workspace,'.workbench-review-checks',prepared.jobId,'verify.mjs')&&prepared.payloadPath===path.join(path.dirname(prepared.helperPath),'payload.json'),'helper_location_mismatch');
  requireCondition(digest(readSmall(prepared.helperPath,REVIEW_VERIFICATION_LIMITS.payloadBytes))===prepared.expectedHelperSha256,'helper_hash_mismatch');
  const payload=readSmall(prepared.payloadPath,REVIEW_VERIFICATION_LIMITS.payloadBytes);
  requireCondition(digest(payload)===prepared.expectedPayloadSha256,'payload_hash_mismatch');
  const parsed=JSON.parse(payload.toString('utf8'));
  requireCondition(parsed.schemaVersion===1&&parsed.jobId===prepared.jobId&&parsed.workspace===workspace&&Array.isArray(parsed.files)&&parsed.files.length===prepared.fileCount,'invalid_payload');
}
