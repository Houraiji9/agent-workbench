import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,hash,inside,now,protectedName,safePath} from './security.ts';

export const lineRangeSchema=z.object({start_line:z.number().int().min(1).max(1000000),end_line:z.number().int().min(1).max(1000000)}).strict().refine(v=>v.end_line>=v.start_line,'结束行不得小于起始行');
const contextPath=z.string().trim().min(1).max(2000).refine(v=>!/[\x00-\x1f*?]/.test(v),'需要明确的文件路径，不接受通配符');
const fileEntry=z.object({path:contextPath,range:lineRangeSchema.optional()}).strict();
export const contextContractSchema=z.object({
  memory_ids:z.array(z.string().trim().min(1).max(200)).max(32).optional(),
  required:z.array(fileEntry).max(32),
  supplemental:z.array(fileEntry.extend({reason:z.string().trim().min(2).max(1000)})).max(32).default([]),
  output_dir:contextPath,
  max_bytes:z.number().int().min(1024).max(262144).default(65536),
}).strict();
export const contextFileReadInput=fileEntry.extend({reason:z.string().trim().min(2).max(1000).optional()}).strict();
export type ContextContract=z.infer<typeof contextContractSchema>;
export type FileScope={taskId:string;root:string;roots:string[];protectedPaths:string[];writeRoots:string[];contract:ContextContract|null};
type Entry=z.infer<typeof fileEntry>&{kind:'required'|'supplemental';reason?:string};
const MAX_FILE_BYTES=4*1024*1024,MAX_FINGERPRINT_BYTES=16*1024*1024;

export function taskFileScope(wb:Workbench,t:Row,r?:Row):FileScope {
  const p=wb.get('projects',t.project_id),roots=wb.roots(p);
  return {taskId:t.id||'pending',root:r?.cwd||p.source_root||roots[0],roots,protectedPaths:[wb.config.dataDir,...(t.protected_paths||[]),...(t.protectedPaths||[])],writeRoots:t.allowed_paths||[],contract:t.context_contract?contextContractSchema.parse(t.context_contract):null};
}
function entries(scope:FileScope):Entry[]{return scope.contract?[...scope.contract.required.map(e=>({...e,kind:'required' as const})),...scope.contract.supplemental.map(e=>({...e,kind:'supplemental' as const}))]:[]}
function forbidden(scope:FileScope,file:string){return protectedName(file)||file.split(/[\\/]/).some(s=>/^data$/i.test(s))||scope.protectedPaths.some(p=>{
  const abs=path.resolve(scope.root,p);return inside(abs,file)||(fs.existsSync(abs)&&inside(fs.realpathSync.native(abs),file));
})}
function resolveEntry(scope:FileScope,input:string,allowNew=false){
  const abs=path.resolve(scope.root,input);assert(!forbidden(scope,abs),'上下文文件位于受保护路径',403);
  const real=safePath(abs,scope.roots,allowNew);assert(!forbidden(scope,real),'上下文文件实际指向受保护路径',403);
  return real;
}
function contractEntries(scope:FileScope){return entries(scope).map(e=>({...e,entry_key:fileKey(e),path:resolveEntry(scope,e.path,true)}))}
function lexicalPath(scope:FileScope,input:string){const absolute=path.resolve(scope.root,input);return process.platform==='win32'?absolute.toLowerCase():absolute}
/** A planner-approved contract revision may receive a new budget; editing file contents may not.
 * Resolve relative spelling without following mutable symlink targets or fingerprinting content.
 * The caller already isolates records by Run or RA, so only task and contract identity belong here.
 */
function contractBudgetKey(scope:FileScope){
  if(!scope.contract)return null;
  const normalize=(e:z.infer<typeof fileEntry>)=>({path:lexicalPath(scope,e.path),range:e.range||null});
  return hash(JSON.stringify({task_id:scope.taskId,root:lexicalPath(scope,'.'),contract:{required:scope.contract.required.map(normalize),supplemental:scope.contract.supplemental.map(e=>({...normalize(e),reason:e.reason})),output_dir:lexicalPath(scope,scope.contract.output_dir),max_bytes:scope.contract.max_bytes}}));
}
/** Validates only named paths; it neither enumerates directories nor reads file content. */
export function validateTaskContextContract(wb:Workbench,task:Row){
  const scope=taskFileScope(wb,task);if(!scope.contract)return;
  for(const id of scope.contract.memory_ids||[])assert(wb.maybe('memories',id)?.project_id===task.project_id,'经验不属于当前任务项目',403);
  const seen=new Set<string>();for(const e of contractEntries(scope)){
    if(fs.existsSync(e.path))assert(fs.statSync(e.path).isFile(),'上下文项必须是普通文件');
    const key=hash(JSON.stringify([process.platform==='win32'?e.path.toLowerCase():e.path,e.range||null]));assert(!seen.has(key),'上下文合同包含重复文件范围');seen.add(key);
  }
  const output=resolveEntry(scope,scope.contract.output_dir,true);
  assert(scope.writeRoots.some(p=>inside(safePath(path.resolve(scope.root,p),scope.roots,true),output)),'输出目录不在任务允许修改范围',403);
  if(fs.existsSync(output))assert(fs.statSync(output).isDirectory(),'输出目录必须是目录');
  return scope.contract;
}
function readSource(scope:FileScope,file:string,remaining=MAX_FILE_BYTES){
  const real=resolveEntry(scope,file);const before=fs.statSync(real);assert(before.isFile(),'上下文项必须是普通文件');assert(before.size<=Math.min(MAX_FILE_BYTES,remaining),'上下文文件超过指纹读取限额');
  const fd=fs.openSync(real,'r');try{
    const opened=fs.fstatSync(fd);assert(opened.dev===before.dev&&opened.ino===before.ino&&opened.size===before.size,'上下文文件正在变化，请重试',409);
    // Fixed allocation and explicit reads prevent a growing file from bypassing the ceiling.
    const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);assert(n>0,'上下文文件正在变化，请重试',409);offset+=n;}
    const after=fs.fstatSync(fd);assert(after.size===opened.size&&after.mtimeMs===opened.mtimeMs&&resolveEntry(scope,file)===real,'上下文文件正在变化，请重试',409);
    return bytes;
  }finally{fs.closeSync(fd)}
}
function select(bytes:Buffer,range?:z.infer<typeof lineRangeSchema>){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assert(!text.includes('\0'),'仅支持 UTF-8 文本上下文');
  if(!range)return text;const lines=text.split(/(?<=\n)/);assert(range.start_line<=lines.length&&range.end_line<=lines.length,'请求片段超出文件行数');return lines.slice(range.start_line-1,range.end_line).join('');
}
function fileKey(e:Entry){return hash(JSON.stringify([e.path,e.range||null,e.kind,e.reason||null]))}
/** Hashing is an I/O fact, not evidence that a model received or read these files. */
export function fileContextSnapshot(scope:FileScope){
  if(!scope.contract)return {contract:null,budget_key:null,scope_hash:hash(JSON.stringify([scope.taskId,null])),files:[],source_knowledge:'unknown',max_bytes:0,warning:'未提供结构化文件合同；没有读取源码，也不能认定执行者已读。'};
  let remaining=MAX_FINGERPRINT_BYTES;
  const files=entries(scope).map(e=>{
    const base={key:fileKey(e),...e};try{
      const real=resolveEntry(scope,e.path);const size=fs.statSync(real).size;
      if(size>Math.min(MAX_FILE_BYTES,remaining))return {...base,status:'size_limit',file_sha256:null,range_sha256:null,bytes:null};
      const bytes=readSource(scope,real,remaining);remaining-=bytes.length;const content=select(bytes,e.range);
      return {...base,status:'available',file_sha256:hash(bytes),range_sha256:hash(content),bytes:Buffer.byteLength(content)};
    }catch(error){return {...base,status:(error as {status?:number}).status===403?'protected_or_outside':'unavailable',file_sha256:null,range_sha256:null,bytes:null};}
  });
  return {contract:scope.contract,budget_key:contractBudgetKey(scope),scope_hash:hash(JSON.stringify({task_id:scope.taskId,contract:scope.contract,files})),files,source_knowledge:files.length&&files.every(f=>f.file_sha256)?'fingerprints_only':'unknown_or_incomplete',max_bytes:scope.contract.max_bytes,warning:'文件指纹只证明服务器核对了版本；提供内容或确认回执均不证明模型已理解。阅读预算只作建议，按需读取项目文件。'};
}
function containsCredential(content:string){return /(?:^|\n)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}|\b(?:sk-[a-zA-Z0-9_-]{20,}|xox[baprs]-[a-zA-Z0-9-]{20,})\b|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["'][^"'\s]{16,}["']/i.test(content)}
export function readContractFile(scope:FileScope,value:unknown,records:Row[]=[]){
  const v=contextFileReadInput.parse(value);
  const target=resolveEntry(scope,v.path);const candidates=contractEntries(scope).filter(e=>e.path===target&&(!e.range||(v.range&&v.range.start_line>=e.range.start_line&&v.range.end_line<=e.range.end_line)));
  const entry=candidates.find(e=>e.kind==='required')||candidates.find(e=>e.reason===v.reason)||candidates[0];
  const warnings:string[]=[];if(!entry)warnings.push('按需读取项目文件，未列入建议清单');else if(entry.kind==='supplemental'&&v.reason!==entry.reason)warnings.push('补读原因与规划建议不同，已记录实际原因');
  const budgetKey=contractBudgetKey(scope),delivered=records.filter(x=>(x.task_id===scope.taskId||!x.task_id)&&x.status==='delivered');
  // Legacy records lack a contract identity. Count them against the current budget regardless
  // of their old content snapshot, rather than treating an upgrade or edit as a free allowance.
  const charged=delivered.filter(x=>typeof x.budget_key!=='string'||!/^[a-f0-9]{64}$/.test(x.budget_key)||x.budget_key===budgetKey);
  const spent=charged.reduce((n,x)=>{assert(Number.isSafeInteger(x.bytes)&&x.bytes>=0,'阅读账目字节数无效，需先核对记录，不能重置额度',409);const total=n+x.bytes;assert(Number.isSafeInteger(total),'阅读账目累计字节数无效',409);return total},0);
  // This read fingerprints only the explicitly requested file. Full snapshots remain a
  // separate context operation; scope_hash=null below makes that limitation explicit.
  const bytes=readSource(scope,target),fileHash=hash(bytes);
  const prior=delivered.findLast(x=>typeof(x.resolved_path||x.path)==='string'&&lexicalPath(scope,x.resolved_path||x.path)===lexicalPath(scope,target));
  const stale={status:!prior||!prior.file_sha256?'unknown':prior.file_sha256===fileHash?'unchanged':'changed',reason:!prior?'no_previous_read_fingerprint':!prior.file_sha256?'previous_fingerprint_unavailable':prior.file_sha256===fileHash?'same_file_content':'file_content_changed',previous_file_sha256:prior?.file_sha256||null,current_file_sha256:fileHash,budget_reset:false,scope:'requested_file_only'};
  const content=select(bytes,v.range);assert(!containsCredential(content),'上下文内容含疑似凭据，拒绝提供',403);
  const size=Buffer.byteLength(content),maxBytes=scope.contract?.max_bytes??65536;if(spent+size>maxBytes)warnings.push('超过建议阅读预算，可按需继续；建议优先读取变化片段');
  const record={task_id:scope.taskId,budget_key:budgetKey,scope_hash:null,contract_entry_key:entry?.entry_key||null,resolved_path:target,path:v.path,range:v.range||null,file_sha256:fileHash,range_sha256:hash(content),bytes:size,status:'delivered',at:now(),reason:v.reason||null};
  return {content,record,stale,warnings,budget:{budget_key:budgetKey,max_bytes:maxBytes,delivered_bytes:spent+size,remaining_bytes:maxBytes-spent-size,legacy_records_charged:charged.filter(x=>!x.budget_key).length,reset_on_content_change:false},usage:{characters:content.length,bytes:size,token_count:null,token_source:'未获得模型实际用量'},condition_evidence:entry?.kind==='supplemental'?'caller_attested_condition':null,reading_claim:'已提供本次指定文件内容；未重新核对整个合同，也未确认模型是否实际读取或理解'};
}
